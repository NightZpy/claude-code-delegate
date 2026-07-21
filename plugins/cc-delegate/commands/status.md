---
description: Show active and recent frontier delegation jobs for this repository
argument-hint: '[job-id] [--all] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" status $ARGUMENTS`

Present the full command output to the user. Do not summarize or condense it. Preserve job IDs, statuses, and file paths exactly as reported.

Note: arguments are interpolated into a shell command (same pattern as the upstream codex plugin); pass only job ids and documented flags.
