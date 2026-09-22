import { expect, test } from 'bun:test';
import { retryRefresh } from '../src/refresh-retry';
import { Scheduler } from '../src/scheduler';

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
