---
description: Show token and cost usage of frontier delegations
argument-hint: '[--details|--health] [--days N] [--model qwen|kimi|deepseek|glm|grok] [--provider openrouter|siliconflow|deepinfra|cerebras] [--session <id|current>] [--limit N] [--json]'
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/frontier-companion.mjs" usage $ARGUMENTS`

Present the output without summarizing.
