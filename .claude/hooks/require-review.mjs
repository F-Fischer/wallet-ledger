#!/usr/bin/env node
// PreToolUse hook for the review flow (see CLAUDE.md, Git workflow):
// - Claude opens pull requests only as drafts.
// - Claude never adds the `local-review-ok` label: that label is the user's
//   approval of the local review, and the `review-gate` check needs it to pass.
// Exit 2 blocks the tool call; any unexpected error also blocks (exit 1 would
// let the call through).

const LABEL = 'local-review-ok';

const block = (message) => {
  console.error(message);
  process.exit(2);
};

// A command that starts with gh (or follows ; & | or a subshell), not a mention in text.
const ghCommand = (command, sub) =>
  new RegExp(`(^|[;&|(]\\s*)gh\\s+${sub}\\b`).test(command);

try {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const { tool_name: tool, tool_input: input = {} } = JSON.parse(raw || '{}');
  const command = tool === 'Bash' ? String(input.command ?? '') : '';

  // 1. Pull requests start as drafts.
  if (tool === 'mcp__github__create_pull_request' && input.draft !== true) {
    block('Pull request blocked: open it as a draft (draft: true). See CLAUDE.md, Git workflow.');
  }
  if (ghCommand(command, 'pr\\s+create') && !/\s(--draft|-d)(\s|$)/.test(`${command} `)) {
    block('Pull request blocked: open it as a draft (--draft). See CLAUDE.md, Git workflow.');
  }

  // 2. Only the user adds the approval label.
  const labelTools = ['mcp__github__issue_write', 'mcp__github__update_pull_request'];
  const addsLabel =
    (labelTools.includes(tool) && JSON.stringify(input).includes(LABEL)) ||
    (/(^|[;&|(]\s*)gh\s/.test(command) && command.includes(LABEL));
  if (addsLabel) {
    block(
      `Blocked: the "${LABEL}" label is the user's approval of the local review. ` +
        'Post the review summary on the PR and ask the user to add it.',
    );
  }

  process.exit(0);
} catch (err) {
  block(`Blocked: review hook failed (${err?.message ?? err}).`);
}
