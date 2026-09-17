import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type Socket } from 'node:net';
import { defaults } from '../src/format';
import { enabled, pollLoop, type CycleState } from '../src/polling';
import { serialized, tryLock } from '../src/locking';

const entry = new URL('../src/main.ts', import.meta.url).pathname;
const initial = (): CycleState => ({ running: true, state: 'starting', cycles: 0, startedAt: new Date(0).toISOString() });

test('polling reloads config, waits after completion, and retries without overlap', async () => {
  const state = initial();
  const events: string[] = [];
  const delays: number[] = [];
  let loads = 0;
  let time = 0;
  await pollLoop({
    active: () => loads < 3,
    load: async () => { events.push('load'); return { ...defaults, pollSeconds: ++loads === 1 ? 15 : 30 }; },
    cycle: async () => {
      events.push('begin'); await Bun.sleep(1); time += 2000; events.push('end');
      if (loads === 1) throw new Error('GitHub auth unavailable');
    },
    sleep: async ms => { events.push('sleep'); delays.push(ms); time += ms; },
    save: async () => {}, now: () => time,
  }, state);
  expect(events).toEqual(['load', 'begin', 'end', 'sleep', 'load', 'begin', 'end', 'sleep', 'load', 'begin', 'end']);
  expect(delays).toEqual([15000, 30000]);
  expect(state.cycles).toBe(3);
  expect(state.lastErrorAt).toBe(new Date(2000).toISOString());
  expect(state.lastSuccessAt).toBe(new Date(51000).toISOString());
  expect(state.lastError).toBeUndefined();
});

test('malformed config reports error and uses bounded fallback delay', async () => {
  const state = initial(); let active = true; let delay = 0;
  await pollLoop({ active: () => active, load: async () => { throw new Error('bad config'); },
    cycle: async () => { throw new Error('must not refresh'); },
    save: async () => {}, sleep: async ms => { delay = ms; active = false; },
  }, state);
  expect(delay).toBe(60000); expect(state.lastError).toBe('bad config'); expect(state.cycles).toBe(1);
});

test('plugin list requires enabled registration and validates envelope', async () => {
  expect(await enabled(async () => JSON.stringify({ result: { plugins: [{ plugin_id: 'alx-xo.pr-status', enabled: true }] } }))).toBe(true);
  expect(await enabled(async () => JSON.stringify({ result: { plugins: [{ plugin_id: 'alx-xo.pr-status', enabled: false }] } }))).toBe(false);
  expect(await enabled(async () => JSON.stringify({ result: { plugins: [] } }))).toBe(false);
  await expect(enabled(async () => '{}')).rejects.toThrow('Invalid Herdr plugin list');
});

test('manual and polling leases serialize; busy lease is never stolen', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pr-lock-'));
  try {
    const path = join(dir, 'refresh.lock'); const order: string[] = [];
    await Promise.all([
      serialized(path, async () => { order.push('poll'); await Bun.sleep(80); order.push('poll done'); }),
      serialized(path, async () => { order.push('manual'); }),
    ]);
    expect(order).toEqual(['poll', 'poll done', 'manual']);
    const release = tryLock(path)!;
    try { await expect(serialized(path, async () => {}, 0)).rejects.toThrow('busy'); }
    finally { release(); }
    const recovered = tryLock(path); expect(recovered).toBeDefined(); recovered?.();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

async function fixture(delayMs = 0, handshake: 'normal' | 'delayed' | 'rejected' = 'normal') {
  const dir = await mkdtemp('/tmp/pr-poller-');
  const socket = join(dir, 'herdr.sock');
  const connections = new Set<Socket>();
  const subscriptions: unknown[] = [];
  const server = createServer(client => {
    connections.add(client); client.on('close', () => connections.delete(client));
    // Model Herdr's request timeout: merely opening a socket is insufficient.
    client.setTimeout(500, () => client.destroy());
    let text = '';
    client.on('data', data => {
      text += data.toString();
      if (!text.includes('\n')) return;
      const request = JSON.parse(text.split('\n')[0]!);
      if (request.method !== 'events.subscribe') { client.destroy(); return; }
      subscriptions.push(request.params);
      client.setTimeout(0);
      setTimeout(() => {
        if (client.destroyed) return;
        const reply = handshake === 'rejected' ? { error: { message: 'Denied subscription' } }
          : { id: request.id, result: { type: 'subscription_started' } };
        client.write(JSON.stringify(reply) + '\n');
      }, handshake === 'delayed' ? 350 : 0);
    });
  });
  await new Promise<void>(resolve => server.listen(socket, resolve));
  await writeFile(join(dir, 'enabled'), 'true');
  await writeFile(join(dir, 'config.json'), JSON.stringify({ pollSeconds: 15 }));
  const fake = join(dir, 'herdr');
  await writeFile(fake, `#!${process.execPath}\nimport {readFileSync,appendFileSync} from 'node:fs';\nconst dir=process.env.HERDR_PLUGIN_STATE_DIR;\nif(process.argv[2]==='plugin') console.log(JSON.stringify({result:{plugins:[{plugin_id:'alx-xo.pr-status',enabled:readFileSync(dir+'/enabled','utf8')==='true'}]}}));\nelse {appendFileSync(dir+'/calls','refresh\\n');await Bun.sleep(${delayMs});console.log(JSON.stringify({result:{workspaces:[]}}));}\n`, { mode: 0o700 });
  const env = { ...process.env, HERDR_ENV: '1', HERDR_PLUGIN_CONFIG_DIR: dir, HERDR_PLUGIN_STATE_DIR: dir, HERDR_SOCKET_PATH: socket, HERDR_BIN_PATH: fake };
  const cli = async (command: string) => {
    const proc = Bun.spawn([process.execPath, entry, command], { env, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code) throw new Error(`${command}: ${err}`);
    return JSON.parse(out);
  };
  const until = async (predicate: () => Promise<boolean>, timeout = 8000) => {
    const end = Date.now() + timeout;
    while (!await predicate()) { if (Date.now() > end) throw new Error('Timed out'); await Bun.sleep(50); }
  };
  const cleanup = async () => {
    await cli('stop').catch(() => {});
    for (const client of connections) client.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await Bun.sleep(150);
    await rm(dir, { recursive: true, force: true });
  };
  return { dir, cli, until, cleanup, connections, env, subscriptions };
}

test('detached duplicate start, immediate refresh, explicit stop and safe stale recovery', async () => {
  const f = await fixture();
  try {
    const starts = await Promise.all([f.cli('start'), f.cli('start')]);
    expect(starts[0].startedAt).toBe(starts[1].startedAt);
    await f.until(async () => (await f.cli('status')).cycles === 1);
    expect((await readFile(join(f.dir, 'calls'), 'utf8')).trim()).toBe('refresh');
    expect(f.subscriptions).toEqual([{ subscriptions: [{ type: 'workspace.closed' }] }]);
    await f.cli('refresh');
    expect((await readFile(join(f.dir, 'calls'), 'utf8')).trim().split('\n')).toHaveLength(2);
    expect((await f.cli('stop')).state).toBe('stopping');
    await f.until(async () => !(await f.cli('status')).running);
    expect((await f.cli('start')).running).toBe(true);
    await f.until(async () => (await f.cli('status')).cycles === 1);
  } finally { await f.cleanup(); }
}, 15000);

test('disabled plugin stops existing worker without relying on a disable hook', async () => {
  const f = await fixture();
  try {
    await f.cli('start');
    await f.until(async () => (await f.cli('status')).cycles === 1);
    await writeFile(join(f.dir, 'enabled'), 'false');
    await f.until(async () => !(await f.cli('status')).running);
  } finally { await f.cleanup(); }
}, 15000);

test('Herdr connection close stops worker even while socket inode still exists', async () => {
  const f = await fixture();
  try {
    await f.cli('start');
    await f.until(async () => (await f.cli('status')).cycles === 1);
    for (const client of f.connections) client.destroy();
    await f.until(async () => !(await f.cli('status')).running);
  } finally { await f.cleanup(); }
}, 10000);


test('kernel ownership recovers after an owned worker crashes with stale endpoint state', async () => {
  const f = await fixture();
  const info = await stat(f.env.HERDR_SOCKET_PATH, { bigint: true });
  const child = Bun.spawn([process.execPath, entry, '_worker'], {
    env: { ...f.env, HERDR_PR_STATUS_SESSION: `${info.dev}:${info.ino}:${info.ctimeNs}` },
    stdout: 'ignore', stderr: 'pipe',
  });
  try {
    await f.until(async () => {
      if (child.exitCode !== null) throw new Error(`Worker exited ${child.exitCode}: ${await new Response(child.stderr).text()}`);
      return (await f.cli('status')).cycles === 1;
    });
    child.kill('SIGKILL'); await child.exited;
    expect((await f.cli('status')).running).toBe(false);
    expect((await f.cli('start')).running).toBe(true);
    await f.until(async () => (await f.cli('status')).cycles === 1);
  } finally { child.kill(); await child.exited; await f.cleanup(); }
}, 10000);


test('start waits for a stopping in-flight worker and launches a replacement', async () => {
  const f = await fixture(600);
  try {
    const first = await f.cli('start');
    await f.until(async () => { try { return (await readFile(join(f.dir, 'calls'), 'utf8')).includes('refresh'); } catch { return false; } });
    expect((await f.cli('stop')).state).toBe('stopping');
    const second = await f.cli('start');
    expect(second.running).toBe(true);
    expect(second.state).not.toBe('stopping');
    expect(second.startedAt).not.toBe(first.startedAt);
    await f.until(async () => (await f.cli('status')).cycles === 1);
    expect((await f.cli('status')).running).toBe(true);
  } finally { await f.cleanup(); }
}, 15000);


test('start waits for subscription acknowledgement before declaring readiness', async () => {
  const f = await fixture(0, 'delayed');
  try {
    const began = Date.now();
    const result = await f.cli('start');
    expect(Date.now() - began).toBeGreaterThanOrEqual(350);
    expect(result.running).toBe(true);
    expect(result.state).not.toBe('starting');
  } finally { await f.cleanup(); }
}, 10000);

test('rejected subscription fails start without refreshing and retains diagnostics', async () => {
  const f = await fixture(0, 'rejected');
  try {
    await expect(f.cli('start')).rejects.toThrow('Poller exited during startup');
    const result = await f.cli('status');
    expect(result.running).toBe(false);
    expect(result.lastError).toBe('Herdr subscription rejected');
    await expect(readFile(join(f.dir, 'calls'), 'utf8')).rejects.toThrow();
  } finally { await f.cleanup(); }
}, 10000);
