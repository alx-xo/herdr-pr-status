import { failure, LookupError } from './feedback';
import type { Runner } from './process';
import type { Scheduler } from './scheduler';

/** Only explicit HTTP retry metadata is authoritative; gh often omits it. */
function knownRetryAt(message: string, now: number): number | undefined {
  const after = /^retry-after:\s*(.+)$/im.exec(message)?.[1]?.trim();
  const rateLimited = /rate.?limit|\b429\b/i.test(message.replace(/^x-ratelimit-.*$/gim, ''));
  const reset = /^x-ratelimit-reset:\s*(\d+)\s*$/im.exec(message)?.[1];
  const deadlines: number[] = [];
  if (after) {
    const value = /^\d+$/.test(after) ? now + Number(after) * 1000
      : /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/i.test(after) ? Date.parse(after) : NaN;
    if (Number.isFinite(value) && value >= 0 && value <= 8.64e15) deadlines.push(value);
  }
  if (rateLimited && reset && Number(reset) * 1000 <= 8.64e15) deadlines.push(Number(reset) * 1000);
  return deadlines.length ? Math.max(...deadlines) : undefined;
}

/** Called inside the existing session refresh lease, shared by all refresh modes. */
export async function retryRefresh<T>(scheduler: Scheduler, work: (run: Runner) => Promise<T>, run: Runner, manual = false, now: () => number = Date.now): Promise<T> {
  if (!scheduler.canRefresh(now(), manual)) {
    throw new LookupError('service', `Refresh deferred; retry at ${new Date(scheduler.nextRetryAt).toISOString()}`);
  }
  let problem: LookupError | undefined;
  let queried = false;
  const guarded: Runner = async (argv, cwd) => {
    if (argv[0] !== 'gh') return run(argv, cwd);
    // One user action may retry immediately, not every workspace in that action.
    if (problem) throw problem;
    queried = true;
    try { return await run(argv, cwd); }
    catch (error) {
      const issue = failure(error);
      if (issue.category === 'service') {
        problem = issue;
        scheduler.serviceFailure(now(), knownRetryAt(error instanceof Error ? error.message : String(error), now()));
      }
      throw error;
    }
  };
  const result = await work(guarded);
  if (queried && !problem) scheduler.serviceSuccess();
  return result;
}
