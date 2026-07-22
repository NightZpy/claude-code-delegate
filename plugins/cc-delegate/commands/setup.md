---
description: Check runtime readiness and which frontier provider API keys are configured
argument-hint: ''
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup --json`

Present the setup output to the user. Each provider may include a `quota` object (`monthlyUsd`, `spentThisMonth`, `pct`, `level`) when a monthly spend quota is configured — mention it next to the key status, and flag `level: "warning"`/`"critical"` clearly.

If any required API key (`OPENROUTER_API_KEY`, `SILICONFLOW_API_KEY`, `DEEPINFRA_API_KEY`, `CEREBRAS_API_KEY`) is missing or the result reports `ready: false`:
- **SECURITY: the API key must never pass through this Claude Code terminal.** Do NOT instruct the user to run key setup with a `! ` prefix here, and never ask them to paste a key into this conversation — it would be visible to the model. Tell them to do it in their OWN separate terminal (Terminal / Warp / iTerm), running the link-independent command (works even without `cc-delegate link`):

```
node "$HOME/.claude/plugins/cache/claude-code-delegate/cc-delegate/$(ls ~/.claude/plugins/cache/claude-code-delegate/cc-delegate | sort -t. -k1,1n -k2,2n -k3,3n | tail -1)/scripts/setup-keys.mjs"
```

(or `cc-delegate-keys` if they've linked the CLI). Alternatively they can add `OPENROUTER_API_KEY=sk-or-...` directly to `~/.claude/cc-delegate/.env` (chmod 600). One OpenRouter key covers every model.

- Do not run `setup-keys.mjs` yourself — it is interactive and must be run by the user, outside this session.

The `--json` output has this shape (do not guess other field names):

```json
{
  "ready": true,
  "envFile": "~/.claude/cc-delegate/.env",
  "providers": {
    "openrouter": { "keyPresent": true, "keyHint": "sk-or-v1…faee", "active": true, "quota": { "monthlyUsd": 25, "spentThisMonth": 0.01, "pct": 0, "level": "ok" } }
  }
}
```

`ready` is true when at least one key is present. `active` means the provider serves at least one model in the registry. `quota` appears only when a monthly quota is configured. `keyHint` is masked (never the full key).
