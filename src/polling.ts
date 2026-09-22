import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createConnection, createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { defaults, formatPR, parseConfig, type Config } from './format';
import { herdrBin, listWorkspaces, publishTokens } from './herdr';
import { runCommand, type Runner } from './process';
import { refresh, StaleCheckoutError, type RefreshState, type RefreshResult, type Publisher } from './refresh';
import { serialized, tryLock } from './locking';

import { Scheduler } from './scheduler';
import { localIdentity, observedCheckout, workspaceLoop } from './workspace-loop';
import { subscribe } from './subscription';
import { sanitize } from './feedback';

const id = 'alx-xo.pr-status';
const message = (error: unknown) => sanitize(error instanceof Error ? error.message : String(error));
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

// Whole refresh/preview results are returned or explicitly rejected, never silently cut.
const controlResponseLimit = 256 * 1024;
class ControlResponseError extends Error {}
function controlResponse(value: Record<string, unknown>): string {
  const json = JSON.stringify(value);
  return Buffer.byteLength(json) <= controlResponseLimit ? json : JSON.stringify({
    code: 'RESPONSE_TOO_LARGE',
    error: 'Poller response exceeds the 256 KiB limit. Reduce workspace count or shorten labels and retry; status shows bounded diagnostics.',
  });
}

/** Status snapshots prioritize failures, bound user-controlled strings, and declare omissions. */
function statusSnapshot(state: CycleState) {
  const bounded = (value: string, size: number) => sanitize(value.slice(0, size)).slice(0, size);
  const results = state.workspaces ?? [];
  const ordered = [...results.filter(result => result.status === 'error'), ...results.filter(result => result.status !== 'error')];
  return { ...state, workspaces: ordered.slice(0, 100).map(result => ({ ...result,
    workspace: bounded(result.workspace, 128), label: bounded(result.label, 128),
    cwd: result.cwd === undefined ? undefined : bounded(result.cwd, 512),
    reason: result.reason === undefined ? undefined : bounded(result.reason, 512),
    action: result.action === undefined ? undefined : bounded(result.action, 512),
  })), omittedWorkspaces: Math.max(0, results.length - 100) };
}

export async function control(s: Session, command: 'status' | 'stop' | 'refresh' | 'preview'): Promise<Record<string, unknown>> {
  const endpoint = JSON.parse(await readFile(s.control, 'utf8'));
  if (!Number.isInteger(endpoint.port) || endpoint.port < 1 || endpoint.port > 65535 || typeof endpoint.token !== 'string') throw new Error('Invalid poller endpoint');
  return new Promise((resolve, reject) => {
    const client = createConnection({ host: '127.0.0.1', port: endpoint.port });
    const chunks: Buffer[] = [];
    let bytes = 0;
    client.setTimeout(command === 'refresh' || command === 'preview' ? 120000 : 2000, () => client.destroy(new Error('Poller control timed out')));
    client.on('connect', () => client.write(`${endpoint.token} ${command}\n`));
    client.on('error', reject);
    client.on('data', data => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
      bytes += chunk.length;
      if (bytes > controlResponseLimit) { client.destroy(new ControlResponseError('Poller response exceeds the 256 KiB limit; reduce workspace count or shorten labels and retry')); return; }
      chunks.push(chunk);
    });
    client.on('end', () => {
      try {
        const response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (response.code === 'RESPONSE_TOO_LARGE') throw new ControlResponseError(response.error);
        resolve(response);
      } catch (error) { reject(error); }
    });
  });
}
export async function status(s: Session): Promise<Record<string, unknown>> {
  try { return await control(s, 'status'); } catch (error) {
    if (error instanceof ControlResponseError) throw error;
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
export async function manualRefresh(s: Session, config: Config, memory?: RefreshState, preview = false): Promise<RefreshResult[]> {
  if (!memory && (await status(s)).running) {
    const response = await control(s, preview ? 'preview' : 'refresh');
    if (!Array.isArray(response.results)) throw new Error('Live refresh failed; inspect status and retry');
    return response.results as RefreshResult[];
  }
  return serialized(join(s.dir, 'refresh.lock'), async () => {
    if (!await sameSession(s) || !await enabled()) throw new Error('Herdr session ended or plugin is disabled/unlinked');
    const guarded: Runner = async (args, cwd) => {
      if (!await sameSession(s)) throw new Error('Herdr session ended');
      if (args.includes('report-metadata') && !await enabled()) throw new Error('Plugin disabled/unlinked');
      if (!await sameSession(s)) throw new Error('Herdr session ended');
      return runCommand(args, cwd);
    };
    const publish: Publisher = (id, tokens, validate) => publishTokens(id, tokens, async args => {
      if (!await sameSession(s) || !await enabled()) throw new Error('Herdr session ended or plugin is disabled/unlinked');
      if (!await sameSession(s)) throw new Error('Herdr session ended');
      await validate();
      return runCommand(args);
    });
    return refresh(config, preview, guarded, undefined, memory, publish);
  });
}
export async function previewRefresh(config: Config): Promise<RefreshResult[]> {
  if (process.env.HERDR_PLUGIN_STATE_DIR && process.env.HERDR_SOCKET_PATH) {
    return manualRefresh(await session(), config, undefined, true);
  }
  return refresh(config, true);
}

class RefreshFailed extends Error {}

export interface CycleState {
  running: boolean; state: string; cycles: number; startedAt: string;
  lastSuccessAt?: string; lastErrorAt?: string; lastError?: string; nextRunAt?: string;
  workspaces?: Omit<RefreshResult, 'tokens'>[];
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
  const memory: RefreshState = new Map();
  const recordResults = (results: RefreshResult[]) => {
    const diagnostics = new Map(state.workspaces?.map(result => [result.workspace, result]));
    for (const { tokens: _tokens, ...result } of results) diagnostics.set(result.workspace, result);
    state.workspaces = [...diagnostics.values()];
    const errors = state.workspaces.filter(result => result.status === 'error');
    if (errors.length) {
      state.lastError = sanitize(`${errors.length} workspace refresh(es) failed. ${errors[0]!.reason} ${errors[0]!.action} See workspace diagnostics.`);
      state.lastErrorAt = new Date().toISOString();
    } else delete state.lastError;
    if (results.some(result => result.freshness === 'fresh')) state.lastSuccessAt = new Date().toISOString();
  };
  const save = async () => { await writeFile(join(s.dir, 'status.json'), JSON.stringify(statusSnapshot(state)), { mode: 0o600 }); };
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
      if (cmd === 'refresh' || cmd === 'preview') {
        client.setTimeout(120000);
        void loadConfig().then(config => manualRefresh(s, config, memory, cmd === 'preview')).then(async results => {
          if (cmd === 'refresh') {
            recordResults(results);
            for (const result of results) if (result.stale) scheduler.requeue(result.workspace);
            if (results.some(result => result.stale)) { signaled = true; wake(); }
            await save();
          }
          client.end(controlResponse({ results }));
        }).catch(error => client.end(controlResponse({ error: message(error) })));
        return;
      }
      client.end(controlResponse(cmd === 'stop' || cmd === 'status' ? statusSnapshot(state) : { error: 'Unknown command' }));
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
      list: async () => {
        const workspaces = await listWorkspaces(guarded);
        const ids = new Set(workspaces.map(workspace => workspace.workspace_id));
        for (const id of memory.keys()) if (!ids.has(id)) memory.delete(id);
        state.workspaces = state.workspaces?.filter(result => ids.has(result.workspace));
        return workspaces;
      },
      local: async workspace => {
        const current = await localIdentity(workspace, guarded);
        const entry = scheduler.entries.get(workspace.workspace_id);
        const retained = memory.get(workspace.workspace_id);
        if (entry?.identity !== undefined && entry.identity !== current && retained) {
          const { root, branch } = observedCheckout(current);
          if (root !== await realpath(retained.cwd).catch(() => undefined) || branch !== retained.branch) {
            await publishTokens(workspace.workspace_id, formatPR(null), async args => {
              await checkCommand(args);
              if (memory.get(workspace.workspace_id) !== retained) return '';
              memory.delete(workspace.workspace_id);
              state.workspaces = state.workspaces?.filter(result => result.workspace !== workspace.workspace_id);
              return runCommand(args);
            });
          }
        }
        return current;
      },
      error: error => {
        if (!(error instanceof RefreshFailed)) { state.lastError = message(error); state.lastErrorAt = new Date().toISOString(); }
      },
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
        const publish: Publisher = (id, tokens, validate) => publishTokens(id, tokens, async args => {
          await checkCommand(args);
          // Validate after enablement/session waits, with no further await before spawn.
          const current = await localIdentity(entry.workspace, guarded);
          scheduler.observe(workspace.workspace_id, current);
          if (!active) throw new Error('Poller stopped');
          if (scheduler.entries.get(workspace.workspace_id) !== entry || ((entry.version !== version || current !== before) && args.includes('--token'))) throw new StaleCheckoutError('Checkout changed during lookup; retry on next refresh');
          await validate();
          return runCommand(args);
        });
        const results = await refresh(config, false, guarded, [entry.workspace], memory, publish);
        recordResults(results);
        if (results.some(result => result.stale)) {
          // An unfocused checkout has no periodic local observer. Requeue even
          // if it switched away and back before this final identity read.
          scheduler.requeue(workspace.workspace_id);
          const current = scheduler.entries.get(workspace.workspace_id);
          if (current) scheduler.observe(workspace.workspace_id, await localIdentity(current.workspace, guarded));
        }
        if (results.some(result => result.status === 'error')) throw new RefreshFailed();
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
