import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The PreToolUse hook that blocks opening a PR until its commit was reviewed locally.
const HOOK = resolve('.claude/hooks/require-review.mjs');
const PR_CMD = ['gh', 'pr', 'create', '--fill'].join(' ');

describe('require-review hook', () => {
  let repo: string;
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const run = (input: unknown, env: Record<string, string> = {}) =>
    spawnSync('node', [HOOK], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      cwd: repo,
      env: { ...process.env, CLAUDE_PROJECT_DIR: repo, ...env },
      encoding: 'utf8',
    });
  const markReviewed = (sha = git('rev-parse', 'HEAD')) =>
    writeFileSync(join(repo, '.claude', '.review-ok'), `${sha}\n`);
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command } });
  const mcp = (head: string) => ({
    tool_name: 'mcp__github__create_pull_request',
    tool_input: { head },
  });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'review-hook-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    mkdirSync(join(repo, '.claude'));
    writeFileSync(join(repo, '.gitignore'), '.claude/.review-ok\n');
    git('add', '.');
    git('commit', '-qm', 'init');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('ignores unrelated tool calls', () => {
    expect(run(bash('ls')).status).toBe(0);
  });

  it('ignores commands that only mention the PR command', () => {
    expect(run(bash(`grep -rn "${PR_CMD}" .`)).status).toBe(0);
  });

  it('blocks the PR command until HEAD is reviewed, then allows it', () => {
    const blocked = run(bash(PR_CMD));
    expect(blocked.status).toBe(2);
    expect(blocked.stderr).toContain('has not been reviewed');
    markReviewed();
    expect(run(bash(PR_CMD)).status).toBe(0);
    expect(run(bash(`git push && ${PR_CMD}`)).status).toBe(0);
  });

  it('blocks again after a new commit', () => {
    markReviewed();
    writeFileSync(join(repo, 'a.txt'), 'a');
    git('add', '.');
    git('commit', '-qm', 'next');
    expect(run(bash(PR_CMD)).status).toBe(2);
  });

  it('blocks the PR command with uncommitted changes', () => {
    markReviewed();
    writeFileSync(join(repo, 'dirty.txt'), 'x');
    const res = run(bash(PR_CMD));
    expect(res.status).toBe(2);
    expect(res.stderr).toContain('uncommitted changes');
  });

  it('checks the MCP head branch, not local HEAD', () => {
    git('checkout', '-qb', 'feature');
    writeFileSync(join(repo, 'f.txt'), 'f');
    git('add', '.');
    git('commit', '-qm', 'feature');
    markReviewed(git('rev-parse', 'feature'));
    expect(run(mcp('feature')).status).toBe(0);
    expect(run(mcp('owner:feature')).status).toBe(0);

    git('checkout', '-q', 'main');
    git('checkout', '-qb', 'other');
    git('commit', '-q', '--allow-empty', '-m', 'unreviewed');
    git('checkout', '-q', 'feature'); // local HEAD is the reviewed commit
    expect(run(mcp('other')).status).toBe(2);
    expect(run(mcp('missing')).status).toBe(2);
  });

  it('blocks instead of failing open when it cannot run', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'no-repo-'));
    try {
      expect(run(bash(PR_CMD), { CLAUDE_PROJECT_DIR: notRepo }).status).toBe(2);
      expect(run('not json').status).toBe(2);
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
