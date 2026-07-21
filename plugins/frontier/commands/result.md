---
description: Show the stored final output for a finished frontier delegation job
argument-hint: '[job-id] [--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/frontier-companion.mjs" result $ARGUMENTS`

Present the full command output to the user. Do not summarize or condense it. Preserve job IDs, results, file paths, and any error messages exactly as reported.

Note: arguments are interpolated into a shell command (same pattern as the upstream codex plugin); pass only job ids and documented flags.
