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
- [Git Operations](#git-operations)
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
          { "name": "ruff", "command": "uv", "args": ["run", "ruff", "check", "$FILE"], "parser": "ruff" }
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
          { "name": "ruff", "command": "uv", "args": ["run", "ruff", "check", "$FILE"], "parser": "ruff" }
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
| `ruff` | ruff check, ruff format |
| `ty` | ty type checker |
| `eslint` | eslint |
| `tsc` | TypeScript compiler |
| `prettier` | prettier, biome format |
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
| `rustfmt` | `--check` |
| `clang-format` | `--dry-run -Werror` |

## Subagent Delegation (EXPERIMENTAL)

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
- **Subagent context**: Allowed (any subagent can edit, not just the mapped one)
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
