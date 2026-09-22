import { runCommand } from "./process";
import { failure, LookupError } from "./feedback";

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
  // Reject syntax URL normalization would silently discard or reinterpret.
  // Encoded HTTP credentials do not participate in repository identity.
  const identityURL = url.replace(/^(https?:\/\/)[^/?#]*@/i, "$1");
  if (/[\\?#\s]/.test(url) || identityURL.includes("%") || /(?:^|[/:])\.{1,2}(?:\/|$)/.test(url)) {
    throw new Error("Cannot identify GitHub remote repository");
  }
  const normalized = url.includes("://") ? url
    : url.replace(/^([^/@]+@)?([^/:]+):([^/].*)$/, "ssh://$2/$3");
  const parsed = new URL(normalized);
  if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol) || !parsed.hostname
      || (["https:", "http:"].includes(parsed.protocol) && parsed.port)) {
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

/** Resolved local branch and push repository; no network requests. */
export interface LookupContext { branch: string; head: string; headRepo: { host: string; name: string } }

export async function resolveContext(cwd: string, run: Runner = runCommand): Promise<LookupContext> {
  try { return await gitContext(cwd, run); }
  catch (error) { throw failure(error, 'unresolved'); }
}

async function gitContext(cwd: string, run: Runner): Promise<LookupContext> {
  const branch = (await run(["git", "branch", "--show-current"], cwd)).trim();
  if (!branch) throw new LookupError("unresolved", "No named Git branch (detached HEAD)", "No named Git branch (detached HEAD)");
  const tracking = (await run(["git", "for-each-ref",
    "--format=%(push:remotename)%09%(push:remoteref)%09%(upstream:remotename)%09%(upstream:remoteref)",
    `refs/heads/${branch}`], cwd)).trimEnd().split("\t");
  // Read effective config (including includes/worktree config) without executing
  // transports. Preserve repeated push refspecs instead of silently taking one.
  const config = new Map<string, string[]>();
  for (const entry of (await run(["git", "config", "--null", "--list"], cwd)).split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("\n");
    const key = separator < 0 ? entry : entry.slice(0, separator);
    const value = separator < 0 ? "true" : entry.slice(separator + 1);
    config.set(key, [...(config.get(key) ?? []), value]);
  }
  const get = (key: string) => config.get(key)?.at(-1);
  let remote = get(`branch.${branch}.pushremote`) ?? get("remote.pushdefault")
    ?? get(`branch.${branch}.remote`);
  if (remote === undefined) {
    const remotes = (await run(["git", "remote"], cwd)).trim().split("\n").filter(Boolean);
    remote = remotes.includes("origin") ? "origin" : remotes.length === 1 ? remotes[0] : undefined;
  }
  if (!remote) throw new LookupError("unresolved", "Cannot resolve unambiguous push remote", "Cannot resolve unambiguous push remote");
  if (remote === ".") throw new LookupError("unresolved", "Branch tracks a local repository, not GitHub", "Branch tracks a local repository, not GitHub");
  const mirror = get(`remote.${remote}.mirror`);
  if (mirror !== undefined && (await run(["git", "config", "--type=bool", "--get",
    `remote.${remote}.mirror`], cwd)).trim() !== "false") {
    throw new LookupError("unresolved", "Cannot resolve mirror push destination", "Cannot resolve mirror push destination");
  }
  const refspecs = config.get(`remote.${remote}.push`) ?? [];
  let remoteRef: string | undefined;
  if (refspecs.length) {
    // Git resolves supported mappings. Multiple mappings can push this branch
    // to more than one head; even a plausible atom is not sufficient evidence.
    if (refspecs.length !== 1 || tracking[0] !== remote || !tracking[1]?.startsWith("refs/heads/")) {
      throw new LookupError("unresolved", "Cannot resolve configured push refspec", "Cannot resolve configured push refspec");
    }
    remoteRef = tracking[1];
  } else {
    const mode = get("push.default") ?? "simple";
    const upstreamRemote = get(`branch.${branch}.remote`);
    const upstreamRefs = config.get(`branch.${branch}.merge`) ?? [];
    const upstreamRef = upstreamRefs.length === 1 ? upstreamRefs[0] : undefined;
    const triangular = remote !== (upstreamRemote ?? "origin");
    if (mode === "upstream" && !triangular && upstreamRef?.startsWith("refs/heads/")) {
      remoteRef = upstreamRef;
    } else if (mode === "current" || (mode === "simple" &&
        (triangular || upstreamRefs.length === 0 || upstreamRef === `refs/heads/${branch}`))) {
      remoteRef = `refs/heads/${branch}`;
    } else {
      throw new LookupError("unresolved", "Cannot resolve unambiguous push branch", "Cannot resolve unambiguous push branch");
    }
  }
  const head = remoteRef.slice(11);
  // get-url expands insteadOf/pushInsteadOf and exposes every push destination.
  const urls = (await run(["git", "remote", "get-url", "--push", "--all", remote], cwd)).trim().split("\n");
  if (urls.length !== 1 || !urls[0]) throw new LookupError("unresolved", "Cannot resolve unambiguous push URL", "Cannot resolve unambiguous push URL");
  const remoteURL = urls[0];
  const headRepo = repository(remoteURL);
  return { branch, head, headRepo };
}

export async function lookupPR(cwd: string, run: Runner = runCommand, context?: LookupContext): Promise<PRStatus | null> {
  const resolved = context ?? await resolveContext(cwd, run);
  try { return await queryPR(cwd, run, resolved); }
  catch (error) { throw failure(error); }
}

async function queryPR(cwd: string, run: Runner, { head, headRepo }: LookupContext): Promise<PRStatus | null> {
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
