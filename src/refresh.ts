import { lookupPR, resolveContext, type PRStatus } from './github';
import { failure, LookupError, type FailureCategory } from './feedback';
import { formatPR, type Config, type Tokens } from './format';
import { discoverCheckout, listWorkspaces, publishTokens, type Workspace } from './herdr';
import { runCommand, type Runner } from './process';

export interface RefreshResult {
  workspace: string;
  label: string;
  status: 'preview' | 'published' | 'skipped' | 'error';
  stale?: true;
  cwd?: string;
  reason?: string;
  action?: string;
  category?: FailureCategory;
  freshness?: 'fresh' | 'stale' | 'unavailable';
  refreshedAt?: string;
  lastSuccessAt?: string;
  tokens?: Tokens;
}

/** Process-local only: never restored from the status snapshot. */
export type RefreshState = Map<string, { context: string; cwd: string; branch: string; pr: PRStatus | null; lastSuccessAt: string }>;
export class StaleCheckoutError extends Error {}

/** Runtime publishers must validate after their asynchronous permission checks. */
export type Publisher = (id: string, tokens: Tokens, validate: () => Promise<void>) => Promise<void>;

/** Sequential workspaces bound gh traffic; one bad checkout does not block others. */
export async function refresh(config: Config, preview: boolean, run: Runner = runCommand, targets?: Workspace[], state: RefreshState = new Map(), publisher?: Publisher): Promise<RefreshResult[]> {
  const publish: Publisher = publisher ?? (async (id, tokens, validate) => {
    await validate();
    await publishTokens(id, tokens, run);
  });
  const results: RefreshResult[] = [];
  for (const workspace of targets ?? await listWorkspaces(run)) {
    const id = workspace.workspace_id;
    const base = { workspace: id, label: workspace.label };
    let context: string | undefined;
    let cwd: string | undefined;
    let branch: string | undefined;
    let pr: PRStatus | null = null;
    let problem: ReturnType<typeof failure> | undefined;
    try {
      const checkout = await discoverCheckout(workspace, run);
      cwd = checkout.cwd;
      if (!cwd) throw new LookupError('unresolved', checkout.skipped ?? 'No Git checkout', checkout.skipped ?? 'No Git checkout');
      const resolved = await resolveContext(cwd, run);
      branch = resolved.branch;
      context = JSON.stringify([cwd, resolved]);
      if (!preview && state.get(id)?.context !== context) {
        await publish(id, formatPR(null, config), async () => {});
        state.delete(id);
      }
      pr = await lookupPR(cwd, run, resolved);
    } catch (error) {
      if (error instanceof StaleCheckoutError) {
        results.push({ ...base, status: 'skipped', stale: true, reason: 'Checkout changed; retry on next refresh' });
        continue;
      }
      problem = failure(error);
    }
    const previous = context !== undefined && state.get(id)?.context === context ? state.get(id) : undefined;
    const refreshedAt = new Date().toISOString();
    const tokens = formatPR(problem ? previous?.pr ?? null : pr, config);
    if (problem) tokens.pr = [tokens.pr, '⚠'].filter(Boolean).join(' ');
    const result: RefreshResult = { ...base, cwd, refreshedAt, tokens,
      status: problem ? 'error' : preview ? 'preview' : 'published',
      freshness: problem ? previous ? 'stale' : 'unavailable' : 'fresh',
      lastSuccessAt: problem ? previous?.lastSuccessAt : refreshedAt,
      ...(problem ? { category: problem.category, reason: problem.reason, action: problem.action } : {}) };
    try {
      // The runtime invokes this after enablement/session waits, just before spawn.
      const validate = async () => {
        if (cwd && context !== undefined) {
          let current: string;
          try {
            const checkout = await discoverCheckout(workspace, run);
            current = JSON.stringify([checkout.cwd, await resolveContext(cwd, run)]);
          }
          catch { throw new StaleCheckoutError(); }
          if (current !== context) throw new StaleCheckoutError();
        }
      };
      if (!preview) {
        await publish(id, tokens, validate);
        if (!problem) state.set(id, { context: context!, cwd: cwd!, branch: branch!, pr, lastSuccessAt: refreshedAt });
        else if (!previous) state.delete(id);
      } else await validate();
      results.push(result);
    } catch (error) {
      if (error instanceof StaleCheckoutError) {
        if (!preview) {
          state.delete(id);
          try { await publish(id, formatPR(null, config), async () => {}); } catch { /* publication may no longer be allowed */ }
        }
        results.push({ ...base, status: 'skipped', stale: true, reason: 'Checkout changed; retry on next refresh' });
      } else {
        const issue = failure(error);
        results.push({ ...result, status: 'error', category: issue.category, reason: issue.reason, action: issue.action,
          freshness: previous ? 'stale' : 'unavailable', lastSuccessAt: previous?.lastSuccessAt });
      }
    }
  }
  return results;
}
