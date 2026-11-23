import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// The PreToolUse hook behind the review flow: Claude opens PRs only as drafts and
// never adds the user's approval label.
const HOOK = resolve('.claude/hooks/require-review.mjs');
const LABEL = 'local-review-ok';
const PR = ['gh', 'pr', 'create'].join(' ');

const run = (input: unknown) =>
  spawnSync('node', [HOOK], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
  });
const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
const mcp = (tool: string, input: Record<string, unknown>) => ({
  tool_name: `mcp__github__${tool}`,
  tool_input: input,
});

describe('require-review hook', () => {
  it('ignores unrelated tool calls and mere mentions', () => {
    expect(run(bash('ls')).status).toBe(0);
    expect(run(bash(`grep -rn "${PR}" .`)).status).toBe(0);
    expect(run(bash(`grep -rn ${LABEL} .github`)).status).toBe(0);
  });

  it('allows draft pull requests only', () => {
    expect(run(mcp('create_pull_request', { head: 'x', draft: true })).status).toBe(0);
    expect(run(bash(`git push && ${PR} --draft --fill`)).status).toBe(0);
    expect(run(bash(`${PR} -d --fill`)).status).toBe(0);

    const blocked = run(mcp('create_pull_request', { head: 'x' }));
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('draft');
    expect(run(mcp('create_pull_request', { head: 'x', draft: false })).status).toBe(2);
    expect(run(bash(`${PR} --fill`)).status).toBe(2);
  });

  it('blocks Claude from adding the approval label', () => {
    expect(run(mcp('issue_write', { method: 'update', labels: [LABEL] })).status).toBe(2);
    expect(run(mcp('update_pull_request', { labels: [LABEL] })).status).toBe(2);
    expect(run(bash(`gh pr edit 12 --add-label ${LABEL}`)).status).toBe(2);
    expect(run(mcp('issue_write', { method: 'update', labels: ['docs'] })).status).toBe(0);
  });

  it('blocks instead of failing open when it cannot parse its input', () => {
    expect(run('not json').status).toBe(2);
  });
});
