# Contributing

PRs are welcome — bug fixes, provider additions, monitoring improvements, docs.

## Dev setup

1. Clone the repo.
2. Add it as a local marketplace and install the plugin from your working copy:
   ```
   /plugin marketplace add /path/to/claude-code-delegate
   /plugin install cc-delegate@claude-code-delegate
   ```
3. Iterate: edit files under `plugins/cc-delegate/`, reload the plugin (or restart Claude Code) to pick up changes, and re-test the affected command(s).

## Ground rules

- **Zero npm dependencies.** The runtime is Node's standard library only — no `package.json`, no `node_modules`. Keep it that way.
- **Match existing style.** No reformatting, no drive-by refactors of code you're not touching.
- **`// ponytail:` comments mark deliberate shortcuts.** Leave them as-is unless your change specifically addresses the shortcut; don't "clean them up" in passing.
- **JSON output contracts are frozen, additive-only.** Every `--json` shape (and the ledger's JSONL record shape) is consumed by scripts, the TUI, and orchestrators. You may add new fields; you may not rename, remove, or change the type of an existing field.

## Testing expectations

- `node --check <file>` on anything you edit, at minimum.
- Interactive flows (`setup-keys.mjs`, the `usage` TUI) need a PTY to test properly — use `script -q` (or an equivalent pseudo-terminal wrapper), not a plain pipe, since pipes short-circuit TTY-only code paths.
- Use a temp `HOME` (e.g. `HOME=$(mktemp -d)`) for anything that touches `~/.claude/cc-delegate/` — never point tests at a real `~/.claude/cc-delegate/`, since that's where a real user's keys, quotas, and usage ledger live.

## Versioning

- Semantic versioning. Bump `plugins/cc-delegate/.claude-plugin/plugin.json` and the matching entry in `.claude-plugin/marketplace.json` together — they must never drift.
- Conventional commit messages (`feat:`, `fix:`, `chore:`, ...).
- Add an entry to [CHANGELOG.md](./CHANGELOG.md) for any user-visible change.

## PR checklist

- [ ] If you touched a `--json` path: confirm the existing shape is unchanged (only additions), and paste before/after output in the PR description.
- [ ] No raw ANSI escape codes leak into piped/non-TTY output.
- [ ] No secrets, personal API keys, or personal filesystem paths anywhere in the diff.
- [ ] `plugin.json` and `marketplace.json` versions bumped together, if applicable.
- [ ] CHANGELOG.md updated, if applicable.
