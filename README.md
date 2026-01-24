# Checkmate

Automated code quality enforcement for Claude Code. Runs your linters, formatters, and type checkers after every edit. Routes completed subagent work to reviewer agents. Catches errors before they compound.

## Why Checkmate?

**Immediate feedback loop.** Claude edits a file → checks run automatically → errors block until fixed. No context lost. No forgotten linting steps.
**Task review gates.** Subagent completes work → reviewer agent triggered automatically. Map `*-engineer` → `*-reviewer` with wildcard patterns.
**Monorepo-native.** Different tools per directory. Python API with uv, TypeScript frontend with pnpm, C++ engine with clang-format, shell scripts with shellcheck—all in one config.
**Zero-config start.** Run `/checkmate:init` and it discovers your toolchain: detects package managers (pnpm/npm/yarn/bun), environment managers (uv/poetry/pipenv/conda), and available linters.
**Works with any tool.** Predefined parsers for common tools. Custom regex parsers for everything else. If it outputs errors, checkmate can parse it.
**Protects your customizations.** Auto-discovered checks are marked `_auto`. User-added checks are never modified by refresh. Your tweaks survive updates.
**Self-validating config.** Edit `.claude/checkmate.json` and the hook validates the schema instantly. Malformed configs blocked before they break anything.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│  Claude edits file.ts                                           │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  PostToolUse hook fires (Edit/Write)                            │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Load .claude/checkmate.json                                    │
│  Find matching environment by path                              │
│  Get checks for file extension                                  │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│  Run each check (eslint, prettier, etc.)                        │
│  Parse output with configured parser                            │
│  Collect diagnostics                                            │
└──────────────────────────────┬──────────────────────────────────┘
                               ▼
              ┌────────────────┴────────────────┐
              ▼                                 ▼
┌─────────────────────────┐       ┌─────────────────────────┐
│  No errors              │       │  Errors found           │
│  Continue silently      │       │  Block with diagnostics │
└─────────────────────────┘       └─────────────────────────┘
```

The hook runs synchronously after each Edit/Write operation. Checks execute in sequence. First error-producing check blocks further edits until Claude fixes the issue.

## Installation

```bash
# From marketplace
/plugin marketplace add rcrsr/claude-plugins
/plugin install checkmate@rcrsr

# Or load locally
claude --plugin-dir /path/to/checkmate
```

## Quick Start

```
/checkmate:init
```

Discovers your tools, creates `.claude/checkmate.json`. Done.

## Configuration

### Simple Project

```json
{
  "environments": [
    {
      "name": "root",
      "paths": ["."],
      "checks": {
        ".py": [
          { "name": "ruff", "command": "uv", "args": ["run", "ruff", "check", "$FILE"], "parser": "ruff", "_auto": true }
        ],
        ".ts,.tsx": [
          { "name": "eslint", "command": "pnpm", "args": ["exec", "eslint", "$FILE"], "parser": "eslint", "_auto": true }
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
          { "name": "eslint", "command": "pnpm", "args": ["exec", "eslint", "$FILE"], "parser": "eslint", "_auto": true }
        ]
      }
    },
    {
      "name": "api",
      "paths": ["services/api"],
      "checks": {
        ".py": [
          { "name": "ruff", "command": "uv", "args": ["run", "ruff", "check", "$FILE"], "parser": "ruff", "_auto": true }
        ]
      }
    }
  ]
}
```

First matching environment wins. Specific paths before general.

### Schema Reference

**Environment:**
| Field | Required | Description |
|-------|----------|-------------|
| `name` | No | Descriptive label |
| `paths` | Yes | Directories this environment covers |
| `exclude` | No | Glob patterns to skip |
| `checks` | Yes | Extension → check array mapping |

**Check:**
| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Display name in diagnostics |
| `command` | Yes | Executable to run |
| `args` | Yes | Arguments; `$FILE` = file path |
| `parser` | No | Predefined name or regex object |
| `maxDiagnostics` | No | Max errors shown (default: 5) |
| `_auto` | No | Managed by `/checkmate:refresh` |

### Custom Parser

For tools without predefined parsers:

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

### JSONL Parser (Custom Tools)

Building a custom linter or wrapper script? Output JSON Lines for structured diagnostics:

```bash
#!/bin/bash
# my-checker.sh - outputs JSONL
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

JSONL format: one JSON object per line with `file`, `line`, `message` (required) and `column` (optional).

## Predefined Parsers

| Parser | Tools |
|--------|-------|
| `ruff` | ruff check, ruff format |
| `ty` | ty type checker |
| `eslint` | eslint |
| `tsc` | TypeScript compiler |
| `prettier` | prettier, biome format |
| `biome` | biome lint |
| `jsonl` | JSON Lines output tools (preferred for custom tool)|
| `gcc` | clang-format, clang-tidy, shellcheck --format=gcc, gcc |
| `generic` | Any tool (raw output) |

## Task Reviewers

Trigger code review agents after subagent Task completions. Configure reviewers to validate implementation work.

**Note:** Reviewers require manual configuration. Unlike quality checks, `/checkmate:init` does not auto-discover agent pairs—add the `reviewers` array to your config based on your workflow. `/checkmate:refresh` leaves the `reviewers` section untouched.

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
| `match` | Yes | Exact subagent name or wildcard pattern (`*` captures prefix) |
| `action` | Yes | `"skip"`, `"message"` (non-blocking), or `"review"` (blocking) |
| `message` | Yes* | Message content. Supports `*` and `$1` substitution. *Required for `message` and `review` actions |

### Pattern Matching

Rules evaluate in two passes: exact matches first, then wildcards in declaration order.

```json
{
  "tasks": [
    { "name": "skip-tests", "match": "test-engineer", "action": "skip" },
    { "name": "ui-review", "match": "frontend-engineer", "action": "review", "message": "Invoke ui-reviewer to validate." },
    { "name": "code-review", "match": "*-engineer", "action": "review", "message": "Invoke *-code-reviewer to validate." }
  ]
}
```

Given `subagent_type: "python-engineer"`:
1. No exact match for "python-engineer"
2. Wildcard `*-engineer` matches, captures `python`
3. Message becomes "Invoke python-code-reviewer to validate."

### Actions

| Action | Behavior | Output |
|--------|----------|--------|
| `skip` | No action | `[checkmate] ✅ <name>` |
| `message` | Non-blocking | `[checkmate] ℹ️ <name>` |
| `review` | Blocking | `[checkmate] 🔍 <name>` |

## Commands

| Command | Purpose |
|---------|---------|
| `/checkmate:init` | Auto-discover tools, generate config |
| `/checkmate:refresh` | Sync config with installed tools |

## Validation

Config auto-validates on edit. Manual check:

```bash
node hooks/validate-config.mjs .claude/checkmate.json
```
