---
description: Show token and cost usage of frontier delegations
argument-hint: '[--days N] [--model qwen|kimi|deepseek|glm|grok] [--session <id|current>] [--json]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/frontier-companion.mjs" usage $ARGUMENTS`

Present the output without summarizing.
