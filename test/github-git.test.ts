import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { lookupPR, type Runner } from "../src/github";

// No fetch/push, staging, or network: refs and config exist only in disposable repos.
for (const scenario of [
  { name: "upstream maps differently named branch", mode: "upstream", head: "remote-feature" },
  { name: "current ignores differently named upstream", mode: "current", head: "local-feature" },
  { name: "default simple rejects differently named upstream" },
  { name: "explicit simple rejects differently named upstream", mode: "simple" },
  { name: "default simple accepts same-named upstream", same: true, head: "local-feature" },
  { name: "triangular simple uses local branch", triangular: true, head: "local-feature" },
  { name: "triangular current uses local branch", mode: "current", triangular: true, head: "local-feature" },
  { name: "triangular upstream is unresolved", mode: "upstream", triangular: true },
  { name: "matching is ambiguous", mode: "matching" },
  { name: "nothing is unresolved", mode: "nothing" },
  { name: "unresolved refspec does not fall back to upstream", mode: "upstream", refspec: "refs/heads/other:refs/heads/other" },
  { name: "matching refspec does not fall back to upstream", mode: "upstream", refspec: ":" },
  { name: "Git-resolved explicit refspec overrides current", mode: "current", refspec: "refs/heads/local-feature:refs/heads/mapped-feature", head: "mapped-feature" },
]) {
  test(`real Git: ${scenario.name}`, async () => {
    const cwd = await mkdtemp("/tmp/herdr-pr-git-");
    const git = async (...args: string[]) => {
      const child = Bun.spawn(["git", ...args], {
        cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe",
        env: { PATH: process.env.PATH, HOME: cwd, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      });
      const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      if (code !== 0) throw new Error(error);
      return output;
    };
    let ghCalls = 0;
    try {
      await git("init", "-b", "local-feature");
      const tree = (await git("mktree")).trim();
      const commit = (await git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit-tree", tree, "-m", "fixture")).trim();
      await git("update-ref", "refs/heads/local-feature", commit);
      await git("remote", "add", "origin", "https://github.com/alice/project.git");
      await git("remote", "add", "fork", "https://github.com/alice/project.git");
      await git("config", "branch.local-feature.remote", "origin");
      await git("config", "branch.local-feature.merge", `refs/heads/${scenario.same ? "local-feature" : "remote-feature"}`);
      if (scenario.mode) await git("config", "push.default", scenario.mode);
      if (scenario.triangular) await git("config", "branch.local-feature.pushRemote", "fork");
      if (scenario.refspec) await git("config", "remote.origin.push", scenario.refspec);
      if (scenario.mode === "upstream" && !scenario.triangular && !scenario.refspec) {
        expect(await git("for-each-ref", "--format=%(push:remotename)%09%(push:remoteref)", "refs/heads/local-feature")).toBe("origin\t\n");
      }
      const run: Runner = async (args, actualCwd) => {
        expect(actualCwd).toBe(cwd);
        if (args[0] === "git") return git(...args.slice(1));
        ghCalls++;
        if (args[1] === "repo") return JSON.stringify({ nameWithOwner: "alice/project", url: "https://github.com/alice/project" });
        if (args[1] === "pr") {
          expect(args[args.indexOf("--head") + 1]).toBe(scenario.head!);
          return JSON.stringify([{ number: 42, url: "https://github.com/alice/project/pull/42", state: "OPEN", isDraft: false,
            headRefName: scenario.head, headRepository: { name: "project" }, headRepositoryOwner: { login: "alice" },
            statusCheckRollup: [], reviewDecision: "APPROVED" }]);
        }
        return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: {
          nodes: [], pageInfo: { hasNextPage: false, endCursor: null },
        } } } } });
      };
      if (scenario.head) expect((await lookupPR(cwd, run))?.number).toBe(42);
      else {
        await expect(lookupPR(cwd, run)).rejects.toThrow();
        expect(ghCalls).toBe(0);
      }
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
}
