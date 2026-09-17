import { lookupPR } from './github';
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
  tokens?: Tokens;
}

export class StaleCheckoutError extends Error {}

/** Sequential workspaces bound gh traffic; one bad checkout does not block others. */
export async function refresh(config: Config, preview: boolean, run: Runner = runCommand, targets?: Workspace[]): Promise<RefreshResult[]> {
  const results: RefreshResult[] = [];
  for (const workspace of targets ?? await listWorkspaces(run)) {
    const base = { workspace: workspace.workspace_id, label: workspace.label };
    try {
      const checkout = await discoverCheckout(workspace, run);
      if (!checkout.cwd) {
        results.push({ ...base, status: 'skipped', reason: checkout.skipped });
        continue;
      }
      const branch = (await run(['git', 'branch', '--show-current'], checkout.cwd)).trim();
      const tokens = formatPR(await lookupPR(checkout.cwd, run), config);
      // GitHub calls can outlive a local checkout. Never publish the old branch's
      // result after a switch; flag it so polling can queue the current branch.
      const currentBranch = (await run(['git', 'branch', '--show-current'], checkout.cwd)).trim();
      if (currentBranch !== branch) {
        results.push({ ...base, status: 'skipped', stale: true, reason: 'Branch changed during lookup; retry on next refresh' });
        continue;
      }
      if (!preview) await publishTokens(workspace.workspace_id, tokens, run);
      results.push({ ...base, status: preview ? 'preview' : 'published', cwd: checkout.cwd, tokens });
    } catch (error) {
      // Keep prior metadata on failure; never fabricate a no-PR result.
      results.push({ ...base, status: error instanceof StaleCheckoutError ? 'skipped' : 'error',
        ...(error instanceof StaleCheckoutError ? { stale: true as const } : {}),
        reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}
