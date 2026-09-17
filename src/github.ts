import { runCommand } from "./process";

export interface PRStatus {
  number: number;
  url: string;
  lifecycle: "open" | "draft" | "merged" | "closed";
  checks: { passed: number; failed: number; pending: number; total: number } | null;
  review: "approved" | "changes_requested" | "required" | null;
  threads: number | null;
}

export type Runner = (argv: string[], cwd?: string) => Promise<string>;

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Unexpected GitHub response");
  }
  return value as ObjectValue;
}

function repository(url: string): { host: string; name: string } {
  // Git's usual HTTPS, ssh:// and scp-style remote URLs. Never guess a repo
  // from a local path or an unrecognised remote.
  const normalized = url.replace(/^([^/@]+@)?([^/:]+):([^/].*)$/, "ssh://$2/$3");
  const parsed = new URL(normalized);
  if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error("Cannot identify GitHub remote repository");
  }
  const name = parsed.pathname.replace(/^\//, "").replace(/\/?$/, "").replace(/\.git$/, "");
  if (!/^[^/]+\/[^/]+$/.test(name)) throw new Error("Cannot identify GitHub remote repository");
  return { host: parsed.hostname.toLowerCase(), name: name.toLowerCase() };
}

function checks(value: unknown): PRStatus["checks"] {
  if (value == null) return null;
  if (!Array.isArray(value)) throw new Error("Unexpected check rollup");
  const result = { passed: 0, failed: 0, pending: 0, total: value.length };
  for (const item of value) {
    const check = object(item);
    const state = check.state;
    if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(String(state))) result.passed++;
    else if (["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"].includes(String(state))) result.failed++;
    else if (["PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"].includes(String(state))) result.pending++;
    else return null; // New/unknown GitHub states are not successful checks.
  }
  return result;
}

const threadQuery = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes { isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

async function unresolvedThreads(run: Runner, cwd: string, repoURL: string, number: number): Promise<number | null> {
  const repo = repository(repoURL);
  const [owner, name] = repo.name.split("/");
  let cursor: string | undefined;
  let total = 0;
  const seen = new Set<string>();
  do {
    const args = ["gh", "api", "graphql", "--hostname", repo.host, "-f", `query=${threadQuery}`,
      "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const response = object(JSON.parse(await run(args, cwd)));
    if (response.errors != null) throw new Error("GitHub review thread query failed");
    if (response.data == null) return null;
    const repositoryData = object(response.data).repository;
    if (repositoryData == null) return null;
    const pr = object(repositoryData).pullRequest;
    if (pr == null) return null;
    const threads = object(pr).reviewThreads;
    if (threads == null) return null;
    const connection = object(threads);
    if (!Array.isArray(connection.nodes)) return null;
    for (const node of connection.nodes) {
      if (node == null || typeof object(node).isResolved !== "boolean") return null;
      if (!object(node).isResolved) total++;
    }
    const page = object(connection.pageInfo);
    if (page.hasNextPage === false) return total;
    if (page.hasNextPage !== true || typeof page.endCursor !== "string" || !page.endCursor || seen.has(page.endCursor)) {
      throw new Error("Invalid review thread pagination");
    }
    cursor = page.endCursor;
    seen.add(cursor);
  } while (cursor);
  return total;
}

/** Read-only lookup. null means detached HEAD or a confirmed absent PR; failures throw. */
export async function lookupPR(cwd: string, run: Runner = runCommand): Promise<PRStatus | null> {
  const branch = (await run(["git", "branch", "--show-current"], cwd)).trim();
  if (!branch) return null;
  const tracking = (await run(["git", "for-each-ref",
    "--format=%(push:remotename)%09%(push:remoteref)%09%(upstream:remotename)%09%(upstream:remoteref)",
    `refs/heads/${branch}`], cwd)).trimEnd().split("\t");
  const remote = tracking[0] || tracking[2] || "origin";
  let remoteRef = tracking[0] ? tracking[1] : tracking[3];
  if (tracking[0] && !remoteRef) {
    // Git can report a push remote without a push ref (notably upstream mode).
    // Ref mappings Git could not resolve are outside this POC: never guess.
    const refspec = (await run(["git", "config", "--get", "--default", "", `remote.${remote}.push`], cwd)).trim();
    const mode = (await run(["git", "config", "--get", "--default", "simple", "push.default"], cwd)).trim();
    if (refspec) throw new Error("Cannot resolve configured push refspec");
    const triangular = Boolean(tracking[2]) && remote !== tracking[2];
    if (mode === "upstream" && !triangular && tracking[3]?.startsWith("refs/heads/")) {
      remoteRef = tracking[3];
    } else if (mode === "current" || (mode === "simple" &&
        (triangular || !tracking[2] || tracking[3] === `refs/heads/${branch}`))) {
      remoteRef = `refs/heads/${branch}`;
    } else {
      throw new Error("Cannot resolve unambiguous push branch");
    }
  }
  if (remote === ".") throw new Error("Branch tracks a local repository, not GitHub");
  const head = remoteRef?.startsWith("refs/heads/") ? remoteRef.slice(11) : branch;
  const remoteURL = (await run(["git", "remote", "get-url", ...(tracking[0] ? ["--push"] : []), remote], cwd)).trim();
  const headRepo = repository(remoteURL);
  // Resolve the selected remote explicitly; gh's checkout default may be unrelated.
  const repo = object(JSON.parse(await run(["gh", "repo", "view", `${headRepo.host}/${headRepo.name}`,
    "--json", "nameWithOwner,url,parent"], cwd)));
  if (typeof repo.url !== "string" || typeof repo.nameWithOwner !== "string") throw new Error("Missing GitHub repository identity");
  const resolvedRepo = repository(repo.url);
  if (resolvedRepo.host !== headRepo.host || resolvedRepo.name !== headRepo.name) {
    throw new Error("GitHub remote repository identity mismatch");
  }
  let baseURL = repo.url;
  if (repo.parent != null) {
    const parent = object(repo.parent);
    const owner = object(parent.owner).login;
    if (typeof owner !== "string" || !owner || typeof parent.name !== "string" || !parent.name
        || owner.includes("/") || parent.name.includes("/")) throw new Error("Missing GitHub parent repository identity");
    baseURL = `https://${headRepo.host}/${owner}/${parent.name}`;
  }
  const fields = "number,url,state,isDraft,headRefName,headRepository,headRepositoryOwner,updatedAt,statusCheckRollup,reviewDecision";
  const matches = new Map<string, ObjectValue>();
  // A fork can have PRs targeting itself as well as its parent. Query both:
  // an empty parent alone does not prove that this branch has no PR.
  for (const target of new Set([baseURL, repo.url])) {
    const raw: unknown = JSON.parse(await run(["gh", "pr", "list", "--repo", target, "--state", "all",
      "--head", head, "--limit", "100", "--json", fields], cwd));
    if (!Array.isArray(raw)) throw new Error("Unexpected pull request list");
    if (raw.length >= 100) throw new Error("PR lookup exceeded the 100-result POC limit");
    for (const value of raw) {
      const pr = object(value);
      if (pr.headRefName !== head) continue;
      if (pr.headRepository == null) throw new Error("Cannot verify PR head repository");
      const name = object(pr.headRepository).name;
      const owner = object(pr.headRepositoryOwner).login;
      if (typeof name !== "string" || !name || typeof owner !== "string" || !owner) {
        throw new Error("Missing PR head repository identity");
      }
      if (`${owner}/${name}`.toLowerCase() !== headRepo.name) continue;
      if (typeof pr.url !== "string" || !pr.url) throw new Error("Missing PR URL");
      if (!matches.has(pr.url)) matches.set(pr.url, { ...pr, lookupBaseURL: target });
    }
  }
  const candidates = [...matches.values()];
  const open = candidates.filter(pr => pr.state === "OPEN");
  if (open.length > 1) throw new Error("Multiple open PRs match this branch");
  const pr = open[0] ?? candidates.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  if (!pr) return null;
  if (!Number.isInteger(pr.number) || typeof pr.number !== "number" || pr.number <= 0 || typeof pr.url !== "string"
      || !["OPEN", "MERGED", "CLOSED"].includes(String(pr.state)) || typeof pr.isDraft !== "boolean") {
    throw new Error("Invalid pull request details");
  }
  const lifecycle = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.isDraft ? "draft" : "open";
  const result: PRStatus = { number: pr.number, url: pr.url, lifecycle, checks: null, review: null, threads: null };
  // pr list exposes raw historical runs, including superseded cancellations.
  // gh pr checks paginates contexts and selects the newest run per check name,
  // workflow and event. JSON mode exits successfully even for failed checks.
  if (pr.statusCheckRollup != null) {
    if (!Array.isArray(pr.statusCheckRollup)) throw new Error("Unexpected check rollup");
    result.checks = pr.statusCheckRollup.length === 0 ? checks([]) : checks(JSON.parse(await run([
      "gh", "pr", "checks", String(pr.number), "--repo", String(pr.lookupBaseURL), "--json", "state",
    ], cwd)));
  }
  result.review = pr.reviewDecision === "APPROVED" ? "approved"
    : pr.reviewDecision === "CHANGES_REQUESTED" ? "changes_requested"
    : pr.reviewDecision === "REVIEW_REQUIRED" ? "required" : null;
  result.threads = await unresolvedThreads(run, cwd, String(pr.lookupBaseURL), pr.number);
  return result;
}
