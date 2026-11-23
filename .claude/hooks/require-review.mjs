#!/usr/bin/env node
// PreToolUse hook: block opening a pull request until the commit it would open
// has been reviewed locally (money-reviewer + /code-review). The review step
// records the reviewed commit in .claude/.review-ok (gitignored); a new commit
// invalidates it. Exit 2 blocks the tool call; any unexpected error also blocks
// (exit 1 would let the PR through).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const block = (message) => {
  console.error(message);
  process.exit(2);
};

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const rev = (cwd, ref) => {
  try {
    return git(cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
  } catch {
    return '';
  }
};

try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw || '{}');

  const isMcp = input.tool_name === 'mcp__github__create_pull_request';
  // Only a command that starts with gh (or follows ; & | or a subshell), not a mention in text.
  const isGh =
    input.tool_name === 'Bash' &&
    /(^|[;&|(]\s*)gh\s+pr\s+create\b/.test(input.tool_input?.command ?? '');
  if (!isMcp && !isGh) process.exit(0);

  const root = git(process.env.CLAUDE_PROJECT_DIR || process.cwd(), 'rev-parse', '--show-toplevel');

  let target;
  if (isMcp) {
    // The PR is opened from a branch on GitHub, not from local HEAD.
    const head = String(input.tool_input?.head ?? '').split(':').pop();
    if (!head) block('Pull request blocked: no head branch given.');
    target = rev(root, `origin/${head}`) || rev(root, head);
    if (!target) {
      block(`Pull request blocked: branch "${head}" not found locally; fetch or push it first.`);
    }
  } else {
    if (git(root, 'status', '--porcelain')) {
      block('Pull request blocked: uncommitted changes. Commit them and review again.');
    }
    target = rev(root, 'HEAD');
  }

  const marker = join(root, '.claude', '.review-ok');
  const reviewed = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '';
  if (reviewed && reviewed === target) process.exit(0);

  block(
    `Pull request blocked: commit ${target.slice(0, 7)} has not been reviewed locally.\n` +
      'Before opening the PR:\n' +
      '  1. Run the money-reviewer agent (if the diff touches src/, migrations/ or money tests).\n' +
      '  2. Run /code-review on the branch diff against main.\n' +
      '  3. Fix what they find, commit, push, and re-run until clean.\n' +
      '  4. Record the reviewed commit: git rev-parse HEAD > .claude/.review-ok\n' +
      'Any new commit after that requires a new review.',
  );
} catch (err) {
  block(`Pull request blocked: review hook failed (${err?.message ?? err}).`);
}
