# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.1] - 2026-01-29

### Fixed

- Document `_auto` field in README Check schema table
- Fix `tsc-files` parser references in SKILL.md (use `tsc` parser)
- Update example to use `tsc-files` instead of `tsc` per README guidance
- Standardize skill invocation syntax in README

## [2.1.0] - 2026-01-29

### Added

- Git operation detection: skip quality checks during rebase, am, and bisect to prevent corrupting repo state
- File-based detection using `.git/` state files (rebase-merge, rebase-apply, BISECT_LOG, etc.)
- Worktree support: resolves `.git` file to actual gitdir path
- New `git` config option to override default skip behavior per operation
- System message: `[checkmate] skipped (git <op> in progress)`

### Changed

- Consolidate scripts into single `checkmate.mjs` entry point with subcommands (`post-tool`, `post-task`, `validate`)
- Move implementation files into `scripts/lib/` subfolder
- Extract shared utilities (`getProjectRoot`, `loadConfig`, `readStdinJson`, `outputJson`) into `lib/lib.mjs`
- Extract `pass()` and `block()` output helpers into `lib/lib.mjs`, centralizing `[checkmate]` prefix and exit logic
- Replace subprocess spawn for config validation with direct `validateConfig()` import
- Update `hooks.json` to route through `checkmate.mjs` subcommands
- Refactor commands into skills: `commands/init.md` → `skills/checkmate-init/SKILL.md`, `commands/refresh.md` → `skills/checkmate-refresh/SKILL.md`
- Use `AskUserQuestion` tool in `checkmate-init` for structured user input (test file exclusion, custom checks, coverage gaps, write confirmation)

### Removed

- `checkmate-quality.mjs` (replaced by `lib/post-tool.mjs`)
- `checkmate-review.mjs` (replaced by `lib/post-task.mjs`)
- `validate-config.mjs` (replaced by `lib/validate.mjs`)
- `commands/` directory (replaced by `skills/`)

## [2.0.0] - 2025-01-24

### Added

- New task action system with three modes:
  - `skip`: silent, no action needed
  - `message`: non-blocking informational message
  - `review`: blocking, requires review before continuing
- Emoji-based system messages for quality checks (`✅` pass, `❌` fail per tool)
- Emoji-based system messages for task completions (`✅` skip, `ℹ️` message, `🔍` review)
- Required `name` field for task rules (shown in output)

### Changed

- **BREAKING:** Rename `reviewers` to `tasks` in checkmate.json
- **BREAKING:** `action` field now required with values `skip`, `message`, or `review`
- **BREAKING:** `name` field now required for task rules

### Removed

- **BREAKING:** `reviewer` field from task rules (use `message` field instead)

### Migration

Update `checkmate.json` from:
```json
{
  "reviewers": [
    { "match": "test-engineer", "action": "skip" },
    { "match": "*-engineer", "reviewer": "*-code-reviewer" }
  ]
}
```

To:
```json
{
  "tasks": [
    { "name": "skip-tests", "match": "test-engineer", "action": "skip" },
    { "name": "code-review", "match": "*-engineer", "action": "review", "message": "Invoke *-code-reviewer to validate." }
  ]
}
```

## [1.2.0] - 2025-01-20

### Added

- Task Reviewer system for triggering code review agents after subagent completions
  - Configure `reviewers` array in `checkmate.json` to map subagent types to reviewer agents
  - Exact matches take priority over wildcard patterns
  - Wildcard patterns (`*-engineer`) capture prefix for substitution
  - Use `*` or `$1` in `reviewer` and `message` fields for captured value
  - Use `action: "skip"` to exempt specific agents from review

### Changed

- Rename `check-code-quality.mjs` to `checkmate-quality.mjs` for consistency
- Add `checkmate-review.mjs` hook for Task tool completions
- Update `hooks.json` to include Task matcher

## [1.1.5] - 2025-01-18

### Added

- `gcc` parser for GCC-style output format (`file:line:col: severity: message`)
  - Supports clang-format, clang-tidy, shellcheck --format=gcc, gcc, and similar tools
  - Extracts rule codes from bracketed suffixes (e.g., `[SC2006]`, `[-Wclang-format-violations]`)
- C++ tooling support to `/checkmate:init` (clang-format, clang-tidy, cppcheck)
- Shell script tooling support (shellcheck, shfmt)
- CMakeLists.txt and .clang-format detection in `detect-environment`

## [1.1.4] - 2025-01-15

### Changed

- Add `jsonl` parser to all reference docs (README, init command, configure-tool agent)

## [1.1.3] - 2025-01-14

### Added

- `jsonl` parser for JSON Lines output format
  - Each line: `{"file": "path", "line": 10, "message": "error"}`
  - Optional `column` field (defaults to 1)

### Changed

- Simplify hook output messages
  - Pass: `[checkmate] pass`
  - Fail: `[checkmate] fail: eslint, prettier` (lists failed checks)
  - Excluded path: `[checkmate] excluded`
  - No checks configured: `[checkmate] skipped`
  - No config: `[checkmate] disabled (run /checkmate:init to configure)`

## [1.1.2] - 2025-01-12

### Changed

- Prefix all hook messages with `[checkmate]` for clear attribution

## [1.1.1] - 2025-01-10

### Fixed

- Clarify hook message when file path is excluded from checks
  - Old: `No checks configured for .ts files` (misleading)
  - New: `Skipped: path excluded by "**/*.test.ts"` (shows matched pattern)
- Add distinct message for files outside any configured environment path

## [1.1.0] - 2025-01-08

### Added

- Validation for comma-delimited extension keys in `checkmate.json`
  - Keys like `.ts,.tsx` are now properly validated
  - Each extension in a comma-separated key must start with `.`

### Fixed

- Validator now catches malformed comma-delimited extensions that would fail at runtime

## [1.0.0] - 2025-01-05

### Added

- PostToolUse hook for Edit/Write operations
- Configurable linters and formatters per file extension
- Built-in parsers: ruff, ty, eslint, tsc, prettier, biome, generic
- Custom regex parser support
- Multi-environment support for monorepos
- Schema validation for `checkmate.json`
- `/checkmate:init` command for auto-discovery
- `/checkmate:refresh` command for syncing with installed tools
