---
description: Analyze frontier usage and get cost/health recommendations
argument-hint: '[--days N]'
allowed-tools: Bash(node:*), Agent
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" usage --json $ARGUMENTS`

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" usage --details --limit 50 --json $ARGUMENTS`

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" usage --health --json $ARGUMENTS`

Dispatch exactly one subagent via the `Agent` tool (`model: 'sonnet'`, general-purpose — no special `subagent_type`), passing the three JSON blocks above in the prompt. Ask it for a concise analysis, written in the user's language, covering:

- (a) where the spend goes (by model, provider, session)
- (b) anomalies (unusually large requests, failed runs, high latency)
- (c) provider/model health verdicts (keep/demote/drop), referencing the health WARN thresholds (success% < 80 over ≥5 reqs, p95 latency > 60s, fallback% > 30)
- (d) 3-5 concrete actions to reduce cost (smaller contexts, cheaper model for certain steps, provider reorder)

Present the subagent's analysis verbatim to the user. Do not summarize, rewrite, or add commentary before or after it.

After presenting it, persist it (so `cc-delegate usage`'s Analyze tab can show it later) by running, via the Bash tool, the subagent's analysis text piped into `analysis save`:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" analysis save <<'EOF'
<the subagent's analysis, verbatim>
EOF
```
