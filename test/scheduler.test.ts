import { expect, test } from 'bun:test';
import { defaults, parseConfig } from '../src/format';
import { Scheduler } from '../src/scheduler';
import { localIdentity, observedCheckout, workspaceLoop } from '../src/workspace-loop';

import { mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import type { Runner } from '../src/process';

const a = { workspace_id: 'a', label: 'A', focused: true };
const b = { workspace_id: 'b', label: 'B' };
function ready() {
  const s = new Scheduler(); s.reconcile([a, b]);
  for (const w of s.localTargets()) s.observe(w.workspace_id, 'main');
  expect(s.take(0, defaults)?.workspace_id).toBe('a'); s.complete(1000, defaults, false);
  expect(s.take(1000, defaults)?.workspace_id).toBe('b'); s.complete(2000, defaults, false);
  return s;
}
test('active config defaults, boundaries, strict invalid values', () => {
  expect(parseConfig({}).activePollSeconds).toBe(30);
  for (const n of [15, 3600]) expect(parseConfig({ activePollSeconds: n }).activePollSeconds).toBe(n);
  for (const n of [14, 3601, 15.5, '30', null]) expect(() => parseConfig({ activePollSeconds: n })).toThrow('activePollSeconds');
});
test('per-workspace completion-relative deadlines and config reload', () => {
  const s = ready();
  expect(s.take(30999, defaults)).toBeUndefined();
  expect(s.take(31000, defaults)?.workspace_id).toBe('a');
  expect(s.take(62000, defaults)).toBeUndefined(); // no overlap
  s.complete(70000, defaults, false);
  expect(s.take(70000, defaults)?.workspace_id).toBe('b'); s.complete(71000, defaults, false);
  expect(s.take(85000, { ...defaults, activePollSeconds: 15 })?.workspace_id).toBe('a');
});
test('focus checks both ends without forcing two network calls; entering overdue', () => {
  const s = ready(); s.focus('b');
  expect(new Set(s.localTargets().map(w => w.workspace_id))).toEqual(new Set(['a', 'b']));
  s.observe('a', 'main'); s.observe('b', 'main');
  expect(s.take(3000, defaults)).toBeUndefined();
  expect(s.take(32000, defaults)?.workspace_id).toBe('b');
});
test('changed leaving checkout and detached entering checkout coalesce', () => {
  const s = ready(); s.focus('b'); s.observe('a', '/new:main'); s.observe('a', '/new:next'); s.observe('b', '/old:');
  const refreshed = [s.take(3000, defaults)?.workspace_id]; s.complete(3001, defaults, false);
  refreshed.push(s.take(3001, defaults)?.workspace_id); s.complete(3002, defaults, false);
  expect(new Set(refreshed)).toEqual(new Set(['a', 'b']));
  expect(s.take(3003, defaults)).toBeUndefined();
});
test('branch switch in flight survives completion and gives background work a turn', () => {
  const s = ready(); s.observe('a', 'feature');
  expect(s.take(62000, defaults)?.workspace_id).toBe('a');
  s.observe('a', 'main'); s.observe('a', 'feature');
  s.complete(63000, defaults, false);
  expect(s.take(63000, defaults)?.workspace_id).toBe('b'); s.complete(64000, defaults, false);
  expect(s.take(64000, defaults)?.workspace_id).toBe('a');
});
test('failure backs off despite pending changes and repeated focus', () => {
  const s = ready(); s.observe('a', 'feature'); s.take(3000, defaults);
  s.observe('a', 'next'); s.complete(4000, defaults, true);
  s.focus('b'); s.focus('a');
  expect(s.take(33999, defaults)).toBeUndefined();
  expect(s.take(34000, defaults)?.workspace_id).toBe('a');
});
test('new and disappeared workspaces, including id reuse during lookup', () => {
  const s = ready(); s.observe('a', 'changed'); s.take(3000, defaults);
  s.reconcile([b]); s.reconcile([a, b]); s.complete(4000, defaults, true);
  expect(s.take(4000, defaults)?.workspace_id).toBe('a');
});
test('focus events received during list are not overwritten by stale snapshot', () => {
  const s = ready(); const revision = s.focusVersion; s.focus('b');
  s.reconcile([a, b], revision); expect(s.focused).toBe('b');
});
// A turn boundary flushes the loop's promise continuations without advancing its clock.
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('local observation runs during remote lookup and stop waits without launching another', async () => {
  const s = new Scheduler(); let active = true; let local = 0; let refreshes = 0;
  const remote = Promise.withResolvers<void>();
  const observedWhileBlocked = Promise.withResolvers<void>();
  const resumeObservation = Promise.withResolvers<void>();
  let localAtStart = 0; let done = false;
  const loop = workspaceLoop({
    scheduler: s, active: () => active, load: async () => defaults, list: async () => [a, b],
    local: async () => String(++local),
    refresh: async () => { refreshes++; localAtStart = local; await remote.promise; },
    sleep: async () => {
      if (refreshes > 0 && local > localAtStart) {
        observedWhileBlocked.resolve(); await resumeObservation.promise;
      }
    },
    error: error => { throw error; }, settled: async () => {},
  }).then(() => { done = true; });
  try {
    await observedWhileBlocked.promise;
    expect(local).toBeGreaterThan(localAtStart);
    expect(s.entries.get('a')?.pending).toBe(true);
    expect(s.entries.get('b')?.pending).toBe(true);
    active = false; resumeObservation.resolve();
    await turn();
    expect(done).toBe(false); // stop must still await the unresolved remote lane
    expect(refreshes).toBe(1);
  } finally {
    active = false; resumeObservation.resolve(); remote.resolve(); await loop;
  }
  expect(done).toBe(true); expect(refreshes).toBe(1);
  await workspaceLoop({ scheduler: new Scheduler(), active: () => false,
    load: async () => { throw Error('stopped'); }, list: async () => [], local: async () => '',
    refresh: async () => { throw Error('stopped'); }, sleep: async () => {}, error: () => {}, settled: async () => {},
  });
});

test('config and local failures back off rather than focus-triggered tight loops', async () => {
  let now = 0; let active = true;
  const loads: number[] = []; const locals: number[] = [];
  const s = new Scheduler();
  await workspaceLoop({ scheduler: s, now: () => now, active: () => active,
    load: async () => { loads.push(now); if (now === 0) throw Error('bad config'); return defaults; },
    list: async () => [{ ...a, focused: false }],
    local: async () => { locals.push(now); throw Error('unreadable checkout'); },
    refresh: async () => {}, error: () => {}, settled: async () => {},
    sleep: async ms => {
      // Repeated focus must not bypass either retry deadline.
      s.focus('b'); s.focus('a'); s.focus('a');
      if (now < 60000) expect(loads).toEqual([0]);
      if (now >= 60000 && now < 75000) expect(locals).toEqual([60000]);
      if (locals.length === 2) active = false;
      now += ms;
      if (now > 80000) throw Error('retry never arrived');
    },
  });
  expect(loads[1]).toBeGreaterThanOrEqual(60000);
  expect(loads[1]).toBeLessThanOrEqual(62000);
  expect(locals).toHaveLength(2);
  expect(locals[1]! - locals[0]!).toBeGreaterThanOrEqual(15000);
  expect(locals[1]! - locals[0]!).toBeLessThanOrEqual(17000);
});

test('workspace loop observes both focus endpoints and refreshes only a changed leaving checkout', async () => {
  for (const changed of [false, true]) {
    const s = ready();
    const observed: string[] = []; const refreshed: string[] = [];
    let active = true; let switched = false;
    await workspaceLoop({ scheduler: s, now: () => 3000, active: () => active,
      load: async () => defaults, list: async () => [{ ...a, focused: !switched }, { ...b, focused: switched }],
      local: async w => { observed.push(w.workspace_id); return switched && changed && w.workspace_id === 'a' ? 'feature' : 'main'; },
      refresh: async (_, w) => { refreshed.push(w.workspace_id); },
      sleep: async () => {
        await turn();
        if (!switched) {
          expect(observed).toEqual(['a']); expect(refreshed).toEqual([]);
          observed.length = 0; switched = true; s.focus('b');
        } else active = false;
      },
      error: error => { throw error; }, settled: async () => {},
    });
    expect(new Set(observed)).toEqual(new Set(['a', 'b']));
    expect(s.entries.get('a')?.identity).toBe(changed ? 'feature' : 'main');
    expect(s.entries.get('b')?.identity).toBe('main');
    expect(refreshed).toEqual(changed ? ['a'] : []);
    expect(s.take(3000, defaults)).toBeUndefined();
  }
});

test('local identity detects checkout replacement and detached transitions without GitHub', async () => {
  const root = await mkdtemp('/tmp/pr-local-');
  try {
    await mkdir(`${root}/.git`);
    let branch = 'main';
    const run: Runner = async args => {
      expect(args[0]).toBe('git');
      if (args[1] === 'remote') return 'origin';
      if (args[1] === 'branch') return branch;
      if (args[2] === '--show-toplevel') return root;
      if (args[2] === '--absolute-git-dir') return `${root}/.git`;
      throw new Error('Unexpected local command');
    };
    const w = { ...a, worktree: { checkout_path: root } };
    const initial = await localIdentity(w, run);
    expect(await localIdentity(w, run)).toBe(initial);
    expect(observedCheckout(initial)).toMatchObject({ root: expect.stringContaining('pr-local-'), branch: 'main' });
    branch = '';
    expect(observedCheckout(await localIdentity(w, run)).branch).toBe('');
    expect(await localIdentity(w, run)).not.toBe(initial);
    branch = 'main';
    await rename(`${root}/.git`, `${root}/old-git`); await mkdir(`${root}/.git`);
    expect(await localIdentity(w, run)).not.toBe(initial);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('consumption resets preflight changes but retains observations after lookup begins', () => {
  const s = ready(); s.observe('a', 'queued'); s.take(3000, defaults);
  s.observe('a', 'lock-wait'); s.observe('a', 'preflight');
  expect(s.consume('a', 'preflight')).toBe(true);
  s.complete(4000, defaults, false);
  expect(s.take(4000, defaults)).toBeUndefined();
  s.observe('a', 'next'); s.take(5000, defaults); s.consume('a', 'next');
  s.observe('a', 'during'); s.complete(6000, defaults, false);
  expect(s.take(6000, defaults)?.workspace_id).toBe('a');
});

test('service backoff is shared, jittered, capped and manual only bypasses unknown timing', () => {
  const s = new Scheduler(() => 0);
  s.reconcile([a, b]);
  s.serviceFailure(1000);
  expect(s.nextRetryAt).toBe(16000);
  expect(s.take(15999, defaults)).toBeUndefined();
  expect(s.canRefresh(1001, true)).toBe(true);
  s.serviceFailure(16000, 100000);
  expect(s.nextRetryAt).toBe(100000);
  expect(s.canRefresh(99999, true)).toBe(false);
  expect(s.canRefresh(100000, true)).toBe(true);
  s.serviceSuccess();
  s.serviceFailure(100000);
  expect(s.nextRetryAt).toBe(115000);
  for (let i = 0; i < 20; i++) s.serviceFailure(100000);
  expect(s.nextRetryAt).toBe(250000);
  const upper = new Scheduler(() => 1);
  for (let i = 0; i < 20; i++) upper.serviceFailure(0);
  expect(upper.nextRetryAt).toBe(300000);
});

test('sleep recovery coalesces missed polls and completing work still schedules from completion', () => {
  const s = ready();
  const resumed = 86400000;
  expect(s.take(resumed, defaults)?.workspace_id).toBe('a');
  expect(s.take(resumed, defaults)).toBeUndefined();
  s.complete(resumed + 100, defaults, false);
  expect(s.take(resumed + 100, defaults)?.workspace_id).toBe('b');
  s.complete(resumed + 200, defaults, false);
  expect(s.take(resumed + 200, defaults)).toBeUndefined();
  expect(s.take(resumed + 30099, defaults)).toBeUndefined();
  expect(s.take(resumed + 30100, defaults)?.workspace_id).toBe('a');
});

for (const pollSeconds of [60, 3600]) {
  test(`transient completion retries at reported deadline instead of ${pollSeconds}s interval`, () => {
    const s = new Scheduler(() => 0);
    const config = { ...defaults, pollSeconds, activePollSeconds: pollSeconds };
    s.reconcile([a]);
    expect(s.take(0, config)?.workspace_id).toBe('a');
    s.serviceFailure(1000);
    s.complete(2000, config, true);
    expect(s.nextRetryAt).toBe(16000);
    expect(s.take(15999, config)).toBeUndefined();
    expect(s.take(16000, config)?.workspace_id).toBe('a');
    expect(s.take(16000, config)).toBeUndefined();
    s.serviceFailure(17000, 400000);
    s.complete(18000, config, true);
    expect(s.nextRetryAt).toBe(400000);
    expect(s.take(399999, config)).toBeUndefined();
    expect(s.take(400000, config)?.workspace_id).toBe('a');
    s.serviceSuccess();
    s.complete(401000, config, false);
    expect(s.take(401001, config)).toBeUndefined();
    expect(s.take(401000 + pollSeconds * 1000, config)?.workspace_id).toBe('a');
  });
}

test('transient retries retain FIFO fairness and the capped deadline through completion', () => {
  const s = new Scheduler(() => 0);
  const config = { ...defaults, pollSeconds: 3600, activePollSeconds: 3600 };
  s.reconcile([a, b]);
  expect(s.take(0, config)?.workspace_id).toBe('a');
  s.serviceFailure(0); s.complete(1, config, true);
  expect(s.take(15000, config)?.workspace_id).toBe('b');
  expect(s.take(15000, config)).toBeUndefined();
  s.serviceSuccess(); s.complete(15001, config, false);
  expect(s.take(15001, config)?.workspace_id).toBe('a');
  let now = 15001;
  for (const deadline of [30001, 60001, 120001, 240001, 390001, 540001]) {
    s.serviceFailure(now); s.complete(now + 1, config, true);
    expect(s.nextRetryAt).toBe(deadline);
    expect(s.take(deadline - 1, config)).toBeUndefined();
    expect(s.take(deadline, config)?.workspace_id).toBe('a');
    now = deadline;
  }
});
