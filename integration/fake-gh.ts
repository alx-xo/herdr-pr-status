import { appendFileSync } from 'node:fs';
const url = 'https://github.com/integration/fixture';
const fields = 'number,url,state,isDraft,headRefName,headRepository,headRepositoryOwner,updatedAt,statusCheckRollup,reviewDecision,reviewRequests,mergeable,mergeStateStatus,autoMergeRequest';
// Independent fixture contract copied from the documented gh query shape, not
// imported from the production parser (a parser regression must fail the test).
const query = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      mergeQueueEntry { state }
      reviewThreads(first: 100, after: $cursor) {
        nodes { isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;
export function fakeGh(args: string[]): unknown {
  // Compare the small read-only contract semantically: positionals retain their
  // order; option/value pairs and JSON fields do not. Unknown/duplicate options
  // remain in the comparison and therefore cannot widen the allowlist.
  const canonical = (argv: string[]) => {
    const positionals: string[] = [];
    const options: string[] = [];
    for (let i = 2; i < argv.length; i++) {
      const arg = argv[i]!;
      if (!arg.startsWith('-')) { positionals.push(arg); continue; }
      let value = argv[++i];
      if (value === undefined) throw new Error('Unexpected gh invocation');
      if (arg === '--json') value = value.split(',').sort().join(',');
      if (arg === '-f' && value.startsWith('query=')) {
        // Tokenize rather than deleting whitespace: `pull Request` must not
        // accidentally become the allowed `pullRequest` operation.
        value = JSON.stringify(value.match(/[_A-Za-z][_0-9A-Za-z]*|[0-9]+|[^\s]/g));
      }
      options.push(JSON.stringify([arg, value]));
    }
    return JSON.stringify([argv.slice(0, 2), positionals, options.sort()]);
  };
  const actual = canonical(args);
  const matches = (expected: string[]) => actual === canonical(expected);
  if (matches(['repo', 'view', 'github.com/integration/fixture', '--json', 'nameWithOwner,url,parent'])) {
    return { nameWithOwner: 'integration/fixture', url, parent: null };
  }
  if (matches(['pr', 'list', '--repo', url, '--state', 'all', '--head', 'integration-branch', '--limit', '100', '--json', fields])) {
    return [{ number: 42, url: `${url}/pull/42`, state: 'OPEN', isDraft: false,
      headRefName: 'integration-branch', headRepository: { name: 'fixture' },
      headRepositoryOwner: { login: 'integration' }, updatedAt: '2026-01-01T00:00:00Z',
      statusCheckRollup: [{}], reviewDecision: 'APPROVED', reviewRequests: [],
      mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED', autoMergeRequest: null }];
  }
  if (matches(['pr', 'checks', '42', '--repo', url, '--json', 'state,workflow,event,link'])) {
    return [{ state: 'SUCCESS', workflow: 'CI', event: 'pull_request', link: `${url}/actions/runs/1/job/1` }];
  }
  if (matches(['api', 'graphql', '--hostname', 'github.com', '-f', `query=${query}`, '-f', 'owner=integration', '-f', 'name=fixture', '-F', 'number=42'])) {
    return { data: { repository: { pullRequest: { mergeQueueEntry: null, reviewThreads: {
      nodes: [{ isResolved: false }, { isResolved: true }], pageInfo: { hasNextPage: false, endCursor: null },
    } } } } };
  }
  throw new Error('Unexpected gh invocation');
}
if (import.meta.main) {
  try {
    const value = fakeGh(process.argv.slice(2));
    console.log(JSON.stringify(value));
  } catch {
    appendFileSync(`${process.env.HOME}/gh-rejected`, 'Unexpected gh invocation\n');
    console.error('Unexpected gh invocation');
    process.exitCode = 1;
  }
}
