---
description: Check runtime readiness and which frontier provider API keys are configured
argument-hint: ''
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup --json`

Present the setup output to the user. Each provider may include a `quota` object (`monthlyUsd`, `spentThisMonth`, `pct`, `level`) when a monthly spend quota is configured — mention it next to the key status, and flag `level: "warning"`/`"critical"` clearly.

If any required API key (`OPENROUTER_API_KEY`, `SILICONFLOW_API_KEY`, `DEEPINFRA_API_KEY`, `CEREBRAS_API_KEY`) is missing or the result reports `ready: false`:
- Tell the user to run the interactive key setup themselves, in their own terminal, since it needs their input. Give the link-independent form (works even if they never ran `cc-delegate link`):

```
! node "$(ls -d ~/.claude/plugins/cache/claude-code-delegate/cc-delegate/*/ | tail -1)scripts/setup-keys.mjs"
```

(If they have run `cc-delegate link`, `! cc-delegate-keys` also works.) One OpenRouter key covers every model.

- Do not run `setup-keys.mjs` yourself — it is interactive and must be run by the user.

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
