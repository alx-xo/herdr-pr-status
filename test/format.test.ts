import { expect, test } from 'bun:test';
import { defaults, formatPR, parseConfig } from '../src/format';
import type { PRStatus } from '../src/github';
const pr: PRStatus = { number: 42, url: 'https://github.com/o/r/pull/42', lifecycle: 'draft', checks: { passed: 2, failed: 1, pending: 0, total: 3 }, review: 'approved', threads: 0 };
test('keeps lifecycle, checks and review separate', () => {
  expect(formatPR(pr)).toEqual({ pr: '\uf4dd #42', pr_checks: '\uf467 2/3', pr_review: '\uf49e approved', pr_threads: '' });
});
test('absent PR clears all four tokens', () => expect(Object.values(formatPR(null))).toEqual(['', '', '', '']));
test('terminal lifecycle survives independently of failing checks', () => {
  for (const lifecycle of ['closed', 'merged'] as const) expect(formatPR({ ...pr, lifecycle })).toMatchObject({ pr: `${defaults.icons[lifecycle]} #42`, pr_checks: '\uf467 2/3' });
});
test('unknown differs from known zero', () => {
  expect(formatPR({ ...pr, checks: null, review: null, threads: null })).toMatchObject({ pr_checks: 'checks ?', pr_review: 'review ?', pr_threads: '? threads' });
  expect(formatPR({ ...pr, checks: { passed: 0, failed: 0, pending: 0, total: 0 } }).pr_checks).toBe('no checks');
  expect(formatPR(pr, parseConfig({ hideZeroThreads: false })).pr_threads).toBe('0 threads');
});
test('custom labels, icons and visibility; defaults unchanged', () => {
  const config = parseConfig({ labels: { draft: 'WIP' }, icons: { draft: 'D' }, visible: { pr_checks: false, pr_review: false } });
  expect(formatPR(pr, config)).toMatchObject({ pr: 'D #42 WIP', pr_checks: '', pr_review: '' });
  expect(defaults.labels.draft).toBe('');
});
test('invalid settings fail clearly', () => {
  for (const value of [null, [], { typo: true }, { visible: { pr: 'false' } }, { icons: { draft: '\n' } }, { labels: { nope: '' } }]) expect(() => parseConfig(value)).toThrow();
});


test('empty config uses Nerd Font defaults', () => {
  expect(parseConfig({})).toEqual(defaults);
});
test('nerdFont selects lifecycle, checks and review glyphs', () => {
  const config = parseConfig({});
  expect(formatPR(pr, config)).toEqual({ pr: '\uf4dd #42', pr_checks: '\uf467 2/3', pr_review: '\uf49e approved', pr_threads: '' });
  for (const lifecycle of ['open', 'draft', 'merged', 'closed'] as const) {
    expect(formatPR({ ...pr, lifecycle }, config).pr).toBe(`${defaults.icons[lifecycle]} #42`);
  }
  expect(formatPR({ ...pr, checks: { passed: 2, failed: 0, pending: 1, total: 3 }, review: 'required' }, config))
    .toMatchObject({ pr_checks: '\uf43a 2/3', pr_review: '\uf4af review' });
  expect(formatPR({ ...pr, checks: { passed: 3, failed: 0, pending: 0, total: 3 }, review: 'changes_requested' }, config))
    .toMatchObject({ pr_checks: '\uf42e 3/3', pr_review: '\uf440 changes' });
});
test('explicit icon overrides still work without mutating defaults', () => {
  expect(formatPR(pr, parseConfig({ icons: { draft: 'D', approved: '' } })))
    .toMatchObject({ pr: 'D #42', pr_review: 'approved', pr_checks: '\uf467 2/3' });
  expect(parseConfig({}).icons.draft).toBe('\uf4dd');
});
test('nerdFont preserves absence, unknown, zero and visibility behavior', () => {
  const config = parseConfig({});
  expect(Object.values(formatPR(null, config))).toEqual(['', '', '', '']);
  expect(formatPR({ ...pr, checks: null, review: null, threads: null }, config))
    .toMatchObject({ pr_checks: 'checks ?', pr_review: 'review ?', pr_threads: '? threads' });
  expect(formatPR({ ...pr, checks: { passed: 0, failed: 0, pending: 0, total: 0 } }, config).pr_checks).toBe('no checks');
  expect(formatPR(pr, parseConfig({ visible: { pr: false, pr_checks: false, pr_review: false } })))
    .toEqual({ pr: '', pr_checks: '', pr_review: '', pr_threads: '' });
});
test('removed iconStyle setting is rejected', () => {
  expect(() => parseConfig({ iconStyle: 'nerdFont' })).toThrow('Unknown setting: iconStyle');
});


test('polling interval defaults to 60 seconds and validates bounds', () => {
  expect(parseConfig({}).pollSeconds).toBe(60);
  for (const pollSeconds of [15, 60, 3600]) expect(parseConfig({ pollSeconds }).pollSeconds).toBe(pollSeconds);
  for (const pollSeconds of [0, -1, 14, 3601, 15.5, '60', null, true, NaN, Infinity]) {
    expect(() => parseConfig({ pollSeconds })).toThrow('pollSeconds must be an integer from 15 to 3600');
  }
});
