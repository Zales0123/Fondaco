# Subagents

Hand-authored subagent definitions, checked in. This directory is the source of truth,
mirroring how `.ai/skills/` owns skill overrides.

Harness directories are ignored (see `.gitignore`), so each clone links the definitions
into the harness it uses:

```bash
mkdir -p .claude/agents && ln -sfn ../../.ai/agents/<name>.md .claude/agents/<name>.md
```

`yarn install-skills` does **not** do this — it only manages skills
(`.ai/skills/` → `.agents/skills/` → `.claude/skills/`). Subagents are linked by hand
until that changes.

## Layout

| Path | Tracked | Role |
|---|---|---|
| `.ai/agents/<name>.md` | yes | the definition |
| `.claude/agents/<name>.md` | no (ignored) | symlink into the Claude Code harness |

## Current agents

| Agent | Purpose |
|---|---|
| `code-quality` | Behaviour-preserving refactoring of changed files to clean-code and TypeScript standards, before commit/PR. Not a bug hunter (`om-troubleshooter`) and not a merge verdict (`om-code-review`). |

A new agent is picked up only after the Claude Code session restarts.
