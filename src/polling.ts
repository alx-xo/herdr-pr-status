import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { defaults, parseConfig, type Config } from './format';
import { herdrBin, listWorkspaces } from './herdr';
import { runCommand, type Runner } from './process';
import { refresh, StaleCheckoutError } from './refresh';
import { serialized, tryLock } from './locking';

import { Scheduler } from './scheduler';
import { localIdentity, workspaceLoop } from './workspace-loop';
import { subscribe } from './subscription';

const id = 'alx-xo.pr-status';
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1000);
export async function loadConfig(): Promise<Config> {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR || (await runCommand([herdrBin(), 'plugin', 'config-dir', id])).trim();
  if (!dir || !isAbsolute(dir)) throw new Error('Herdr must supply an absolute HERDR_PLUGIN_CONFIG_DIR');
  try { return parseConfig(JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return structuredClone(defaults);
    throw error;
  }
}

export interface Session { dir: string; socket: string; identity: string; control: string }
async function identity(path: string): Promise<string> {
  const info = await stat(path, { bigint: true });
  if (!info.isSocket()) throw new Error('HERDR_SOCKET_PATH is not a Unix socket');
  return `${info.dev}:${info.ino}:${info.ctimeNs}`;
}
export async function session(): Promise<Session> {
  const state = process.env.HERDR_PLUGIN_STATE_DIR;
  const socket = process.env.HERDR_SOCKET_PATH;
  if (process.env.HERDR_ENV !== '1' || !state || !isAbsolute(state) || !socket || !isAbsolute(socket)) {
    throw new Error('Run through Herdr with HERDR_ENV=1, absolute HERDR_PLUGIN_STATE_DIR and HERDR_SOCKET_PATH');
  }
  const instance = await identity(socket);
  const key = createHash('sha256').update(`${socket}\0${instance}`).digest('hex').slice(0, 16);
  const dir = join(state, `session-${key}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const control = join(dir, 'control.json');
  return { dir, socket, identity: instance, control };
}
export async function sameSession(s: Session): Promise<boolean> {
  try { return await identity(s.socket) === s.identity; } catch { return false; }
}
export async function enabled(run: Runner = runCommand): Promise<boolean> {
  const data = JSON.parse(await run([herdrBin(), 'plugin', 'list', '--plugin', id, '--json']));
  if (!Array.isArray(data.result?.plugins)) throw new Error('Invalid Herdr plugin list');
  return data.result.plugins.some((plugin: { plugin_id: string; enabled: boolean }) => plugin.plugin_id === id && plugin.enabled === true);
}

export async function control(s: Session, command: 'status' | 'stop'): Promise<Record<string, unknown>> {
  const endpoint = JSON.parse(await readFile(s.control, 'utf8'));
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== 'string') throw new Error('Invalid poller endpoint');
  return new Promise((resolve, reject) => {
    const client = createConnection({ host: '127.0.0.1', port: endpoint.port });
    let text = '';
    client.setTimeout(2000, () => client.destroy(new Error('Poller control timed out')));
    client.on('connect', () => client.write(`${endpoint.token} ${command}\n`));
    client.on('error', reject);
    client.on('data', data => {
      text += data.toString();
      if (text.length > 8192) client.destroy(new Error('Invalid poller response'));
    });
    client.on('end', () => { try { resolve(JSON.parse(text)); } catch (error) { reject(error); } });
  });
}
export async function status(s: Session): Promise<Record<string, unknown>> {
  try { return await control(s, 'status'); } catch {
    const release = tryLock(join(s.dir, 'worker.lock'));
    if (!release) return { running: true, state: 'starting or stopping', session: s.identity };
    release();
    let last = {};
    try { last = JSON.parse(await readFile(join(s.dir, 'status.json'), 'utf8')); } catch { /* no previous cycle */ }
    return { ...last, running: false };
  }
}
export async function start(s: Session): Promise<Record<string, unknown>> {
  return serialized(join(s.dir, 'launch.lock'), async () => {
    if (!await sameSession(s) || !await enabled()) throw new Error('Herdr session ended or plugin is disabled/unlinked');
    const ready = (value: Record<string, unknown>) => value.running === true &&
      !['starting', 'stopping', 'stopped', 'starting or stopping'].includes(String(value.state));
    // A stop request may still be draining a bounded external command. Do not
    // acknowledge a restart until that worker exits and a replacement is ready.
    const deadline = Date.now() + 35_000;
    for (;;) {
      const current = await status(s);
      if (ready(current)) return current;
      if (!current.running) break;
      if (Date.now() >= deadline) throw new Error('Previous poller is still stopping; retry start shortly');
      await Bun.sleep(50);
    }
    const child = spawn(process.execPath, [Bun.main, '_worker'], {
      detached: true, stdio: 'ignore', env: { ...process.env, HERDR_PR_STATUS_SESSION: s.identity },
    });
    let failure: Error | undefined;
    child.on('error', error => { failure = error; });
    child.on('exit', code => { if (code !== 0) failure = new Error(`Poller exited during startup (${code}); inspect status for details`); });
    child.unref();
    for (let attempt = 0; attempt < 140; attempt++) {
      if (failure) throw failure;
      try {
        const current = await control(s, 'status');
        if (ready(current)) return current;
      } catch { /* worker may not have published its endpoint yet */ }
      await Bun.sleep(50);
    }
    throw new Error('Poller did not become ready; check status and verify Bun FFI is available');
  });
}
export async function manualRefresh(s: Session, config: Config) {
  return serialized(join(s.dir, 'refresh.lock'), async () => {
    if (!await sameSession(s) || !await enabled()) throw new Error('Herdr session ended or plugin is disabled/unlinked');
    const guarded: Runner = async (args, cwd) => {
      if (!await sameSession(s)) throw new Error('Herdr session ended');
      if (args.includes('report-metadata') && !await enabled()) throw new Error('Plugin disabled/unlinked');
      if (!await sameSession(s)) throw new Error('Herdr session ended');
      return runCommand(args, cwd);
    };
    return refresh(config, false, guarded);
  });
}
export interface CycleState {
  running: boolean; state: string; cycles: number; startedAt: string;
  lastSuccessAt?: string; lastErrorAt?: string; lastError?: string; nextRunAt?: string;
}
export interface LoopOptions {
  load: () => Promise<Config>;
  cycle: (config: Config) => Promise<void>;
  active: () => boolean;
  sleep: (ms: number) => Promise<void>;
  save: (state: CycleState) => Promise<void>;
  now?: () => number;
}
/** Completion-relative delay; malformed config also backs off instead of spinning. */
export async function pollLoop(options: LoopOptions, state: CycleState): Promise<void> {
  const now = options.now ?? Date.now;
  while (options.active()) {
    let seconds = 60;
    state.state = 'refreshing'; delete state.nextRunAt;
    try {
      const config = await options.load();
      seconds = config.pollSeconds;
      await options.cycle(config);
      state.lastSuccessAt = new Date(now()).toISOString();
      delete state.lastError;
    } catch (error) {
      state.lastErrorAt = new Date(now()).toISOString(); state.lastError = message(error);
    }
    state.cycles++;
    state.state = options.active() ? 'waiting' : 'stopping';
    state.nextRunAt = new Date(now() + seconds * 1000).toISOString();
    await options.save(state);
    if (options.active()) await options.sleep(seconds * 1000);
  }
}
export async function worker(s: Session): Promise<void> {
  if (process.env.HERDR_PR_STATUS_SESSION !== s.identity) throw new Error('Internal worker session mismatch');
  // A status probe briefly holds this lease too. Retry transient contention;
  // a genuine duplicate still exits without touching the owner's endpoint.
  let release = tryLock(join(s.dir, 'worker.lock'));
  for (let attempt = 0; !release && attempt < 20; attempt++) {
    await Bun.sleep(25);
    release = tryLock(join(s.dir, 'worker.lock'));
  }
  if (!release) return;
  let active = true;
  let wake = () => {};
  let signaled = false;
  const scheduler = new Scheduler();
  const state: CycleState = { running: true, state: 'starting', cycles: 0, startedAt: new Date().toISOString() };
  const save = async () => { await writeFile(join(s.dir, 'status.json'), JSON.stringify(state), { mode: 0o600 }); };
  const stop = () => { active = false; state.state = 'stopping'; wake(); };
  const token = randomUUID();
  const server = createServer(client => {
    client.on('error', () => client.destroy());
    client.setTimeout(2000, () => client.destroy());
    let request = '';
    client.on('data', data => {
      request += data.toString();
      if (request.length > 128) { client.destroy(); return; }
      if (!request.includes('\n')) return;
      const [secret, cmd] = request.trim().split(' ');
      if (secret !== token) { client.destroy(); return; }
      if (cmd === 'stop') stop();
      client.end(JSON.stringify(cmd === 'stop' || cmd === 'status' ? state : { error: 'Unknown command' }));
    });
  });
  let watching = false;
  let lastPluginCheck = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let connection: ReturnType<typeof createConnection> | undefined;
  const check = async () => {
    if (!await sameSession(s)) { stop(); return; }
    if (Date.now() - lastPluginCheck < 5000) return;
    lastPluginCheck = Date.now();
    try { if (!await enabled()) stop(); }
    catch (error) { state.lastError = message(error); state.lastErrorAt = new Date().toISOString(); }
  };
  const checkCommand = async (args: string[]) => {
    if (!active || !await sameSession(s)) throw new Error('Poller stopped or Herdr session ended');
    if (args.includes('report-metadata') && !await enabled()) { stop(); throw new Error('Plugin disabled/unlinked'); }
    if (!active || !await sameSession(s)) throw new Error('Poller stopped');
  };
  const guarded: Runner = async (args, cwd) => {
    await checkCommand(args);
    if (!active) throw new Error('Poller stopped');
    return runCommand(args, cwd);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
  try {
    await unlink(s.control).catch(error => { if (error.code !== 'ENOENT') throw error; });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Invalid poller address');
    await writeFile(s.control, JSON.stringify({ port: address.port, token }), { mode: 0o600 });
    connection = createConnection(s.socket);
    connection.on('error', stop); connection.on('close', stop);
    await subscribe(connection, value => {
      if (!active || !value || typeof value !== 'object') return;
      const data = (value as { data?: { type?: string; workspace_id?: string } }).data;
      if (data?.type === 'workspace_focused' && typeof data.workspace_id === 'string') {
        scheduler.focus(data.workspace_id);
        signaled = true; wake();
      }
    }, error => {
      state.lastError = message(error); state.lastErrorAt = new Date().toISOString(); stop();
    });
    await check();
    timer = setInterval(() => {
      if (watching || !active) return;
      watching = true;
      void check().finally(() => { watching = false; });
    }, 1000);
    await workspaceLoop({
      scheduler, load: loadConfig, active: () => active,
      list: () => listWorkspaces(guarded),
      local: workspace => localIdentity(workspace, guarded),
      error: error => { state.lastError = message(error); state.lastErrorAt = new Date().toISOString(); },
      settled: async initial => {
        if (!initial || scheduler.entries.size === 0) state.cycles++;
        state.state = active ? 'waiting' : 'stopping';
        await save();
      },
      sleep: ms => new Promise(resolve => {
        const timeout = setTimeout(resolve, ms);
        wake = () => { clearTimeout(timeout); resolve(); };
        if (!active || signaled) { signaled = false; wake(); }
      }),
      refresh: (config, workspace) => serialized(join(s.dir, 'refresh.lock'), async () => {
        if (!active || !await sameSession(s)) throw new Error('Poller stopped');
        if (!await enabled()) { stop(); throw new Error('Plugin disabled/unlinked'); }
        const entry = scheduler.entries.get(workspace.workspace_id);
        if (!entry) return;
        const before = await localIdentity(entry.workspace, guarded);
        if (!scheduler.consume(workspace.workspace_id, before)) return;
        const version = entry.version;
        state.state = 'refreshing'; delete state.nextRunAt;
        const publishGuard: Runner = async (args, cwd) => {
          if (!args.includes('report-metadata')) return guarded(args, cwd);
          await checkCommand(args);
          // Validate after enablement/session waits, with no further await before spawn.
          const current = await localIdentity(entry.workspace, guarded);
          scheduler.observe(workspace.workspace_id, current);
          if (!active) throw new Error('Poller stopped');
          if (scheduler.entries.get(workspace.workspace_id) !== entry || entry.version !== version || current !== before) throw new StaleCheckoutError('Checkout changed during lookup; retry on next refresh');
          return runCommand(args, cwd);
        };
        const results = await refresh(config, false, publishGuard, [entry.workspace]);
        if (results.some(result => result.stale)) {
          // An unfocused checkout has no periodic local observer. Requeue even
          // if it switched away and back before this final identity read.
          scheduler.requeue(workspace.workspace_id);
          const current = scheduler.entries.get(workspace.workspace_id);
          if (current) scheduler.observe(workspace.workspace_id, await localIdentity(current.workspace, guarded));
        }
        const errors = results.filter(result => result.status === 'error');
        if (errors.length) throw new Error(errors.map(result => result.reason).join('; '));
        state.lastSuccessAt = new Date().toISOString(); delete state.lastError;
      }),
    });
  } catch (error) {
    state.lastError = message(error); state.lastErrorAt = new Date().toISOString();
    throw error;
  } finally {
    stop(); if (timer) clearInterval(timer); connection?.destroy();
    server.close();
    state.running = false; state.state = 'stopped'; delete state.nextRunAt;
    await save().catch(() => {});
    await unlink(s.control).catch(() => {});
    process.off('SIGTERM', stop); process.off('SIGINT', stop);
    release();
  }
}
