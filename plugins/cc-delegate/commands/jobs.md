---
description: Show every delegation job and what each running one is doing right now
argument-hint: '[--json]'
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" jobs --static $ARGUMENTS`

Present the full command output to the user. Do not summarize or condense it. Preserve job IDs, statuses, activity lines and log lines exactly as reported.

Tell the user that for a live, navigable panel (↑/↓ to select a job, enter to open it, r to reload, q to quit) they can run `cc-delegate jobs` in their own terminal — this captured view is a point-in-time snapshot.
