import { expect, test } from 'bun:test';
import { discoverCheckout, publishTokens } from '../src/herdr';
import { refresh } from '../src/refresh';
import { defaults } from '../src/format';
import type { Runner } from '../src/process';

const workspace = { workspace_id: 'w1', label: 'repo' };
test('prefers bound worktree and normalizes its checkout', async () => {
  const calls: string[][] = [];
  const run: Runner = async args => { calls.push(args); return args[1] === 'remote' ? 'origin\n' : '/repo\n'; };
  expect(await discoverCheckout({ ...workspace, worktree: { checkout_path: '/repo/sub' } }, run)).toEqual({ cwd: '/repo' });
  expect(calls[0]).toEqual(['git', 'rev-parse', '--show-toplevel']);
});
test('unbound panes must identify one checkout, not an arbitrary pane', async () => {
  const run: Runner = async (args, cwd) => args[1] === 'pane' ? JSON.stringify({ result: { panes: [{ cwd: '/a' }, { cwd: '/b' }] } }) : `${cwd}\n`;
  expect((await discoverCheckout(workspace, run)).skipped).toContain('Multiple');
});
test('subdirectory panes deduplicate to one Git root', async () => {
  const run: Runner = async args => args[1] === 'pane' ? JSON.stringify({ result: { panes: [{ cwd: '/repo/a' }, { cwd: '/repo/b' }] } }) : args[1] === 'remote' ? 'origin\n' : '/repo\n';
  expect(await discoverCheckout(workspace, run)).toEqual({ cwd: '/repo' });
});
test('non-Git panes skip; failed Git access does not pretend absence', async () => {
  const run: Runner = async args => {
    if (args[1] === 'pane') return JSON.stringify({ result: { panes: [{ cwd: '/home' }] } });
    throw new Error('fatal: not a git repository');
  };
  expect((await discoverCheckout(workspace, run)).skipped).toBe('No Git checkout');
  await expect(discoverCheckout({ ...workspace, worktree: { checkout_path: '/missing' } }, async () => { throw new Error('permission denied'); })).rejects.toThrow('permission denied');
});
test('publishes all owned fields, clears hidden values, leaves other tokens alone', async () => {
  let actual: string[] = [];
  await publishTokens('w1', { pr: '#42 OPEN', pr_checks: '', pr_review: 'approved', pr_threads: '' }, async args => { actual = args; return ''; });
  expect(actual.slice(1)).toEqual(['workspace', 'report-metadata', 'w1', '--source', 'alx-xo.pr-status', '--token', 'pr=#42 OPEN', '--clear-token', 'pr_checks', '--token', 'pr_review=approved', '--clear-token', 'pr_threads']);
});
test('lookup failure preserves metadata and does not block the next workspace', async () => {
  const published: string[] = [];
  const run: Runner = async (args, cwd) => {
    if (args[1] === 'workspace' && args[2] === 'list') return JSON.stringify({ result: { workspaces: ['bad', 'empty'].map(id => ({ workspace_id: id, label: id, worktree: { checkout_path: `/${id}` } })) } });
    if (args[1] === 'rev-parse') return cwd!;
    if (args[1] === 'remote') return 'origin';
    if (args[1] === 'branch') { if (cwd === '/bad') throw new Error('Git lookup failed'); return ''; }
    if (args[2] === 'report-metadata') { published.push(args[3]!); return ''; }
    throw new Error(`Unexpected ${args.join(' ')}`);
  };
  expect((await refresh(defaults, false, run)).map(r => r.status)).toEqual(['error', 'published']);
  expect(published).toEqual(['empty']);
  published.length = 0;
  expect((await refresh(defaults, true, run)).map(r => r.status)).toEqual(['error', 'preview']);
  expect(published).toEqual([]);
});


test('branch switch during lookup never publishes an obsolete result', async () => {
  let branchReads = 0;
  let published = false;
  const run: Runner = async args => {
    if (args[1] === 'workspace' && args[2] === 'list') return JSON.stringify({ result: { workspaces: [{ ...workspace, worktree: { checkout_path: '/repo' } }] } });
    if (args[1] === 'rev-parse') return '/repo';
    if (args[1] === 'remote') return 'origin';
    // Start detached (confirmed no branch PR), switch to main before publishing.
    if (args[1] === 'branch') return ++branchReads < 3 ? '' : 'main';
    if (args[2] === 'report-metadata') { published = true; return ''; }
    throw new Error(`Unexpected ${args.join(' ')}`);
  };
  const result = await refresh(defaults, false, run);
  expect(result[0]?.status).toBe('skipped');
  expect(result[0]?.reason).toContain('Branch changed');
  expect(result[0]?.stale).toBe(true);
  expect(published).toBe(false);
});

test('targeted refresh avoids all-workspace listing and publishes only its subset', async () => {
  const published: string[] = [];
  const run: Runner = async (args, cwd) => {
    if (args[1] === 'rev-parse') return cwd!;
    if (args[1] === 'remote') return 'origin';
    if (args[1] === 'branch') return ''; // detached: no GitHub lookup
    if (args[2] === 'report-metadata') { published.push(args[3]!); return ''; }
    throw new Error(`Unexpected ${args.join(' ')}`);
  };
  const target = { ...workspace, worktree: { checkout_path: '/repo' } };
  expect((await refresh(defaults, false, run, [target])).map(r => r.status)).toEqual(['published']);
  expect(published).toEqual(['w1']);
  expect(await refresh(defaults, false, run, [])).toEqual([]);
});
