import { expect, test } from 'bun:test';
import { refresh, type RefreshState } from '../src/refresh';
import { defaults } from '../src/format';
import type { Runner } from '../src/process';

function fixture() {
  let branch = 'feature', repo = 'team/repo', error = '', empty = false;
  let onLookup = () => {};
  const published: string[][] = [];
  const run: Runner = async args => {
    if (args.includes('report-metadata')) { published.push(args); return ''; }
    if (args[1] === 'rev-parse') return '/repo';
    if (args[1] === 'branch') return branch;
    if (args[1] === 'for-each-ref') return '';
    if (args[1] === 'config') return '';
    if (args[1] === 'remote') return args.includes('get-url') ? `https://github.com/${repo}.git` : 'origin';
    onLookup();
    if (error) throw new Error(error);
    if (args[1] === 'repo') return JSON.stringify({ nameWithOwner: repo, url: `https://github.com/${repo}` });
    if (args[1] === 'pr') return JSON.stringify(empty ? [] : [{ number: 42, url: `https://github.com/${repo}/pull/42`,
      state: 'OPEN', isDraft: false, headRefName: branch, headRepository: { name: repo.split('/')[1] },
      headRepositoryOwner: { login: repo.split('/')[0] }, statusCheckRollup: null, reviewDecision: null }]);
    if (args[1] === 'api') return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: null } } } });
    throw new Error('Unexpected command');
  };
  const state: RefreshState = new Map();
  const targets = [{ workspace_id: 'w1', label: 'work', worktree: { checkout_path: '/repo' } }];
  return { published, state, onLookup: (callback: () => void) => { onLookup = callback; }, set: (values: { branch?: string; repo?: string; error?: string; empty?: boolean }) => {
    branch = values.branch ?? branch; repo = values.repo ?? repo; error = values.error ?? error; empty = values.empty ?? empty;
  }, refresh: (preview = false) => refresh(defaults, preview, run, targets, state) };
}

test('same-context failure retains unknown fields and last success with one warning; success clears it', async () => {
  const f = fixture();
  const [first] = await f.refresh();
  expect(first).toMatchObject({ freshness: 'fresh', tokens: { pr: '\uf407 #42', pr_checks: 'checks ?', pr_review: 'review ?', pr_threads: '? threads' } });
  f.set({ error: 'HTTP 401: Bad credentials https://secret@github.com/private?token=secret' });
  const [failed] = await f.refresh();
  expect(failed).toMatchObject({ status: 'error', category: 'authentication', freshness: 'stale', lastSuccessAt: first!.lastSuccessAt,
    tokens: { ...first!.tokens, pr: '\uf407 #42 ⚠' } });
  expect(JSON.stringify(failed)).not.toContain('secret');
  expect((await f.refresh())[0]!.tokens!.pr).toBe('\uf407 #42 ⚠');
  f.set({ error: '', empty: true });
  expect((await f.refresh())[0]).toMatchObject({ freshness: 'fresh', tokens: { pr: '', pr_checks: '', pr_review: '', pr_threads: '' } });
});

for (const change of [{ branch: 'other' }, { repo: 'other/repo' }]) {
  test(`new context ${JSON.stringify(change)} clears old badges before lookup and cannot retain them on failure`, async () => {
    const f = fixture();
    await f.refresh();
    f.published.length = 0;
    f.set({ ...change, error: 'HTTP 503' });
    f.onLookup(() => expect(f.published[0]).toContain('--clear-token'));
    const [result] = await f.refresh();
    expect(result).toMatchObject({ freshness: 'unavailable', category: 'service', tokens: { pr: '⚠', pr_checks: '', pr_review: '', pr_threads: '' } });
    expect(result!.lastSuccessAt).toBeUndefined();
  });
}

test('same-context polling does not publish an in-flight warning and preview never publishes', async () => {
  const f = fixture();
  await f.refresh();
  f.published.length = 0;
  f.onLookup(() => expect(f.published).toEqual([]));
  await f.refresh();
  f.published.length = 0;
  f.set({ error: 'HTTP 503' });
  await f.refresh(true);
  expect(f.published).toEqual([]);
});

test('a context change while GitHub is in flight clears rather than publishing the obsolete result', async () => {
  const f = fixture();
  await f.refresh();
  f.published.length = 0;
  f.onLookup(() => f.set({ branch: 'new' }));
  const [result] = await f.refresh();
  expect(result).toMatchObject({ status: 'skipped', stale: true });
  expect(f.published.at(-1)).toContain('--clear-token');
  expect(f.published.some(args => args.includes('pr=\uf407 #42'))).toBe(false);
});

test('detached branch invalidates prior data and reports an unresolved failure', async () => {
  const f = fixture();
  await f.refresh();
  f.set({ branch: '' });
  const [result] = await f.refresh();
  expect(result).toMatchObject({ category: 'unresolved', freshness: 'unavailable', tokens: { pr: '⚠' } });
  expect(result!.lastSuccessAt).toBeUndefined();
  expect(f.state.size).toBe(0);
});

test('losing the named branch during lookup clears old metadata and does not retain history', async () => {
  const f = fixture();
  await f.refresh();
  f.published.length = 0;
  f.onLookup(() => f.set({ branch: '' }));
  await f.refresh();
  expect(f.state.size).toBe(0);
  expect(f.published.at(-1)).toContain('--clear-token');
});

test('initial metadata publication failure is not misreported as Git resolution failure', async () => {
  const targets = [{ workspace_id: 'w1', label: 'work', worktree: { checkout_path: '/repo' } }];
  const run: Runner = async args => {
    if (args.includes('report-metadata')) throw new Error('Herdr unavailable');
    if (args[1] === 'rev-parse') return '/repo';
    if (args[1] === 'branch') return 'feature';
    if (args[1] === 'for-each-ref' || args[1] === 'config') return '';
    if (args[1] === 'remote') return args.includes('get-url') ? 'https://github.com/team/repo' : 'origin';
    throw new Error('Unexpected lookup');
  };
  expect((await refresh(defaults, false, run, targets))[0]).toMatchObject({ category: 'unknown' });
});
