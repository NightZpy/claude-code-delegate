---
name: /cc-delegate:analyze
description: Run a cost/spend analysis with full usage details including text/agentic split
---
You are analyzing cc-delegate usage data. Provide a concise management summary, cost recommendations, provider health assessment, and suggestions for model re‑ranking.

The following JSON contains all available usage data since `since` (ISO timestamp or null for all time). Every entry includes a `mode` field (text or agentic) and agentic entries carry extra fields (agent, reasoningTokens, cacheRead, toolCalls, touchedCount, opencodeSessionId). The `byMode` split shows totals for text and agentic calls separately.
