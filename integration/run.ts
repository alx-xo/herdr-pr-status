import assert from 'node:assert/strict';
import { version as pluginVersion } from '../package.json';
import { mkdtemp, mkdir, writeFile, symlink, readFile, rm, readdir, realpath, copyFile, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createConnection } from 'node:net';
import { isolatedEnv, inspectUnlessGone, waitFor as condition } from './helpers';
import { joinCommand, runIsolatedCommand } from './command';
import { captureServerOutput } from './server-output';

const source = resolve(import.meta.dir, '..');
const standalone = process.argv.includes('--standalone');
const binaryArg = process.argv.indexOf('--binary');
const suppliedBinary = binaryArg < 0 ? undefined : process.argv[binaryArg + 1];
assert(binaryArg < 0 || (standalone && suppliedBinary), '--binary requires --standalone and a path');
const plugin = 'alx-xo.pr-status';
const binaries = Object.fromEntries(['herdr', 'bun', 'git', 'ps'].map(name => {
  const path = Bun.which(name);
  assert(path, `Required tool missing: ${name}; install it explicitly (no downloads are performed)`);
  return [name, path];
}));
const root = await realpath(await mkdtemp(join(tmpdir(), 'herdr-it-')));
const checkout = standalone ? join(root, 'plugin') : source;
const env = isolatedEnv(root);
if (standalone) env.PATH = join(root, 'bin');
const state = join(root, 'state/herdr/plugins', plugin);
let server: ReturnType<typeof Bun.spawn> | undefined;
let serverOutput: ReturnType<typeof captureServerOutput> | undefined;
let linked = false;
let stopped = false;
let cleaningUp = false;
let interrupted = false;
const interrupt = () => { interrupted = true; };
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
function checkInterrupted(): void {
  if (!cleaningUp) serverOutput?.check();
  if (interrupted && !cleaningUp) throw new Error('Integration interrupted; cleaning up owned runtime');
}
const waitFor = <T>(label: string, probe: () => Promise<T | undefined>, ms?: number) =>
  condition(label, async () => { checkInterrupted(); return probe(); }, ms);

// All subprocesses, including preflight, receive the allowlisted environment.
async function run(args: string[], cwd = root): Promise<string> {
  checkInterrupted();
  try {
    const command = runIsolatedCommand(args, cwd, env);
    return (await joinCommand(command, !cleaningUp ? serverOutput?.failure : undefined)).trim();
  }
  catch (error) { throw new Error(sanitize(error instanceof Error ? error.message : String(error))); }
}
const herdr = async (...args: string[]): Promise<any> => {
  const out = await run([binaries.herdr!, ...args]);
  if (args[0] === 'server' && args[1] === 'stop' && !out) return null;
  assert(out, `Missing JSON from herdr ${args.join(' ')}`);
  return JSON.parse(out);
};
function sanitize(value: string): string {
  return value.replaceAll(root, '<isolated-root>').replaceAll(checkout, '<checkout>')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/("?token"?\s*[:=]\s*)[^,\s}]+/gi, '$1<redacted>');
}
async function action(name: 'status' | 'stop'): Promise<any> {
  const invoked = await herdr('plugin', 'action', 'invoke', name, '--plugin', plugin);
  const id = invoked.result.log.log_id;
  return waitFor(`completed ${name} action`, async () => {
    const logs = (await herdr('plugin', 'log', 'list', '--plugin', plugin, '--limit', '30')).result.logs;
    const entry = logs.find((log: any) => log.log_id === id);
    if (!entry || entry.status === 'running') return;
    assert.equal(entry.status, 'succeeded', `${name}: ${sanitize(JSON.stringify(entry)).slice(-2000)}`);
    assert.equal(entry.exit_code, 0);
    return JSON.parse(entry.stdout);
  });
}
// Never kill by name or trust a stale PID file. The unique private state path
// in the actual process environment proves ownership, even after reparenting.
// ps output is private/in-memory and is NEVER included in diagnostics.
async function ownedWorkers(): Promise<number[]> {
  const rows = (await run([binaries.ps!, '-axo', 'pid=,command='])).split('\n');
  const candidates = rows.filter(row => row.includes(standalone ? `${checkout}/bin/pr-status _worker` : `${checkout}/src/main.ts _worker`))
    .map(row => Number(row.trim().split(/\s+/)[0]));
  const pids: number[] = [];
  for (const pid of candidates) {
    assert(Number.isSafeInteger(pid) && pid > 1);
    // Inspect environments only for this checkout's workers; never print them.
    const detail = await inspectUnlessGone(
      () => run([binaries.ps!, 'eww', '-p', String(pid), '-o', 'command=']),
      () => {
        try { process.kill(pid, 0); return true; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
          throw error; // EPERM and tool failures cannot prove absence
        }
      },
    );
    if (detail === undefined) continue;
    const marker = `HERDR_PLUGIN_STATE_DIR=${state}`;
    if (detail.includes(`${marker} `) || detail.endsWith(marker)) pids.push(pid);
  }
  return pids;
}
async function controls(): Promise<string[]> {
  if (!existsSync(state)) return [];
  const dirs = await readdir(state);
  return dirs.filter(name => name.startsWith('session-')).map(name => join(state, name, 'control.json')).filter(existsSync);
}
async function endpointClosed(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (closed: boolean) => { socket.destroy(); resolve(closed); };
    socket.setTimeout(500, () => done(false));
    socket.once('connect', () => done(false));
    socket.once('error', (error: NodeJS.ErrnoException) => done(error.code === 'ECONNREFUSED'));
  });
}
async function stopWorker(): Promise<void> {
  const ports: number[] = [];
  for (const path of await controls()) {
    const { port } = JSON.parse(await readFile(path, 'utf8'));
    assert(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid owned endpoint');
    ports.push(port);
  }
  await action('stop');
  await waitFor('status running=false', async () => (await action('status')).running === false ? true : undefined);
  await waitFor('worker process and control endpoint gone', async () =>
    (await ownedWorkers()).length === 0 && (await controls()).length === 0 ? true : undefined);
  for (const port of ports) await waitFor('worker listener closed', async () => await endpointClosed(port) ? true : undefined);
  stopped = true;
}

let failure: unknown;
try {
  for (const dir of ['bin', 'home', 'config/herdr', 'state', 'cache', 'data', 'runtime', 'tmp', 'gh', 'fixture']) {
    await mkdir(join(root, dir), { recursive: true, mode: 0o700 });
  }
  await writeFile(join(root, 'gitconfig'), '');
  for (const name of (standalone ? ['herdr', 'git'] : ['herdr', 'bun', 'git'])) await symlink(binaries[name]!, join(root, 'bin', name));
  if (standalone) {
    for (const name of ['sh', 'dirname']) {
      const path = Bun.which(name);
      assert(path, `Required tool missing: ${name}`);
      await symlink(path, join(root, 'bin', name));
    }
    await mkdir(join(checkout, 'bin'), { recursive: true });
    const manifest = await readFile(join(source, 'herdr-plugin.toml'), 'utf8');
    await writeFile(join(checkout, 'herdr-plugin.toml'), manifest);
    await mkdir(join(checkout, 'scripts'));
    await copyFile(join(source, 'scripts/run.sh'), join(checkout, 'scripts/run.sh'));
    const target = `${process.platform}-${process.arch}`;
    if (suppliedBinary) {
      await copyFile(resolve(suppliedBinary), join(checkout, 'bin/pr-status'));
    } else {
      await run([binaries.bun!, join(source, 'scripts/build-runtime.ts'), target, join(checkout, 'bin')], source);
      await rename(join(checkout, 'bin', `pr-status-${target}`), join(checkout, 'bin/pr-status'));
    }
    const revision = await run(['git', 'rev-parse', 'HEAD'], source);
    assert.equal(await run([join(checkout, 'bin/pr-status'), '--version']), `pr-status ${pluginVersion} (${revision})`);
    await run([binaries.bun!, 'build', '--compile', join(source, 'integration/fake-gh.ts'), '--outfile', join(root, 'bin/gh')]);
    assert.equal(Bun.which('bun', { PATH: env.PATH }), null, 'No Bun in runtime PATH');
    assert.equal(Bun.which('node', { PATH: env.PATH }), null, 'No Node in runtime PATH');
  }
  const quote = (s: string) => `'${s.replaceAll("'", "'\"'\"'")}'`;
  if (!standalone) await writeFile(join(root, 'bin/gh'), `#!/bin/sh\nexec ${quote(binaries.bun!)} ${quote(join(import.meta.dir, 'fake-gh.ts'))} "$@"\n`, { mode: 0o700 });
  const version = await run([binaries.herdr!, '--version']);
  assert.match(version, /^herdr 0\.9\.3(?:\s|$)/, `Required Herdr 0.9.3, found ${version}`);
  await run([binaries.bun!, '--version']);
  await run([binaries.git!, '--version']);
  await writeFile(env.HERDR_CONFIG_PATH!, `[terminal]\ndefault_shell = "/bin/sh"\nshell_mode = "non_login"\n[update]\nversion_check = false\nmanifest_check = false\n`);
  const fixture = join(root, 'fixture');
  await run(['git', 'init', '-q', '-b', 'integration-branch'], fixture);
  await run(['git', '-c', 'user.name=Integration', '-c', 'user.email=integration@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture'], fixture);
  await run(['git', 'remote', 'add', 'origin', 'https://github.com/integration/fixture.git'], fixture);
  await herdr('plugin', 'link', checkout);
  linked = true;
  const plugins = (await herdr('plugin', 'list', '--json')).result.plugins;
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].plugin_root, checkout);
  const config = join(root, 'config/herdr/plugins/config', plugin);
  await mkdir(config, { recursive: true });
  await writeFile(join(config, 'config.json'), JSON.stringify({ iconSet: 'unicode', pollSeconds: 15, activePollSeconds: 15 }));
  const ownedServer = Bun.spawn([binaries.herdr!, 'server'], { cwd: root, env, stdout: 'pipe', stderr: 'pipe' });
  server = ownedServer;
  serverOutput = captureServerOutput([ownedServer.stdout, ownedServer.stderr]);
  await waitFor('isolated API socket', async () => {
    assert.equal(server!.exitCode, null, 'Owned server exited during startup');
    return existsSync(env.HERDR_SOCKET_PATH!) ? true : undefined;
  });
  await herdr('status', 'server', '--json');
  // No manual start or refresh: this must be the manifest startup hook.
  await waitFor('manifest startup hook', async () => {
    const logs = (await herdr('plugin', 'log', 'list', '--plugin', plugin, '--limit', '30')).result.logs;
    const startup = logs.find((log: any) => log.command?.at(-1) === 'start');
    if (!startup || startup.status === 'running') return;
    assert.equal(startup.status, 'succeeded', sanitize(JSON.stringify(startup)));
    assert.equal(startup.exit_code, 0);
    return true;
  });
  await waitFor('automatic worker', async () => (await action('status')).running === true ? true : undefined);
  assert.equal((await ownedWorkers()).length, 1, 'Exactly one isolated worker');
  const created = await herdr('workspace', 'create', '--cwd', fixture, '--label', 'integration-only', '--no-focus');
  const workspace = created.result.workspace.workspace_id;
  assert.equal(typeof workspace, 'string');
  const expected = { pr: '◉ #42', pr_checks: '✓ 1/1', pr_review: '✓ approved', pr_threads: '1 threads' };
  await waitFor('four exact published PR tokens', async () => {
    assert(!existsSync(join(root, 'home/gh-rejected')), 'Fake gh rejected an unexpected invocation');
    const info = (await herdr('workspace', 'get', workspace)).result.workspace;
    return Object.entries(expected).every(([key, value]) => info.tokens?.[key] === value) ? info : undefined;
  }, 60_000);
  await stopWorker();
  await herdr('server', 'stop');
  await waitFor('owned server exit', async () => server!.exitCode !== null ? true : undefined);
  assert.equal(server.exitCode, 0, 'Owned server must exit successfully');
  assert.equal(server.signalCode, null, 'Owned server must exit without a signal');
  await serverOutput.finish();
  await waitFor('owned Unix sockets removed', async () => {
    const paths = ['api.sock', 'api-client.sock', 'api.sock.agent'];
    return paths.every(path => !existsSync(join(root, path))) ? true : undefined;
  });
  console.log(`${standalone ? 'Standalone (no Bun/Node PATH)' : 'Source'} PASS Herdr 0.9.3: checkout linked → startup worker → four exact PR tokens → completed stop → worker/server cleanup`);
} catch (error) {
  failure = error;
  // Bounded diagnostics, never control.json (contains a bearer token) or env/ps.
  console.error(sanitize(String(error)).slice(-3000));
  // Raw server output is intentionally discarded, not logged or persisted.
} finally {
  cleaningUp = true;
  serverOutput?.stop();
  const cleanupErrors: unknown[] = [];
  let resourcesGone = false;
  if (server && server.exitCode === null) {
    if (linked && !stopped) { try { await stopWorker(); } catch (error) { cleanupErrors.push(error); } }
    try { await herdr('server', 'stop'); } catch { /* owned process handle fallback below */ }
    if (server.exitCode === null) server.kill('SIGTERM');
    try { await waitFor('server cleanup', async () => server!.exitCode !== null ? true : undefined, 5000); }
    catch {
      try {
        server.kill('SIGKILL');
        await waitFor('server forced cleanup', async () => server!.exitCode !== null ? true : undefined, 5000);
      } catch (error) { cleanupErrors.push(error); }
    }
  }
  try {
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      try {
        await waitFor('worker shutdown after server exit', async () => (await ownedWorkers()).length === 0 ? true : undefined, 5000);
        break;
      } catch {
        // Revalidate ownership immediately before signalling, never by name/PID file.
        for (const pid of await ownedWorkers()) {
          if ((await ownedWorkers()).includes(pid)) {
            try { process.kill(pid, signal); } catch { /* already exited */ }
          }
        }
      }
    }
    await waitFor('fallback worker cleanup', async () => (await ownedWorkers()).length === 0 ? true : undefined, 5000);
    resourcesGone = !server || server.exitCode !== null;
  } catch (error) { cleanupErrors.push(error); }
  if (cleanupErrors.length) {
    failure ??= new Error('Cleanup failed');
    console.error(sanitize(cleanupErrors.map(String).join('\n')).slice(-2000));
  }
  if (resourcesGone) await rm(root, { recursive: true, force: true });
  else {
    // Do not destroy the control token/state while a detached worker may live.
    // Keep no raw logs: failure diagnostics above are already bounded/sanitized.
    const removeLogs = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await removeLogs(path);
        else if (entry.isFile() && entry.name.endsWith('.log')) await rm(path, { force: true });
      }
    };
    await removeLogs(root);
    console.error(`Cleanup unverified; private recovery state retained at ${root}`);
  }
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
if (failure) process.exitCode = 1;
