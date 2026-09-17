import { describe, expect, test } from "bun:test";
import { lookupPR, type Runner } from "../src/github";
import { formatPR } from "../src/format";

const cwd = "/checkout with spaces";
const pr = (overrides: Record<string, unknown> = {}) => ({
  number: 42, url: `https://github.com/base/project/pull/${overrides.number ?? 42}`, state: "OPEN", isDraft: false,
  headRefName: "remote-feature", headRepository: { name: "project", nameWithOwner: "" },
  headRepositoryOwner: { login: "alice" }, updatedAt: "2026-01-01T00:00:00Z",
  statusCheckRollup: [], reviewDecision: "", ...overrides,
});
const page = (resolved: boolean[], hasNextPage = false, endCursor: string | null = null) => ({
  data: { repository: { pullRequest: { reviewThreads: {
    nodes: resolved.map(isResolved => ({ isResolved })), pageInfo: { hasNextPage, endCursor },
  } } } },
});
function fixture(options: {
  branch?: string; tracking?: string; remote?: string; prs?: unknown;
  pages?: unknown[]; currentChecks?: unknown; localPRs?: unknown; repo?: unknown; fetchRemote?: string; fail?: "list" | "checks" | "threads" | "git" | "repo";
} = {}) {
  const calls: string[][] = [];
  let pageIndex = 0;
  const run: Runner = async (args, actualCwd) => {
    expect(actualCwd).toBe(cwd);
    calls.push(args);
    const command = args.slice(0, 3).join(" ");
    if (options.fail === "git" && args[0] === "git") throw new Error("git failure");
    if (command === "git branch --show-current") return options.branch ?? "local-feature\n";
    if (args[1] === "for-each-ref") return options.tracking ?? "fork\trefs/heads/remote-feature\torigin\trefs/heads/wrong\n";
    if (command === "git remote get-url") {
      if (!args.includes("--push") && options.fetchRemote) return options.fetchRemote;
      return options.remote ?? "git@github.com:Alice/Project.git\n";
    }
    if (command === "gh repo view") {
      if (options.fail === "repo") throw new Error("repo failure");
      return JSON.stringify(options.repo ?? { nameWithOwner: "alice/project", url: "https://github.com/alice/project",
        parent: { name: "project", owner: { login: "base" } } });
    }
    if (command === "gh pr list") {
      if (options.fail === "list") throw new Error("request failure");
      return JSON.stringify(args[args.indexOf("--repo") + 1] === "https://github.com/alice/project" && options.localPRs !== undefined ? options.localPRs : options.prs ?? [pr()]);
    }
    if (command === "gh pr checks") {
      if (options.fail === "checks") throw new Error("checks failure");
      // Existing state-normalization fixtures model the current check set.
      const selected = (options.prs as ReturnType<typeof pr>[] | undefined)?.find(p => String(p.number) === args[3]);
      const raw = selected?.statusCheckRollup ?? [];
      return JSON.stringify(options.currentChecks ?? (raw as Record<string, unknown>[]).map(c => ({
        state: c.__typename === "StatusContext" ? c.state : c.status === "COMPLETED" ? c.conclusion : c.status,
      })));
    }
    if (command === "gh api graphql") {
      if (options.fail === "threads") throw new Error("threads failure");
      const next = (options.pages ?? [page([])])[pageIndex++];
      if (next === undefined) throw new Error("Unexpected extra page");
      return JSON.stringify(next);
    }
    throw new Error(`Unexpected command: ${args.join(" ")}`);
  };
  return { run, calls };
}

describe("branch PR identity", () => {
  test("uses push URL rather than fetch URL and explicitly resolves the fork parent", async () => {
    const { run, calls } = fixture({ fetchRemote: "git@github.com:base/project.git" });
    expect((await lookupPR(cwd, run))?.number).toBe(42);
    expect(calls).toContainEqual(["gh", "repo", "view", "github.com/alice/project", "--json", "nameWithOwner,url,parent"]);
  });
  test("non-fork repository is its own base", async () => {
    const { run, calls } = fixture({ repo: { nameWithOwner: "alice/project", url: "https://github.com/alice/project", parent: null } });
    expect((await lookupPR(cwd, run))?.number).toBe(42);
    const list = calls.find(args => args[1] === "pr")!;
    expect(list[list.indexOf("--repo") + 1]).toBe("https://github.com/alice/project");
    expect(calls.find(args => args[1] === "api")).toContain("owner=alice");
  });
  test("unrelated repository resolution cannot produce false absence", async () => {
    await expect(lookupPR(cwd, fixture({ repo: { nameWithOwner: "other/project", url: "https://github.com/other/project" }, prs: [] }).run))
      .rejects.toThrow("identity mismatch");
  });
  test("head identity does not depend on nameWithOwner being populated", async () => {
    expect((await lookupPR(cwd, fixture({ prs: [pr({ headRepository: { name: "project" } })] }).run))?.number).toBe(42);
    await expect(lookupPR(cwd, fixture({ prs: [pr({ headRepositoryOwner: { login: "" } })] }).run)).rejects.toThrow("identity");
  });
  test("uses push remote and remote branch, rejecting same-named branch on another fork", async () => {
    const { run, calls } = fixture({ prs: [pr({ number: 99, headRepositoryOwner: { login: "bob" } }), pr()] });
    expect((await lookupPR(cwd, run))?.number).toBe(42);
    expect(calls).toContainEqual(["git", "remote", "get-url", "--push", "fork"]);
    const list = calls.find(args => args[1] === "pr")!;
    expect(list[list.indexOf("--head") + 1]).toBe("remote-feature");
    expect(list[list.indexOf("--repo") + 1]).toBe("https://github.com/base/project");
  });
  test("falls back to upstream remote branch", async () => {
    const { run, calls } = fixture({ tracking: "\t\tupstream\trefs/heads/remote-feature\n" });
    expect(await lookupPR(cwd, run)).not.toBeNull();
    expect(calls).toContainEqual(["git", "remote", "get-url", "upstream"]);
  });
  test("uses origin and local branch without tracking", async () => {
    const { run, calls } = fixture({ tracking: "\t\t\t\n", prs: [pr({ headRefName: "local-feature" })] });
    expect(await lookupPR(cwd, run)).not.toBeNull();
    expect(calls).toContainEqual(["git", "remote", "get-url", "origin"]);
  });
  for (const remote of ["https://github.com/ALICE/project.git/", "ssh://git@github.com/Alice/project.git"]) {
    test(`accepts ${remote}`, async () => {
      expect((await lookupPR(cwd, fixture({ remote }).run))?.number).toBe(42);
    });
  }
  for (const remote of ["/tmp/repo", "file:///tmp/repo", "file://github.com/alice/project", "git@elsewhere.example:alice/project.git"]) {
    test(`rejects invalid or mismatched remote ${remote}`, async () => {
      await expect(lookupPR(cwd, fixture({ remote }).run)).rejects.toThrow();
    });
  }
  test("rejects local tracking and unverifiable heads", async () => {
    await expect(lookupPR(cwd, fixture({ tracking: ".\trefs/heads/remote-feature" }).run)).rejects.toThrow("local repository");
    await expect(lookupPR(cwd, fixture({ prs: [pr({ headRepository: null })] }).run)).rejects.toThrow("verify");
  });
});

describe("absence and failures", () => {
  test("detached HEAD stops before network requests", async () => {
    const { run, calls } = fixture({ branch: "\n" });
    expect(await lookupPR(cwd, run)).toBeNull();
    expect(calls).toHaveLength(1);
  });
  test("successful empty or nonmatching list is confirmed absence", async () => {
    for (const prs of [[], [pr({ headRefName: "other" })], [pr({ headRepositoryOwner: { login: "bob" } })]]) {
      const { run, calls } = fixture({ prs });
      expect(await lookupPR(cwd, run)).toBeNull();
      expect(calls.some(args => args[1] === "api")).toBe(false);
    }
  });
  for (const fail of ["git", "repo", "list", "threads"] as const) {
    test(`${fail} failure is never absence`, async () => {
      await expect(lookupPR(cwd, fixture({ fail }).run)).rejects.toThrow("failure");
    });
  }
  test("malformed or truncated list and ambiguous open PRs fail", async () => {
    for (const prs of [{}, Array.from({ length: 100 }, () => pr()), [pr(), pr({ number: 43 })]]) {
      await expect(lookupPR(cwd, fixture({ prs }).run)).rejects.toThrow();
    }
  });
});

describe("independent PR state", () => {
  for (const [state, isDraft, lifecycle] of [["OPEN", false, "open"], ["OPEN", true, "draft"], ["MERGED", true, "merged"], ["CLOSED", true, "closed"]] as const) {
    test(`${lifecycle} retains checks, review and threads`, async () => {
      const { run } = fixture({ prs: [pr({ state, isDraft, reviewDecision: "APPROVED" })], pages: [page([false])] });
      expect(await lookupPR(cwd, run)).toEqual({ number: 42, url: pr().url, lifecycle,
        checks: { passed: 0, failed: 0, pending: 0, total: 0 }, review: "approved", threads: 1 });
    });
  }
  test("open PR wins over newer terminal; otherwise latest terminal wins", async () => {
    const terminal = pr({ state: "MERGED", number: 43, updatedAt: "2026-02-01T00:00:00Z" });
    expect((await lookupPR(cwd, fixture({ prs: [terminal, pr()] }).run))?.number).toBe(42);
    expect((await lookupPR(cwd, fixture({ prs: [pr({ state: "CLOSED" }), terminal] }).run))?.number).toBe(43);
  });
  for (const [reviewDecision, expected] of [["APPROVED", "approved"], ["CHANGES_REQUESTED", "changes_requested"], ["REVIEW_REQUIRED", "required"], ["", null], ["FUTURE", null]] as const) {
    test(`review ${reviewDecision || "empty"}`, async () => {
      expect((await lookupPR(cwd, fixture({ prs: [pr({ reviewDecision })] }).run))?.review).toBe(expected);
    });
  }
  test("normalizes check runs and legacy status contexts", async () => {
    const passed = ["SUCCESS", "NEUTRAL", "SKIPPED"];
    const failed = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"];
    const pending = ["QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED", "PENDING", "EXPECTED"];
    const statusCheckRollup = [
      ...[...passed, ...failed].map(conclusion => ({ __typename: "CheckRun", status: "COMPLETED", conclusion })),
      ...pending.map(status => ({ __typename: "CheckRun", status })),
      ...["SUCCESS", "FAILURE", "ERROR", "PENDING", "EXPECTED"].map(state => ({ __typename: "StatusContext", state })),
    ];
    expect((await lookupPR(cwd, fixture({ prs: [pr({ statusCheckRollup })] }).run))?.checks)
      .toEqual({ passed: 4, failed: 9, pending: 8, total: 21 });
  });
  test("unknown checks differ from known zero and do not erase other dimensions", async () => {
    for (const statusCheckRollup of [null, [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "FUTURE" }]]) {
      const result = await lookupPR(cwd, fixture({ prs: [pr({ statusCheckRollup, reviewDecision: "APPROVED" })] }).run);
      expect(result?.checks).toBeNull();
      expect(result?.review).toBe("approved");
      expect(result?.threads).toBe(0);
    }
  });
});

for (const count of [99, 100, 101]) {
  test(`current checks of ${count} are complete beyond the raw rollup cap`, async () => {
    const statusCheckRollup = Array.from({ length: count }, () => ({ __typename: "StatusContext", state: "SUCCESS" }));
    const result = await lookupPR(cwd, fixture({
      prs: [pr({ statusCheckRollup, reviewDecision: "APPROVED" })], pages: [page([false])],
    }).run);
    expect(result?.checks).toEqual({ passed: count, failed: 0, pending: 0, total: count });
    expect(result?.lifecycle).toBe("open");
    expect(result?.review).toBe("approved");
    expect(result?.threads).toBe(1);
    expect(formatPR(result).pr_checks).toContain(`${count}/${count}`);
  });
}

describe("review threads", () => {
  test("counts unresolved threads across every page using base repository", async () => {
    const { run, calls } = fixture({ pages: [page([false, true], true, "next"), page([false, false, true])] });
    expect((await lookupPR(cwd, run))?.threads).toBe(3);
    const queries = calls.filter(args => args[1] === "api");
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("owner=base");
    expect(queries[0]).toContain("name=project");
    expect(queries[0]).toContain("number=42");
    expect(queries[1]).toContain("cursor=next");
  });
  test("unknown thread data is not zero", async () => {
    expect((await lookupPR(cwd, fixture({ pages: [{ data: { repository: null } }] }).run))?.threads).toBeNull();
    expect((await lookupPR(cwd, fixture({ pages: [page([true])] }).run))?.threads).toBe(0);
  });
  test("GraphQL errors and broken pagination fail rather than returning partial counts", async () => {
    for (const pages of [
      [{ ...page([]), errors: [{ message: "permission denied" }] }],
      [page([false], true, null)],
      [page([false], true, "same"), page([false], true, "same")],
    ]) await expect(lookupPR(cwd, fixture({ pages }).run)).rejects.toThrow();
  });
});


test("fork-local PR is found when the parent has no matches", async () => {
  const { run, calls } = fixture({ prs: [], localPRs: [pr({ url: "https://github.com/alice/project/pull/42" })] });
  expect((await lookupPR(cwd, run))?.url).toBe("https://github.com/alice/project/pull/42");
  expect(calls.find(args => args[1] === "api")).toContain("owner=alice");
});
test("open PRs in both fork and parent are ambiguous, not silently selected", async () => {
  const { run } = fixture({ localPRs: [pr({ url: "https://github.com/alice/project/pull/10", number: 10 })] });
  await expect(lookupPR(cwd, run)).rejects.toThrow("Multiple open PRs");
});


describe("current checks replace historical rollups", () => {
  const historical = [
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "CANCELLED" },
    { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
  ];
  test("superseded cancellation is not counted when the current rerun passed", async () => {
    const { run, calls } = fixture({ prs: [pr({ statusCheckRollup: historical })], currentChecks: [{ state: "SUCCESS" }] });
    const result = await lookupPR(cwd, run);
    expect(result?.checks).toEqual({ passed: 1, failed: 0, pending: 0, total: 1 });
    expect(calls).toContainEqual(["gh", "pr", "checks", "42", "--repo", "https://github.com/base/project", "--json", "state"]);
    expect(formatPR(result).pr_checks).toBe("\uf42e 1/1");
  });
  test("a current cancellation or failure remains failed, not hidden by old success", async () => {
    for (const state of ["CANCELLED", "FAILURE"]) {
      const result = await lookupPR(cwd, fixture({ prs: [pr({ statusCheckRollup: historical })], currentChecks: [{ state }] }).run);
      expect(result?.checks).toEqual({ passed: 0, failed: 1, pending: 0, total: 1 });
    }
  });
  test("a pending rerun remains pending instead of retaining an old failure", async () => {
    const result = await lookupPR(cwd, fixture({ prs: [pr({ statusCheckRollup: historical })], currentChecks: [{ state: "QUEUED" }] }).run);
    expect(result?.checks).toEqual({ passed: 0, failed: 0, pending: 1, total: 1 });
  });
  test("distinct workflow/event checks returned by gh remain distinct", async () => {
    const result = await lookupPR(cwd, fixture({ prs: [pr({ statusCheckRollup: historical })], currentChecks: [{ state: "SUCCESS" }, { state: "FAILURE" }] }).run);
    expect(result?.checks).toEqual({ passed: 1, failed: 1, pending: 0, total: 2 });
  });
  test("unknown state is unknown; malformed output and failed requests are errors", async () => {
    const opts = { prs: [pr({ statusCheckRollup: historical })] };
    expect((await lookupPR(cwd, fixture({ ...opts, currentChecks: [{ state: "FUTURE" }] }).run))?.checks).toBeNull();
    await expect(lookupPR(cwd, fixture({ ...opts, currentChecks: {} }).run)).rejects.toThrow("Unexpected check rollup");
    await expect(lookupPR(cwd, fixture({ ...opts, fail: "checks" }).run)).rejects.toThrow("checks failure");
  });
});
