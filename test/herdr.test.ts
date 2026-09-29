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
test('unresolved lookups publish warnings and do not block the next workspace', async () => {
  const published: string[] = [];
  const run: Runner = async (args, cwd) => {
    if (args[1] === 'workspace' && args[2] === 'list') return JSON.stringify({ result: { workspaces: ['bad', 'empty'].map(id => ({ workspace_id: id, label: id, worktree: { checkout_path: `/${id}` } })) } });
    if (args[1] === 'rev-parse') return cwd!;
    if (args[1] === 'remote') return 'origin';
    if (args[1] === 'branch') { if (cwd === '/bad') throw new Error('Git lookup failed'); return ''; }
    if (args[2] === 'report-metadata') { published.push(args[3]!); return ''; }
    throw new Error(`Unexpected ${args.join(' ')}`);
  };
  expect((await refresh(defaults, false, run)).map(r => r.status)).toEqual(['error', 'error']);
  expect(published).toEqual(['bad', 'empty']);
  published.length = 0;
  expect((await refresh(defaults, true, run)).map(r => r.status)).toEqual(['error', 'error']);
  expect(published).toEqual([]);
});


test('branch switch during lookup never publishes an obsolete result', async () => {
  let branch = 'old';
  let published = false;
  const run: Runner = async args => {
    if (args[1] === 'workspace' && args[2] === 'list') return JSON.stringify({ result: { workspaces: [{ ...workspace, worktree: { checkout_path: '/repo' } }] } });
    if (args[1] === 'rev-parse') return '/repo';
    if (args[1] === 'remote') return args.includes('get-url') ? 'https://github.com/team/repo' : 'origin';
    if (args[1] === 'branch') return branch;
    if (args[1] === 'for-each-ref' || args[1] === 'config') return '';
    if (args[1] === 'repo') return JSON.stringify({ nameWithOwner: 'team/repo', url: 'https://github.com/team/repo' });
    if (args[1] === 'pr') { branch = 'new'; return '[]'; }
    if (args[2] === 'report-metadata') { if (args.includes('--token')) published = true; return ''; }
    throw new Error(`Unexpected ${args.join(' ')}`);
  };
  const result = await refresh(defaults, false, run);
  expect(result[0]?.status).toBe('skipped');
  expect(result[0]?.reason).toContain('Checkout changed');
  expect(result[0]?.stale).toBe(true);
  expect(published).toBe(false);
});

test('targeted refresh avoids all-workspace listing and publishes only its subset', async () => {
  const published: string[] = [];
  const run: Runner = async (args, cwd) => {
    if (args[1] === 'rev-parse') return cwd!;
    if (args[1] === 'remote') return 'origin';
    if (args[1] === 'branch') return ''; // detached: unresolved, no GitHub lookup
    if (args[2] === 'report-metadata') { published.push(args[3]!); return ''; }
    throw new Error(`Unexpected ${args.join(' ')}`);
  };
  const target = { ...workspace, worktree: { checkout_path: '/repo' } };
  expect((await refresh(defaults, false, run, [target])).map(r => r.status)).toEqual(['error']);
  expect(published).toEqual(['w1']);
  expect(await refresh(defaults, false, run, [])).toEqual([]);
});

for (const mode of ['non-git', 'no-remote'] as const) {
  for (const preview of [false, true]) {
    test(`${mode} workspace clears PR noise without GitHub lookup (preview=${preview})`, async () => {
      const published: string[][] = [];
      const run: Runner = async args => {
        if (args[1] === 'pane') return JSON.stringify({ result: { panes: [{ cwd: '/notes' }] } });
        if (args[1] === 'rev-parse') {
          if (mode === 'non-git') throw new Error('fatal: not a git repository');
          return '/notes';
        }
        if (args[1] === 'remote') return '';
        if (args[2] === 'report-metadata') { published.push(args); return ''; }
        throw new Error(`Unexpected ${args.join(' ')}`);
      };
      const state = new Map([['w1', { context: 'old', cwd: '/old', branch: 'main', pr: null, lastSuccessAt: 'old' }]]);
      const [result] = await refresh(defaults, preview, run, [workspace], state);
      expect(result).toMatchObject({ status: 'skipped', reason: mode === 'non-git' ? 'No Git checkout' : 'Git checkout has no remote',
        tokens: { pr: '', pr_checks: '', pr_review: '', pr_threads: '' } });
      expect(result?.category).toBeUndefined();
      expect(published).toHaveLength(preview ? 0 : 1);
      if (!preview) {
        expect(published[0]?.filter(arg => arg === '--clear-token')).toHaveLength(4);
        expect(published[0]).not.toContain('--token');
      }
      expect(state.has('w1')).toBe(preview);
    });
  }
}

for (const change of ['checkout', 'failure'] as const) {
  test(`absence revalidation ${change} never publishes unchecked metadata`, async () => {
    let discoveries = 0;
    const writes: string[][] = [];
    const run: Runner = async args => {
      if (args[1] === 'pane') {
        discoveries++;
        if (discoveries > 1 && change === 'failure') throw new Error('pane lookup failed');
        return JSON.stringify({ result: { panes: [{ cwd: '/notes' }] } });
      }
      if (args[1] === 'rev-parse') {
        if (discoveries === 1) throw new Error('fatal: not a git repository');
        return '/notes';
      }
      if (args[1] === 'remote') return 'origin';
      if (args[2] === 'report-metadata') { writes.push(args); return ''; }
      throw new Error('Unexpected command');
    };
    const [result] = await refresh(defaults, false, run, [workspace]);
    expect(result).toMatchObject({ status: 'skipped', stale: true });
    expect(writes).toEqual([]);
  });
}

for (const remote of ['https://gitlab.com/team/subgroup/repo.git', 'git@bitbucket.org:team/repo.git', 'https://codeberg.org/team/repo.git', 'git@git.sr.ht:~user/repo', '/srv/repo.git', '../repo.git', 'file:///srv/repo.git', '.']) {
  for (const mode of ['normal', 'detached', 'matching', 'mirror', 'refspecs'] as const) {
    for (const preview of [false, true]) {
      test(`non-GitHub remote ${remote} stays quiet (${mode}, preview=${preview})`, async () => {
        const writes: string[][] = [];
        const run: Runner = async args => {
          if (args[1] === 'rev-parse') return '/repo';
          if (args[1] === 'remote') return args.includes('get-url') ? remote : 'origin';
          if (args[1] === 'branch') return mode === 'detached' ? '' : 'main';
          if (args[1] === 'for-each-ref') return '';
          if (args[1] === 'config') {
            const destination = remote === '.' ? 'remote.pushdefault\n.\0' : '';
            const push = mode === 'matching' ? 'push.default\nmatching\0' : mode === 'mirror' ? 'remote.origin.mirror\ntrue\0'
              : mode === 'refspecs' ? 'remote.origin.push\nrefs/heads/a:refs/heads/a\0remote.origin.push\nrefs/heads/b:refs/heads/b\0' : '';
            return destination + push;
          }
          if (args[2] === 'report-metadata') { writes.push(args); return ''; }
          throw new Error(`Unexpected ${args.join(' ')}`);
        };
        const state = new Map([['w1', { context: 'old', cwd: '/old', branch: 'main', pr: null, lastSuccessAt: 'old' }]]);
        const [result] = await refresh(defaults, preview, run, [{ ...workspace, worktree: { checkout_path: '/repo' } }], state);
        expect(result).toMatchObject({ status: 'skipped', tokens: { pr: '', pr_checks: '', pr_review: '', pr_threads: '' } });
        expect(result?.category).toBeUndefined();
        expect(writes).toHaveLength(preview ? 0 : 1);
        expect(writes.every(args => !args.includes('--token'))).toBe(true);
        expect(state.has('w1')).toBe(preview);
      });
    }
  }
}
