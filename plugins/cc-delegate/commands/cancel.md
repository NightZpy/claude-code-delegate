---
description: Cancel an active background frontier delegation job
argument-hint: '[job-id]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" cancel $ARGUMENTS`

Present the full command output to the user. Do not summarize or condense it.

Note: arguments are interpolated into a shell command (same pattern as the upstream codex plugin); pass only job ids and documented flags.
