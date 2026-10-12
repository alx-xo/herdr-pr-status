import { describe, expect, test } from 'bun:test';
import { isolatedEnv } from './helpers';
import { runIsolatedCommand } from './command';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Explicit *.check.ts invocation only: no Herdr session or live API is used.
describe('bounded isolated command capture', () => {
  const run = (source: string, maxOutputBytes = 1024) => runIsolatedCommand(
    [process.execPath, '-e', source], process.cwd(), isolatedEnv('/tmp/private-fixture'),
    { timeoutMs: 1000, maxOutputBytes, drainMs: 100 },
  );
  test('uses a private process group and the explicit child environment', async () => {
    expect(await run(`
      process.kill(-process.pid, 0);
      if (process.env.GH_TOKEN || process.env.HERDR_MACHINE) process.exit(2);
      process.stdout.write(process.env.HOME);
    `)).toBe('/tmp/private-fixture/home');
    expect(await run('process.stdout.write("é".repeat(8))', 16)).toBe('é'.repeat(8));
  });
  test('rejects stderr overflow during capture, without waiting for child exit', async () => {
    await expect(run('process.stderr.write("x".repeat(65536)); setInterval(() => {}, 1000)'))
      .rejects.toThrow('output exceeded');
  });
  test('counts combined raw bytes rather than decoded character counts', async () => {
    await expect(run('process.stdout.write("é".repeat(4)); process.stderr.write("é".repeat(4));', 12))
      .rejects.toThrow('output exceeded 12 bytes');
  });
  for (const escaped of [false, true]) {
    test(`bounds inherited-pipe timeout (escaped descendant: ${escaped})`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'herdr-command-check-'));
      const pidFile = join(root, 'pid');
      let pid: number | undefined;
      const descendant = join(root, 'pipe-holder.ts');
      await writeFile(descendant, 'setTimeout(() => {}, 30_000);');
      const inspect = async (pid: number) => {
        const ps = Bun.spawn(['/bin/ps', '-p', String(pid), '-o', 'stat=', '-o', 'command='], { stdout: 'pipe', stderr: 'pipe' });
        const [output, error, code] = await Promise.all([
          new Response(ps.stdout).text(), new Response(ps.stderr).text(), ps.exited,
        ]);
        if (code !== 0 && !(code === 1 && !output.trim() && !error.trim())) throw new Error('Process inspection failed');
        const match = output.trim().match(/^(\S+)\s+(.+)$/);
        return match ? { dead: match[1]!.startsWith('Z'), owned: match[2] === `${process.execPath} ${descendant}` } : undefined;
      };
      try {
        await expect(runIsolatedCommand([process.execPath, '-e', `
          const child = Bun.spawn([process.execPath, ${JSON.stringify(descendant)}], {
            stdin: 'ignore', stdout: 'inherit', stderr: 'inherit', detached: ${escaped},
          });
          await Bun.write(${JSON.stringify(pidFile)}, String(child.pid));
          process.exit(0);
        `], root, isolatedEnv(root), { timeoutMs: 1000, drainMs: 100 }))
          .rejects.toThrow('timed out');
        pid = Number(await readFile(pidFile, 'utf8'));
        expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
        const state = await inspect(pid);
        if (escaped) {
          // A separate group stays alive; capture is bounded by pipe cancellation.
          expect(state).toEqual({ dead: false, owned: true });
        } else {
          // A reparented zombie is already terminated but may await init reap.
          expect(state === undefined || state.dead).toBe(true);
        }
      } finally {
        // A PID file only locates the candidate. Revalidate the unique fixture
        // command immediately before signalling; never signal a dead descendant.
        if (pid === undefined) {
          try { pid = Number(await readFile(pidFile, 'utf8')); } catch { /* spawn failed */ }
        }
        if (pid !== undefined && Number.isSafeInteger(pid) && pid > 1) {
          const state = await inspect(pid);
          if (state?.owned && !state.dead) {
            try { process.kill(pid, 'SIGKILL'); } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
            }
          }
        }
        await rm(root, { recursive: true, force: true });
      }
    }, 15_000);
  }
});
describe('child environment boundary', () => {
  test('uses only explicit isolated values, never inherited credentials or routing', () => {
    const original = { GH_TOKEN: process.env.GH_TOKEN, HERDR_MACHINE: process.env.HERDR_MACHINE };
    try {
      process.env.HERDR_MACHINE = 'real-machine';
      process.env.GH_TOKEN = 'do-not-inherit';
      const env = isolatedEnv('/tmp/private-fixture');
      expect(env.HERDR_MACHINE).toBeUndefined();
      expect(env.GH_TOKEN).toBeUndefined();
      expect(env.HOME).toBe('/tmp/private-fixture/home');
      expect(env.HERDR_SOCKET_PATH).toBe('/tmp/private-fixture/api.sock');
      expect(env.PATH).toBe('/tmp/private-fixture/bin:/usr/bin:/bin');
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

import { fakeGh } from './fake-gh';
test('fake GitHub accepts equivalent read formatting and rejects unsupported requests', () => {
  expect(fakeGh(['repo', 'view', '--json', 'parent,url,nameWithOwner', 'github.com/integration/fixture'])).toEqual({
    nameWithOwner: 'integration/fixture', url: 'https://github.com/integration/fixture', parent: null,
  });
  expect(fakeGh(['pr', 'checks', '--json', 'link,event,workflow,state', '--repo', 'https://github.com/integration/fixture', '42'])).toEqual([
    { state: 'SUCCESS', workflow: 'CI', event: 'pull_request', link: 'https://github.com/integration/fixture/actions/runs/1/job/1' },
  ]);
  const query = 'query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){mergeQueueEntry{state} reviewThreads(first:100,after:$cursor){nodes{isResolved} pageInfo{hasNextPage endCursor}}}}}';
  const graphql = ['api', 'graphql', '-F', 'number=42', '-f', 'name=fixture', '-f', 'owner=integration', '--hostname', 'github.com', '-f', `query=${query}`];
  expect(fakeGh(graphql)).toEqual({ data: { repository: { pullRequest: {
    mergeQueueEntry: null, reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }], pageInfo: { hasNextPage: false, endCursor: null } },
  } } } });
  for (const args of [
    ['auth', 'token'],
    ['pr', 'merge', '42', '--repo', 'https://github.com/integration/fixture'],
    ['repo', 'view', 'github.com/real/repo', '--json', 'nameWithOwner,url,parent'],
    ['pr', 'checks', '43', '--repo', 'https://github.com/integration/fixture', '--json', 'state,workflow,event,link'],
    ['repo', 'view', 'github.com/integration/fixture', '--json', 'nameWithOwner,url,parent', '--web'],
    ['repo', 'view', 'github.com/integration/fixture', '--json', 'nameWithOwner,url,parent,parent'],
    graphql.map(arg => arg === 'owner=integration' ? 'owner=real' : arg),
    graphql.map(arg => arg === 'github.com' ? 'example.com' : arg),
    graphql.map(arg => arg.startsWith('query=') ? arg.replace('query(', 'mutation(') : arg),
    graphql.map(arg => arg.startsWith('query=') ? arg.replace('mergeQueueEntry{state}', 'id') : arg),
    [...graphql, '-f', 'owner=real'],
  ]) expect(() => fakeGh(args)).toThrow('Unexpected gh invocation');
});

import { waitFor } from './helpers';
test('condition waits retry until observed, and time out instead of hanging', async () => {
  let attempts = 0;
  expect(await waitFor('ready', async () => ++attempts === 2 ? 'observed' : undefined, 1000)).toBe('observed');
  await expect(waitFor('never', async () => undefined, 1)).rejects.toThrow('Timed out: never');
});

import { inspectUnlessGone } from './helpers';
test('process inspection failure is not evidence that a live worker exited', async () => {
  const denied = async (): Promise<string> => { throw new Error('inspection denied'); };
  await expect(inspectUnlessGone(denied, () => true)).rejects.toThrow('inspection denied');
  expect(await inspectUnlessGone(denied, () => false)).toBeUndefined();
  expect(await inspectUnlessGone(async () => 'owned', () => true)).toBe('owned');
});
