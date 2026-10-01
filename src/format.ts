import type { PRStatus } from './github';

// Octicons from Nerd Fonts v3.4.0, and single-width, non-emoji Unicode
// symbols for fonts without them.
export const iconSets = {
  nerdFont: {
    open: '\uf407', draft: '\uf4dd', merged: '\uf419', closed: '\uf4dc',
    conflict: '\uf47f', queued: '\uf4db', ready: '\uf427',
    passed: '\uf42e', failed: '\uf467', pending: '\uf43a',
    approved: '\uf49e', changes_requested: '\uf440', required: '\uf4af',
  },
  unicode: {
    open: '\u25c9', draft: '\u25cc', merged: '\u21a6', closed: '\u2298',
    conflict: '\u22a0', queued: '\u22ef', ready: '\u279c',
    passed: '\u2713', failed: '\u2717', pending: '\u25d4',
    approved: '\u2713', changes_requested: '\u2206', required: '\u22a1',
  },
};
type IconSet = keyof typeof iconSets;

export const tokenNames = ['pr', 'pr_checks', 'pr_review', 'pr_threads'] as const;
export type Tokens = Record<(typeof tokenNames)[number], string>;
export const defaults = {
  pollSeconds: 60,
  activePollSeconds: 30,
  visible: { pr: true, pr_checks: true, pr_review: true, pr_threads: true },
  hideZeroThreads: true,
  labels: {
    open: '', draft: '', merged: '', closed: '', conflict: '', queued: '', ready: '',
    approved: 'approved', changes_requested: 'changes', required: 'review',
    threads: 'threads', unknown: '?',
  },
  iconSet: 'nerdFont' as IconSet,
  icons: { ...iconSets.nerdFont },
};
export type Config = typeof defaults;

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

/** Reject typos and bad types instead of silently ignoring user settings. */
export function parseConfig(value: unknown): Config {
  const raw = record(value, 'config');
  const result = structuredClone(defaults);
  // Resolve the icon set first so icon overrides apply on top of it.
  if (Object.hasOwn(raw, 'iconSet')) {
    if (raw.iconSet !== 'nerdFont' && raw.iconSet !== 'unicode') throw new Error('iconSet must be "nerdFont" or "unicode"');
    result.iconSet = raw.iconSet;
    result.icons = { ...iconSets[raw.iconSet] };
  }
  for (const [key, val] of Object.entries(raw)) {
    if (key === 'iconSet') continue;
    if (key === 'pollSeconds' || key === 'activePollSeconds') {
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 15 || val > 3600) throw new Error(`${key} must be an integer from 15 to 3600`);
      result[key] = val;
    } else if (key === 'hideZeroThreads') {
      if (typeof val !== 'boolean') throw new Error('hideZeroThreads must be boolean');
      result.hideZeroThreads = val;
    } else if (key === 'visible' || key === 'labels' || key === 'icons') {
      const target = result[key] as Record<string, string | boolean>;
      for (const [name, setting] of Object.entries(record(val, key))) {
        if (!Object.hasOwn(target, name)) throw new Error(`Unknown setting: ${key}.${name}`);
        if (typeof setting !== typeof target[name]) throw new Error(`Invalid type: ${key}.${name}`);
        if (typeof setting === 'string' && (setting.length > 80 || /[\x00-\x1f\x7f]/.test(setting))) throw new Error(`${key}.${name} must be a single line of at most 80 characters`);
        target[name] = setting as string | boolean;
      }
    } else throw new Error(`Unknown setting: ${key}`);
  }
  return result;
}

export function formatPR(pr: PRStatus | null, config: Config = defaults): Tokens {
  const tokens: Tokens = { pr: '', pr_checks: '', pr_review: '', pr_threads: '' };
  if (!pr) return tokens;
  const { labels, icons } = config;
  const state = pr.merge ?? pr.lifecycle;
  tokens.pr = [icons[state], `#${pr.number}`, labels[state]].filter(Boolean).join(' ');
  const checks = pr.checks;
  tokens.pr_checks = checks === null ? `checks ${labels.unknown}` : checks.total === 0 ? 'no checks'
    : `${checks.failed > 0 ? icons.failed : checks.pending > 0 ? icons.pending : icons.passed} ${checks.passed}/${checks.total}`.trim();
  tokens.pr_review = pr.review === null ? `review ${labels.unknown}`
    : [icons[pr.review], labels[pr.review]].filter(Boolean).join(' ');
  tokens.pr_threads = pr.threads === 0 && config.hideZeroThreads ? '' : `${pr.threads ?? labels.unknown} ${labels.threads}`;
  for (const name of tokenNames) if (!config.visible[name]) tokens[name] = '';
  return tokens;
}
