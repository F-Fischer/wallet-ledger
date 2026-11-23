#!/usr/bin/env node
// PreToolUse hook: block opening a pull request until the current HEAD has been
// reviewed locally (money-reviewer + /code-review). The review step records the
// reviewed commit in .claude/.review-ok (gitignored); a new commit invalidates it.
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || '{}');

const isPrCreate =
  input.tool_name === 'mcp__github__create_pull_request' ||
  (input.tool_name === 'Bash' && /\bgh\s+pr\s+create\b/.test(input.tool_input?.command ?? ''));
if (!isPrCreate) process.exit(0);

const root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
const head = execSync('git rev-parse HEAD', { encoding: 'utf8', cwd: root }).trim();
const marker = join(root, '.claude', '.review-ok');
const reviewed = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : '';

if (reviewed === head) process.exit(0);

console.error(
  `Pull request blocked: HEAD ${head.slice(0, 7)} has not been reviewed locally.\n` +
    'Before opening the PR:\n' +
    '  1. Run the money-reviewer agent (if the diff touches src/, migrations/ or money tests).\n' +
    '  2. Run /code-review on the branch diff against main.\n' +
    '  3. Fix what they find, commit, and re-run until clean.\n' +
    '  4. Record the reviewed commit: git rev-parse HEAD > .claude/.review-ok\n' +
    'Any new commit after that requires a new review.',
);
process.exit(2);
