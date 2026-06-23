# GitSpace public skills

This directory is the public-facing skill registry for GitSpace. Each subdirectory is a self-contained **Agent Skill** — a `SKILL.md` with YAML frontmatter (`name`, `description`) plus optional supporting files — that any compliant agent client can install.

These skills are portable planning aids. They do not assume the GitSpace-managed agent runtime, do not require the `/space` slash-command extension, and do not reference internal modules. Individual skills may read Linear data through whatever source the host environment provides.

## Available skills

| Skill | Description |
|---|---|
| [`gitspace-linear-breakdown`](./gitspace-linear-breakdown) | Turn Linear ticket(s) or a Linear project into a machine-readable GitSpace goal-chain `plan.yaml`. Strictly linear chains continue through the clearest useful path and stop only when choosing the next goal would be arbitrary, blocked, or misleading. |

## Install

### Via `skills.sh` / SkillUse

```sh
# discover
npx skills find gitspace-linear-breakdown

# install
npx skills add inKibra/gitspace.sh/gitspace-linear-breakdown
```

### Manual copy

```sh
# Pick the target directory for your agent
#   Claude Code:   ~/.claude/skills/
#   Cursor:        ~/.cursor/skills/
#   Codex:         ~/.codex/skills/
#   Generic:       <repo>/.agents/skills/
TARGET=~/.claude/skills/

curl -L https://github.com/inKibra/gitspace.sh/archive/refs/heads/main.tar.gz \
  | tar -xz --strip-components=2 -C "$TARGET" gitspace.sh-main/skills/gitspace-linear-breakdown
```

Or, if you've cloned this repo:

```sh
cp -r skills/gitspace-linear-breakdown ~/.claude/skills/
```

## Prerequisites for the skills here

- An agent client that supports portable skills.
- Access to the Linear ticket content, through paste, MCP, CLI, or an imported issue document.

## Conventions

- One folder per skill. Folder name matches the `name:` frontmatter.
- `SKILL.md` is the only required file. Optional companions: `README.md`, `scripts/`, `prompts/`, `examples/`.
- Skills here must stay portable. If a skill needs the GitSpace-internal `/space` extension, it belongs in `src/lib/tmux-lite/agents/skills/` (bundled managed defaults), not here.

## Authoring a new skill for this registry

Drop a folder under `skills/<name>/`:

```
skills/<name>/
├── SKILL.md          # required: YAML frontmatter (name, description) + body
├── README.md         # optional: human-facing summary, install + usage
├── scripts/          # optional: helper scripts the skill references
└── examples/         # optional: worked examples
```

`SKILL.md` frontmatter shape:

```yaml
---
name: <kebab-case-name>            # must match folder name
description: <one-paragraph summary that mentions when to use the skill>
---
```

After adding, update the **Available skills** table above. Open a PR.
