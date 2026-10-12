import { leasedPollRefresh } from '../src/polling';
import { expect, test } from 'bun:test';
import { retryRefresh } from '../src/refresh-retry';
import { Scheduler } from '../src/scheduler';
import { workspaceLoop } from '../src/workspace-loop';
import { defaults } from '../src/format';

test('runtime retries network immediately on manual action, but stops a failed batch and respects explicit rate timing', async () => {
  const scheduler = new Scheduler(() => 0);
  let now = 1000; let calls = 0;
  let error = 'network connection failed';
  const command = async () => { calls++; throw new Error(error); };
  const batch = async (run: () => Promise<unknown>) => {
    for (let i = 0; i < 3; i++) try { await run(); } catch { /* refresh records errors */ }
  };
  const work = (run: (argv: string[]) => Promise<string>) => batch(() => run(['gh', 'api']));
  await retryRefresh(scheduler, work, command, false, () => now);
  expect(calls).toBe(1);
  await expect(retryRefresh(scheduler, work, command, false, () => now)).rejects.toThrow('retry');
  error = 'HTTP 429 rate limit\nRetry-After: 120';
  await retryRefresh(scheduler, work, command, true, () => now);
  expect(calls).toBe(2);
  expect(scheduler.nextRetryAt).toBe(121000);
  await expect(retryRefresh(scheduler, work, command, true, () => now)).rejects.toThrow('00:02:01.000Z');
  now = 121000;
  await retryRefresh(scheduler, run => run(['gh', 'api']), async () => 'ok', true, () => now);
  expect(scheduler.canRefresh(now)).toBe(true);
});

for (const [metadata, deadline] of [
  ['Retry-After: Thu, 01 Jan 1970 00:02:00 GMT', 120000],
  ['X-RateLimit-Reset: 120', 120000],
  ['Retry-After: nonsense', 16000],
  ['retry in a few minutes', 16000],
  ['Retry-After: -1', 16000],
] as const) {
  test(`runtime only trusts explicit valid retry timing: ${metadata}`, async () => {
    const scheduler = new Scheduler(() => 0);
    await expect(retryRefresh(scheduler, run => run(['gh', 'api']), async () => {
      throw new Error(`HTTP 429 rate limit\n${metadata}`);
    }, false, () => 1000)).rejects.toThrow('429');
    expect(scheduler.nextRetryAt).toBe(deadline);
    expect(scheduler.canRefresh(1000, true)).toBe(deadline === 16000);
  });
}

test('normal quota reset metadata on a service error is not a known rate-limit cooldown', async () => {
  const scheduler = new Scheduler(() => 0);
  await expect(retryRefresh(scheduler, run => run(['gh', 'api']), async () => {
    throw new Error('HTTP 503 service unavailable\nX-RateLimit-Reset: 120');
  }, false, () => 1000)).rejects.toThrow('503');
  expect(scheduler.canRefresh(1000, true)).toBe(true);
  expect(scheduler.nextRetryAt).toBe(16000);
});

for (const [error, retryAt] of [
  ['network connection failed', 15000],
  ['HTTP 429 rate limit\nRetry-After: 120', 120000],
  ['HTTP 401 authentication failed', 3600000],
  ['HTTP 404 repository not found', 3600000],
] as const) {
  test(`runtime completion honors retry eligibility with an hourly poll: ${error.split('\n')[0]}`, async () => {
    const scheduler = new Scheduler(() => 0);
    const attempts: number[] = [];
    let now = 0; let active = true;
    await workspaceLoop({
      scheduler, now: () => now, active: () => active,
      load: async () => ({ ...defaults, pollSeconds: 3600, activePollSeconds: 3600 }),
      list: async () => [{ workspace_id: 'retry', label: 'Retry' }],
      local: async () => 'main',
      refresh: async () => {
        attempts.push(now);
        await retryRefresh(scheduler, run => run(['gh', 'api']), async () => {
          if (attempts.length === 1) throw new Error(error);
          active = false;
          return 'ok';
        }, false, () => now);
      },
      error: () => {},
      settled: async initial => {
        if (!initial && attempts.length === 1 && retryAt < 3600000) expect(scheduler.nextRetryAt).toBe(retryAt);
      },
      sleep: async ms => {
        await new Promise<void>(resolve => setImmediate(resolve));
        now += ms;
        if (now > retryAt + 2000) throw new Error('Retry did not become eligible at its deadline');
      },
    });
    expect(attempts).toEqual([0, Math.ceil(retryAt / 2000) * 2000]);
  });
}

test('workspace retries distinguish repeated authorization failures from shared service failures', async () => {
  const scheduler = new Scheduler(() => 0);
  scheduler.reconcile([{ workspace_id: 'retry', label: 'Retry', focused: true }]);
  let now = 0;
  const attempt = async (error: string) => {
    expect(scheduler.take(now, defaults)?.workspace_id).toBe('retry');
    await expect(retryRefresh(scheduler, run => run(['gh', 'api']), async () => {
      throw new Error(error);
    }, false, () => now)).rejects.toThrow(error);
    scheduler.complete(now, defaults, true);
  };
  await attempt('HTTP 401 authentication failed');
  now = 30000;
  await attempt('HTTP 404 repository not found');
  expect(scheduler.take(89999, defaults)).toBeUndefined();
  now = 90000;
  await attempt('HTTP 503 service unavailable');
  expect(scheduler.take(104999, defaults)).toBeUndefined();
  now = 105000;
  await attempt('HTTP 401 authentication failed');
  expect(scheduler.take(224999, defaults)).toBeUndefined();
  expect(scheduler.take(225000, defaults)?.workspace_id).toBe('retry');
});

for (const [pollError, retryAt] of [
  ['HTTP 401 authentication failed', 30003],
  ['network connection failed', 15003],
  ['HTTP 429 rate limit\nRetry-After: 120', 120003],
] as const) {
  test(`queued poll owns its retry after manual connectivity recovery: ${pollError.split('\n')[0]}`, async () => {
    const scheduler = new Scheduler(() => 0);
    scheduler.reconcile([{ workspace_id: 'a', label: 'A', focused: true }]);
    scheduler.observe('a', 'main');
    expect(scheduler.take(0, defaults)?.workspace_id).toBe('a');
    let now = 1;
    // Like refresh, return an error result rather than rejecting the whole action.
    const refreshError = (error: string, manual: boolean) => retryRefresh(scheduler, async run => {
      try { await run(['gh', 'api']); }
      catch { return [{ workspace: 'a', status: 'error' as const }]; }
      throw new Error('Expected the lookup to fail');
    }, async () => { throw new Error(error); }, manual, () => now);
    await refreshError('network connection failed', true);
    expect(scheduler.nextRetryAt).toBe(15001);
    now = 2;
    expect(await refreshError('HTTP 401 authentication failed', true)).toEqual([{ workspace: 'a', status: 'error' }]);
    expect(scheduler.nextRetryAt).toBe(0);
    // No successful manual publication: manualSuccess must not be called.
    now = 3;
    let failed = false;
    await leasedPollRefresh(scheduler, 'a', work => work(), async () => {
      expect(scheduler.consume('a', 'main')).toBe(true);
      const results = await refreshError(pollError, false);
      failed = results.some(result => result.status === 'error');
    });
    scheduler.complete(now, defaults, failed);
    expect(scheduler.take(4, defaults)).toBeUndefined();
    expect(scheduler.take(retryAt - 1, defaults)).toBeUndefined();
    expect(scheduler.take(retryAt, defaults)?.workspace_id).toBe('a');
  });
}

for (const [error, retryAt] of [
  ['network connection failed', 15001],
  ['HTTP 429 rate limit\nRetry-After: 120', 120001],
] as const) {
  test(`queued automatic refresh defers to the unchanged shared deadline: ${error.split('\n')[0]}`, async () => {
    const scheduler = new Scheduler(() => 0);
    const config = { ...defaults, pollSeconds: 3600, activePollSeconds: 3600 };
    scheduler.reconcile([{ workspace_id: 'a', label: 'A', focused: true }]);
    scheduler.observe('a', 'main');
    expect(scheduler.take(0, config)?.workspace_id).toBe('a');
    let now = 1;
    let calls = 0;
    let acquired!: () => Promise<void>;
    const poll = leasedPollRefresh(scheduler, 'a', work => new Promise((resolve, reject) => {
      acquired = async () => { try { await work(); resolve(); } catch (error) { reject(error); } };
    }), async () => {
      expect(scheduler.consume('a', 'main')).toBe(true);
      await retryRefresh(scheduler, run => run(['gh', 'api']), async () => {
        calls++;
        return 'ok';
      }, false, () => now);
    });
    const failed = poll.catch(error => error);
    await expect(retryRefresh(scheduler, run => run(['gh', 'api']), async () => {
      throw new Error(error);
    }, true, () => now)).rejects.toThrow(error);
    expect(scheduler.nextRetryAt).toBe(retryAt);
    now = 2;
    await acquired();
    expect((await failed).message).toContain('Refresh deferred');
    expect(calls).toBe(0);
    scheduler.complete(now, config, true);
    expect(scheduler.nextRetryAt).toBe(retryAt);
    expect(scheduler.take(retryAt - 1, config)).toBeUndefined();
    expect(scheduler.take(retryAt, config)?.workspace_id).toBe('a');
    // A deferral must not advance the shared failure count either.
    scheduler.serviceFailure(retryAt);
    expect(scheduler.nextRetryAt).toBe(retryAt + 30000);
  });
}

test('lease acquisition owns a preflight failure after manual auth recovery', async () => {
  const scheduler = new Scheduler(() => 0);
  scheduler.reconcile([{ workspace_id: 'a', label: 'A', focused: true }]);
  scheduler.observe('a', 'main');
  scheduler.take(0, defaults);
  let now = 1;
  const manual = (error: string) => retryRefresh(scheduler, async run => {
    try { await run(['gh', 'api']); } catch { return; }
  }, async () => { throw new Error(error); }, true, () => now);
  let acquired!: () => Promise<void>;
  const poll = leasedPollRefresh(scheduler, 'a', work => new Promise((resolve, reject) => {
    acquired = async () => { try { await work(); resolve(); } catch (error) { reject(error); } };
  }), async () => { throw new Error('local identity preflight failed'); });
  const failed = poll.catch(error => error);
  await manual('network connection failed');
  now = 2;
  await manual('HTTP 401 authentication failed');
  expect(scheduler.nextRetryAt).toBe(0);
  now = 3;
  await acquired();
  expect((await failed).message).toBe('local identity preflight failed');
  scheduler.complete(now, defaults, true);
  expect(scheduler.take(4, defaults)).toBeUndefined();
  expect(scheduler.take(30002, defaults)).toBeUndefined();
  expect(scheduler.take(30003, defaults)?.workspace_id).toBe('a');
  scheduler.complete(30003, defaults, true);
  expect(scheduler.take(90002, defaults)).toBeUndefined();
  expect(scheduler.take(90003, defaults)?.workspace_id).toBe('a');
});
