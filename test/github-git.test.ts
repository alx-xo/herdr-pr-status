import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { lookupPR, type Runner } from "../src/github";

// No fetch/push, staging, or network: refs and config exist only in disposable repos.
for (const scenario of [
  { name: "worktree-specific push remote overrides shared config", worktree: true, worktreeConfig: true, same: true, head: "local-feature" },
  { name: "pushDefault overrides fetch upstream", pushDefault: true, same: true, head: "local-feature" },
  { name: "non-origin upstream maps remote branch", rename: true, mode: "upstream", head: "remote-feature" },
  { name: "linked worktree uses its own branch", worktree: true, same: true, head: "local-feature" },
  { name: "detached HEAD does not call GitHub", detached: true },
  { name: "URL insteadOf expands push identity", rewrite: true, same: true, head: "local-feature" },
  { name: "pushInsteadOf expands push identity", pushRewrite: true, same: true, head: "local-feature" },
  { name: "explicit push URL overrides pushInsteadOf", pushRewrite: true, pushURL: true, same: true, head: "local-feature" },
  { name: "multiple non-origin remotes without preference", untracked: true, ambiguous: true },
  { name: "missing configured push remote does not fall back", same: true, missingRemote: true },
  { name: "sole non-origin remote without tracking", untracked: true, rename: true, head: "local-feature" },
  { name: "untracked branch uses push URL", untracked: true, pushURL: true, head: "local-feature" },
  { name: "pushDefault without tracking", untracked: true, pushDefault: true, head: "local-feature" },
  { name: "pushRemote overrides pushDefault", untracked: true, pushDefault: true, pushRemote: true, head: "local-feature" },
  { name: "multiple push URLs are ambiguous", same: true, multipleURLs: true },
  { name: "multiple push refspecs are ambiguous", same: true, multipleRefs: true },
  { name: "mirror push is not a branch destination", same: true, mirror: "true" },
  { name: "empty mirror value is false", same: true, mirror: "", head: "local-feature" },
  { name: "numeric zero mirror value is false", same: true, mirror: "00", head: "local-feature" },
  { name: "untracked nothing never guesses", untracked: true, mode: "nothing" },
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
    const root = await mkdtemp("/tmp/herdr-pr-git-");
    let cwd = root;
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
      if (scenario.untracked) {
        await git("config", "--unset", "branch.local-feature.remote");
        await git("config", "--unset", "branch.local-feature.merge");
      }
      if (scenario.rename) {
        await git("remote", "remove", "fork");
        await git("remote", "rename", "origin", "publish");
      }
      if (scenario.pushDefault) {
        await git("config", "remote.pushDefault", "fork");
        await git("remote", "set-url", "origin", "https://github.com/wrong/project.git");
      }
      if (scenario.pushRemote) {
        await git("config", "branch.local-feature.pushRemote", "origin");
        await git("remote", "set-url", "origin", "https://github.com/alice/project.git");
        await git("remote", "set-url", "fork", "https://github.com/wrong/project.git");
      }
      if (scenario.ambiguous) await git("remote", "rename", "origin", "other");
      if (scenario.missingRemote) await git("config", "branch.local-feature.pushRemote", "missing");
      if (scenario.rewrite || scenario.pushRewrite) {
        await git("remote", "set-url", "origin", "test-host:alice/project.git");
        await git("config", `url.https://github.com/.${scenario.rewrite ? "insteadOf" : "pushInsteadOf"}`, "test-host:");
      }
      if (scenario.pushURL) {
        await git("remote", "set-url", "origin", "https://github.com/wrong/project.git");
        await git("remote", "set-url", "--push", "origin", "https://github.com/alice/project.git");
      }
      if (scenario.multipleURLs) {
        await git("config", "--add", "remote.origin.pushurl", "https://github.com/alice/project.git");
        await git("config", "--add", "remote.origin.pushurl", "https://github.com/bob/project.git");
      }
      if (scenario.multipleRefs) {
        await git("config", "--add", "remote.origin.push", "refs/heads/local-feature:refs/heads/local-feature");
        await git("config", "--add", "remote.origin.push", "refs/heads/local-feature:refs/heads/other");
      }
      if (scenario.mirror !== undefined) await git("config", "remote.origin.mirror", scenario.mirror);
      if (scenario.mode) await git("config", "push.default", scenario.mode);
      if (scenario.triangular) await git("config", "branch.local-feature.pushRemote", "fork");
      if (scenario.refspec) await git("config", "remote.origin.push", scenario.refspec);
      if (scenario.mode === "upstream" && !scenario.triangular && !scenario.refspec) {
        expect(await git("for-each-ref", "--format=%(push:remotename)%09%(push:remoteref)", "refs/heads/local-feature")).toBe(`${scenario.rename ? "publish" : "origin"}\t\n`);
      }
      if (scenario.worktree) {
        await git("checkout", "--detach");
        await git("worktree", "add", `${root}/linked`, "local-feature");
        cwd = `${root}/linked`;
      }
      if (scenario.worktreeConfig) {
        await git("config", "extensions.worktreeConfig", "true");
        await git("config", "--worktree", "branch.local-feature.pushRemote", "fork");
        await git("remote", "set-url", "origin", "https://github.com/wrong/project.git");
      }
      if (scenario.detached) await git("checkout", "--detach");
      const run: Runner = async (args, actualCwd) => {
        expect(actualCwd).toBe(cwd);
        if (args[0] === "git") return git(...args.slice(1));
        ghCalls++;
        if (args[1] === "repo") expect(args[3]).toBe("github.com/alice/project");
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
      if (scenario.detached) {
        await expect(lookupPR(cwd, run)).rejects.toMatchObject({ category: 'unresolved' });
        expect(ghCalls).toBe(0);
      } else if (scenario.head) expect((await lookupPR(cwd, run))?.number).toBe(42);
      else {
        await expect(lookupPR(cwd, run)).rejects.toThrow();
        expect(ghCalls).toBe(0);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
