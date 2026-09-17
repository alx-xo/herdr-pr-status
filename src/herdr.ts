import { runCommand, type Runner } from './process';
import { tokenNames, type Tokens } from './format';

export interface Workspace { workspace_id: string; label: string; focused?: boolean; worktree?: { checkout_path: string } }
export interface Checkout { cwd?: string; skipped?: string }
export const herdrBin = () => process.env.HERDR_BIN_PATH || 'herdr';

export async function listWorkspaces(run: Runner = runCommand): Promise<Workspace[]> {
  const data = JSON.parse(await run([herdrBin(), 'workspace', 'list']));
  if (!Array.isArray(data.result?.workspaces)) throw new Error('Invalid Herdr workspace list');
  return data.result.workspaces.map((w: Workspace) => {
    if (typeof w.workspace_id !== 'string' || typeof w.label !== 'string' ||
        (w.worktree !== undefined && typeof w.worktree.checkout_path !== 'string')) throw new Error('Invalid Herdr workspace');
    return w;
  });
}

export async function discoverCheckout(workspace: Workspace, run: Runner = runCommand): Promise<Checkout> {
  let paths: string[];
  if (workspace.worktree) paths = [workspace.worktree.checkout_path];
  else {
    const data = JSON.parse(await run([herdrBin(), 'pane', 'list', '--workspace', workspace.workspace_id]));
    if (!Array.isArray(data.result?.panes)) throw new Error('Invalid Herdr pane list');
    paths = data.result.panes.map((p: { foreground_cwd?: string; cwd?: string }) => p.foreground_cwd || p.cwd)
      .filter((p: unknown): p is string => typeof p === 'string' && p.startsWith('/'));
  }
  const roots = new Set<string>();
  for (const path of new Set(paths)) {
    try {
      roots.add((await run(['git', 'rev-parse', '--show-toplevel'], path)).trim());
    } catch (error) {
      // Non-repository shell panes are ordinary; permissions/missing paths are errors.
      if (!(error instanceof Error) || !error.message.includes('not a git repository')) throw error;
    }
  }
  if (roots.size !== 1) return { skipped: roots.size ? 'Multiple checkout paths; no workspace worktree binding' : 'No Git checkout' };
  const cwd = [...roots][0]!;
  if (!(await run(['git', 'remote'], cwd)).trim()) return { skipped: 'Git checkout has no remote' };
  return { cwd };
}

export async function publishTokens(workspaceId: string, tokens: Tokens, run: Runner = runCommand): Promise<void> {
  const args = [herdrBin(), 'workspace', 'report-metadata', workspaceId, '--source', 'alx-xo.pr-status'];
  for (const name of tokenNames) {
    if (tokens[name] === '') args.push('--clear-token', name);
    else args.push('--token', `${name}=${tokens[name]}`);
  }
  await run(args);
}
