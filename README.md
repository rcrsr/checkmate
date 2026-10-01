# Checkmate

Automated code quality enforcement for Claude Code. Runs your linters, formatters, and type checkers after every edit. Routes completed subagent work to reviewer agents. Catches errors before they compound.

## Table of Contents

- [Why Checkmate?](#why-checkmate)
- [How It Works](#how-it-works)
- [Installation](#installation)
- [Automatic Configuration](#automatic-configuration)
- [Manual Configuration](#manual-configuration)
- [Predefined Parsers](#predefined-parsers)
- [Tool Guidelines](#tool-guidelines)
- [Agent Delegation](#agent-delegation)
- [Task Reviewers](#task-reviewers)
- [Project Boundaries](#project-boundaries)
- [Git Operations](#git-operations)
- [Bash Writes](#bash-writes)
- [Skills](#skills)
- [Validation](#validation)

## Why Checkmate?

- **Immediate feedback loop.** Claude edits a file → checks run automatically → errors block until fixed. No context lost. No forgotten linting steps.
- **Task review gates.** Subagent completes work → reviewer agent triggered automatically. Map `*-engineer` → `*-reviewer` with wildcard patterns.
- **Monorepo-native.** Different tools per directory. Python API with uv, TypeScript frontend with pnpm, C++ engine with clang-format -all in one config.
- **Zero-config start.** Run `/checkmate:init` and it discovers your toolchain.
- **Works with any tool.** Predefined parsers for common tools. Custom regex parsers for everything else.
- **Respects git operations.** Skips checks during rebase, bisect, and am to avoid corrupting repo state.

## How It Works

When Claude edits a file, the PostToolUse hook fires and loads `.claude/checkmate.json`. Checkmate matches the file path to an environment, retrieves the checks for that extension, and runs each tool in sequence. Output is parsed into structured diagnostics. If errors are found, Claude is blocked until it fixes them. Clean files pass silently.

By default, Checkmate ensures that tools report errors without auto-fixing files. Auto-fix tools desynchronize Claude Code's internal state and cause false positives during non-atomic changes—for example, flagging an unused import before Claude adds the code that uses it.

See this [article](https://andrebremer.com/articles/you-should-be-using-checkmate) for a deep dive.

## Installation

```bash
# From marketplace
/plugin marketplace add rcrsr/claude-plugins
/plugin install checkmate@rcrsr

# Or load locally
claude --plugin-dir /path/to/checkmate
```

## Automatic Configuration

The `checkmate-init` skill discovers your tools and creates `.claude/checkmate.json`. Done.

```
/checkmate:checkmate-init
```

Use `checkmate-refresh` to sync config with installed tools:

```
/checkmate:checkmate-refresh
```

## Manual Configuration

### Simple Project

```json
{
  "environments": [
    {
      "name": "root",
      "paths": ["."],
      "checks": {
        ".py": [
          { "name": "ruff", "command": "uv", "args": ["run", "ruff", "check", "--output-format=concise", "$FILE"], "parser": "ruff" }
        ],
        ".ts,.tsx": [
          { "name": "eslint", "command": "pnpm", "args": ["exec", "eslint", "$FILE"], "parser": "eslint" }
        ]
      }
    }
  ]
}
```

### Monorepo

```json
{
  "environments": [
    {
      "name": "frontend",
      "paths": ["apps/web", "packages/ui"],
      "checks": {
        ".ts,.tsx": [
          { "name": "eslint", "command": "pnpm", "args": ["exec", "eslint", "$FILE"], "parser": "eslint" }
        ]
      }
    },
    {
      "name": "api",
      "paths": ["services/api"],
      "checks": {
        ".py": [
          { "name": "ruff", "command": "uv", "args": ["run", "ruff", "check", "--output-format=concise", "$FILE"], "parser": "ruff" }
        ]
      }
    }
  ]
}
```

First matching environment wins. Put specific paths before general ones.

### Schema Reference

**Environment:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Descriptive label |
| `paths` | Yes | Directories this environment covers |
| `exclude` | No | Glob patterns to skip |
| `checks` | Yes | Extension → check array mapping |
| `agents` | No | Extension → agent name mapping |

**Check:**

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Display name in diagnostics |
| `command` | Yes | Executable to run |
| `args` | Yes | Arguments; `$FILE` = file path |
| `parser` | No | Predefined name or regex object |
| `maxDiagnostics` | No | Max errors shown (default: 5) |
| `_auto` | No | Marks auto-discovered checks (boolean) |

### Custom Parser

For tools without predefined parsers, use a regex with named capture groups:

```json
{
  "name": "golangci-lint",
  "command": "golangci-lint",
  "args": ["run", "$FILE"],
  "parser": {
    "pattern": ":(?<line>\\d+):(?<column>\\d+):\\s*(?<message>.+)",
    "severity": "error"
  }
}
```

Named groups: `line`, `column`, `message`, `rule`, `severity`.

### JSONL Parser (recommended for Custom Tools)

For custom scripts, output JSON Lines for structured diagnostics:

```bash
#!/bin/bash
echo '{"file":"src/app.ts","line":10,"message":"Missing return type"}'
echo '{"file":"src/app.ts","line":25,"column":8,"message":"Unused variable"}'
```

```json
{
  "name": "my-checker",
  "command": "./scripts/my-checker.sh",
  "args": ["$FILE"],
  "parser": "jsonl"
}
```

Required fields: `file`, `line`, `message`. Optional: `column`.

## Predefined Parsers

| Parser | Tools |
|--------|-------|
| `ruff` | ruff check (with `--output-format=concise`) |
| `ty` | ty type checker |
| `eslint` | eslint |
| `oxlint` | oxlint (with `--format=unix --deny-warnings`) |
| `tsc` | TypeScript compiler |
| `prettier` | prettier, oxfmt --check, ruff format --check, biome format |
| `biome` | biome lint |
| `jsonl` | Custom tools with JSON Lines output |
| `gcc` | clang-format, clang-tidy, shellcheck --format=gcc |
| `generic` | Any tool (raw output) |

## Tool Guidelines

**Keep tools fast.** Target <2 seconds per invocation. Avoid whole-project scans on every edit.

| Avoid | Use Instead |
|-------|-------------|
| `tsc` | `tsc-files` or `eslint` with `@typescript-eslint` |
| `mypy` | `mypy --follow-imports=skip` |
| `cargo check` | `clippy` on single file |

**Disable auto-fix.** Use `--check` or `--dry-run` flags. Auto-fix desynchronizes Claude Code's file state.

| Tool | Check-only Flag |
|------|-----------------|
| `ruff format` | `--check` |
| `prettier` | `--check` |
| `oxfmt` | `--check` |
| `rustfmt` | `--check` |
| `clang-format` | `--dry-run -Werror` |

## Agent Delegation

Force file edits through specialist subagents. Main conversation Edit/Write calls are blocked and redirected.

### Basic Setup

```json
{
  "environments": [
    {
      "paths": ["."],
      "checks": {...},
      "agents": {
        ".mjs,.js": "javascript-engineer",
        ".py": "python-engineer"
      }
    }
  ]
}
```

When Claude (main thread) tries to edit `app.js`, Checkmate blocks with:

```
Use javascript-engineer to modify .mjs files.
```

### Extension Patterns

Keys support comma-delimited extensions (same as `checks`):

| Pattern | Matches |
|---------|---------|
| `.py` | `.py` files |
| `.ts,.tsx` | `.ts` and `.tsx` files |
| `.js,.mjs,.cjs` | `.js`, `.mjs`, and `.cjs` files |

### Behavior

- **Main conversation**: Blocked if file extension matches an agent mapping
- **Authorized subagent**: Allowed when `agent_type` matches the configured agent name
- **Other subagents**: Allowed (any subagent can edit)
- **Git operations**: Allowed (delegation skipped during rebase, bisect, etc.)

This encourages structured workflows where the main Claude thread coordinates work by spawning specialist agents rather than editing files directly.

## Task Reviewers

Trigger review agents after subagent Task completions.

### Basic Setup

```json
{
  "environments": [...],
  "tasks": [
    { "name": "skip-tests", "match": "test-engineer", "action": "skip" },
    { "name": "code-review", "match": "*-engineer", "action": "review", "message": "Invoke *-code-reviewer to validate." }
  ]
}
```

### Task Rule Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Rule name shown in output |
| `match` | Yes | Exact subagent name or wildcard pattern |
| `action` | Yes | `skip`, `message` (non-blocking), or `review` (blocking) |
| `message` | Yes* | Message content. *Required for `message` and `review` actions |

### Pattern Matching

Rules evaluate in order: exact matches first, then wildcards in declaration order.

```json
{
  "tasks": [
    { "name": "skip-tests", "match": "test-engineer", "action": "skip" },
    { "name": "ui-review", "match": "frontend-engineer", "action": "review", "message": "Invoke ui-reviewer." },
    { "name": "code-review", "match": "*-engineer", "action": "review", "message": "Invoke *-code-reviewer." }
  ]
}
```

Given `subagent_type: "python-engineer"`:
1. No exact match for "python-engineer"
2. Wildcard `*-engineer` matches, captures `python`
3. Message becomes "Invoke python-code-reviewer."

### Actions

| Action | Behavior | Output |
|--------|----------|--------|
| `skip` | No action | `[checkmate] ✅ <name>` |
| `message` | Non-blocking | `[checkmate] ℹ️ <name>` |
| `review` | Blocking | `[checkmate] 🔍 <name>` |

### Limitation: Background Agents

Task rules apply only to **foreground** agent completions. For background
agents (`run_in_background`, the harness default in recent Claude Code
versions, and remote-isolation agents) the Agent tool returns at launch,
before the subagent has done any work, so checkmate detects the launch and
skips it silently instead of firing a premature review.

Background **completions** cannot trigger task rules today: no documented
parent-thread hook carries `subagent_type` when a background agent finishes.
(`SubagentStop` feeds the subagent, not the parent; an undocumented
`TaskCompleted` event exists in current builds but carries task metadata
only and is unverified for agent completions.) If you rely on `review`
rules, run those agents in the foreground.

## Project Boundaries

Checkmate decides which config owns an edited file by walking up from the file toward the project root. Two markers do separate jobs:

- **`.git` terminates the walk.** It marks a project boundary. On its own it grants no trust and supplies no config.
- **`.claude/checkmate.json` supplies the config.** The nearest one at or above the file wins.

Files resolving outside the project root are skipped, so editing `~/.zshrc` never triggers your project's linters.

When the walk stops at a boundary that ships no config of its own, the boundary type decides what happens:

| Boundary | Own `checkmate.json` | Behavior |
|----------|----------------------|----------|
| Project root | yes | Config applies. The common case. |
| Worktree | yes | Its config applies |
| Worktree | no | Inherits the session config. Same project, different checkout. |
| Nested repo or submodule | yes | Its config applies. The parent's `paths` and `exclude` do not reach in. |
| Nested repo or submodule | no | Skipped. A different project, so parent policy does not apply. |
| Outside project root | n/a | Skipped |

A nested repo that ships its own `checkmate.json` therefore owns its subtree. `$FILE` and the `<reproduce-with>` command are relative to that repo's root, not the parent's.

Symlinks are resolved before any of this, so a symlinked checkout or a symlinked `CLAUDE_PROJECT_DIR` behaves the same as a real path.

## Git Operations

Checkmate skips checks during git operations where unintended Claude Code modifications could corrupt state:

| Operation | Default | Reason |
|-----------|---------|--------|
| `rebase` | disabled | Formatter changes conflict with subsequent patches |
| `am` | disabled | Sequential patch application |
| `bisect` | disabled | Modifications corrupt historical state |
| `merge` | enabled | Single operation |
| `cherryPick` | enabled | Usually single commit |
| `revert` | enabled | Single operation |

Override defaults (`true` = enabled, `false` = disabled):

```json
{
  "git": {
    "rebase": true,
    "cherryPick": false
  },
  "environments": [...]
}
```

## Bash Writes

Shell commands can write files too (`sed -i`, `tee`, `> file.py`). Those writes skip the `Edit|Write` hooks, so the quality checks never see them. The PostToolUse `Bash` hook closes that gap: it detects the write, works out which files changed, and runs the configured checks on them. A failing check blocks, same as an edit. The hook is on by default.

### How detection works

Detection reads the command text only. It never runs the command again and never inspects what a script does.

1. **Skip** if the call is a background command, `bash.enabled` is `false`, or no `checkmate.json` exists.
2. **Match** the command against `writePatterns`. No match, no further work, and the hook prints nothing.
3. **Extract** candidate paths: literal paths in the command that end in a checked extension (any extension with a configured check). Each path resolves against the last `cd` before it.
4. **Filter** paths outside the project, and skip everything while a git operation is in progress (per the `git` settings).
5. **Confirm** with `git status`: a path is checked only if git reports it modified or untracked. Without git, the file only needs to exist.
6. **Check** up to `maxFiles` files with the same per-file checks as an edit.

Because step 3 needs a literal path in the command, the hook sees a write only when the command names the file it writes.

### What is covered

| Write method | Hook result |
|--------------|-------------|
| `sed -i 's/a/b/' src/app.py` | Blocked if the file fails its checks |
| `echo ... >> src/app.py` | Blocked if the file fails its checks |
| `python3 -c "open('src/app.py','a')..."` or a heredoc with the path inline | Blocked if the file fails its checks |
| `cp /tmp/backup.py src/app.py` | Blocked if the file fails its checks |
| `python3 scratch/probe.py`, with the target path only inside the script | **Not detected** (see below) |

Built-in patterns: `sed-inplace`, `perl-inplace`, `python-write`, `node-write`, `redirect`, `tee`, `cp-mv-into-repo`. `redirect` and `cp-mv-into-repo` ignore targets under `/tmp/`, `/dev/`, `/proc/`, `$TMPDIR/`, `${TMPDIR}/`, `~/.claude/`, and `$HOME/.claude/`. A project located under `/tmp`, `/proc` or `~/.claude` has absolute-path writes there ignored by `redirect` and `cp-mv-into-repo`. Only the first 100,000 characters of a command are scanned.

```json
{
  "bash": {
    "enabled": true,
    "maxFiles": 10,
    "writePatterns": [
      { "name": "sponge", "match": "\\bsponge\\s" }
    ]
  },
  "environments": [...]
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Set `false` to turn the hook off |
| `maxFiles` | positive integer | `10` | Maximum files checked per command; the rest are reported as skipped |
| `writePatterns` | array | built-ins | `{ "name", "match" }` entries; `match` is a regex string. A `name` equal to a built-in replaces it; a new `name` adds a pattern. Names must be unique; nested quantifiers are rejected |

Opt out:

```json
{ "bash": { "enabled": false } }
```

### Tuning

To tune patterns against your own history, run `node scripts/checkmate.mjs scan-bash [--transcripts <dir>] [--patterns <file>]`. It replays recorded Bash commands from Claude Code transcripts and prints a JSON report (hits per pattern, timing, missed writes). The `configure-bash-patterns` agent runs this loop for you and saves the kept patterns to `bash.writePatterns`.

### Known limits

The hook cannot catch a write whose target path does not appear in the command text.

**Indirect writes through a script (not detected).** An agent writes a script, then runs it:

```bash
python3 scratch/probe.py        # probe.py opens "src/app.py" for writing
```

The command contains no checked path, so step 3 finds nothing. The file is changed and no check runs. Adding a pattern for the script name does not help, because the path to check is still missing. The same applies to a script that is already in the repo and to any program that decides its own output files, such as `make`, `npm run`, codegen, and formatters with a write mode.

**Other writes that name no literal path (not detected):**

- Paths held in variables, loops, globs or substitutions: `for f in $(...); do sed -i ... "$f"; done`, `sed -i ... $FILE`, `find . -exec ...`, `xargs`.
- Command forms the command-word anchor misses: `sudo cp ...`, `x=1 cp ...`, `time cp ...`.
- Files whose extension has no configured check.
- A redirect glued to its target (`cmd >src/app.py`) matches a pattern, but no path is extracted.

**By design:**

- Only the first 100,000 characters of a command are scanned.
- Past `maxFiles`, the extra files are reported as skipped, not checked.
- Background commands are skipped, since the hook fires before they finish.
- A command that fails does not trigger the PostToolUse hook, so it is not checked.
- Detection is heuristic. A file that was already modified and is only mentioned in a matching command gets checked, which can surface an existing failure.

**Mitigations.** None of these closes the indirect-script gap on its own:

- Tell agents to change files with Edit and Write. A rule in `CLAUDE.md` is the cheapest way to cut Bash writes, and it keeps the quality hooks in the loop.
- Keep pattern coverage current with `scan-bash` and the `configure-bash-patterns` agent. This helps with direct writes only.
- Run the project's own lint and test commands before finishing. They see every changed file, however it was changed.

## Skills

| Skill | Purpose |
|-------|---------|
| `/checkmate:checkmate-init` | Auto-discover tools, generate config |
| `/checkmate:checkmate-refresh` | Sync config with installed tools |

## Validation

Config auto-validates on edit. Manual check:

```bash
node scripts/checkmate.mjs validate .claude/checkmate.json
```
