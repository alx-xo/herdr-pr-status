export type FailureCategory = 'authentication' | 'repository' | 'service' | 'unresolved' | 'unknown';

const guidance: Record<FailureCategory, { reason: string; action: string }> = {
  authentication: { reason: 'GitHub authentication failed.', action: 'Run gh auth status; sign in with gh auth login for the selected host.' },
  repository: { reason: 'Repository is inaccessible or not found.', action: 'Check the push remote and repository access for the account shown by gh auth status.' },
  service: { reason: 'GitHub service, network, or rate limit prevented refresh.', action: 'Check connectivity and GitHub status; retry after any rate limit reset.' },
  unresolved: { reason: 'Git branch or repository could not be resolved.', action: 'Check out a named branch and verify its Git push remote and branch configuration.' },
  unknown: { reason: 'PR refresh failed.', action: 'Retry preview; check Git, gh, and Herdr setup if the failure continues.' },
};

/** Diagnostics never include raw remote URLs or credential-bearing command output. */
export function sanitize(message: string): string {
  return message.replace(/(?:https?|ssh|git):\/\/[^\s'"<>]+|[^\s'"<>]+@[^\s'"<>]+:[^\s'"<>]+/gi, '[redacted URL]')
    .replace(/(authorization\s*[:=]\s*)[^\r\n]*/gi, '$1[redacted]')
    .replace(/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, '[redacted]')
    .replace(/((?:authorization|token|password|secret)\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+/gi, '$1[redacted]')
    .replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 1000);
}

export class LookupError extends Error {
  readonly reason: string;
  readonly action: string;
  constructor(readonly category: FailureCategory, message: string, reason = guidance[category].reason) {
    super(sanitize(message));
    this.name = 'LookupError';
    this.reason = sanitize(reason);
    this.action = guidance[category].action;
  }
}

export function failure(error: unknown, fallback: FailureCategory = 'unknown'): LookupError {
  if (error instanceof LookupError) return error;
  const message = error instanceof Error ? error.message : String(error);
  const category = fallback === 'unresolved' ? fallback : /rate.?limit|\b429\b|\b5\d\d\b|network|timed?\s*out|timeout|connection|dial tcp|ENOTFOUND|ECONN|EAI_AGAIN|TLS/i.test(message) ? 'service'
    : /\b401\b|bad credentials|authentication|not logged|gh auth login|requires authentication|oauth token|token.*(?:expired|invalid)/i.test(message) ? 'authentication'
    : /\b40[34]\b|could not resolve to a repository|repository.*not found|resource not accessible|permission denied/i.test(message) ? 'repository'
    : fallback;
  return new LookupError(category, message);
}
