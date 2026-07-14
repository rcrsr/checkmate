# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Quality Hook:** Checks now run only against files the project owns, rooted at the checkout that owns them. A file outside `CLAUDE_PROJECT_DIR` (a sibling repo, a `/tmp` scratchpad) is skipped instead of blocked by an unrelated project's formatter and lint rules. An environment with `"paths": ["."]` previously matched every file on the filesystem, since the empty normalized path short-circuited to a match for any input. Files in a linked git worktree now run from the worktree root, with the correct `cwd`, the correct `node_modules`, and a worktree-relative `$FILE` in `<reproduce-with>`. Agent delegation (PreToolUse) applies the same rule and no longer fires on files the project does not own. ([#8](https://github.com/rcrsr/checkmate/pull/8))
- **Exclude Patterns:** `matchesExcludePattern()` now escapes regex metacharacters. `.` previously acted as a wildcard, so `"../**"` compiled to `/^..\/.*$/` and silently excluded any two-character top-level directory (`ui/`, `db/`, `js/`). ([#8](https://github.com/rcrsr/checkmate/pull/8))

### Changed

- **Submodules:** A submodule or nested repo now owns itself. It must carry its own `.claude/checkmate.json` or no checks run. Previously the parent's config ran against submodule files from the parent's root, resolving `node_modules` and tool config against the wrong checkout. A submodule that relied on the parent's config runs no checks until it gets one. ([#8](https://github.com/rcrsr/checkmate/pull/8))

## [2.3.0] - 2026-07-09

### Added

- **Parsers:** Dedicated `oxlint` parser for `--format=unix` output (`path:line:col: message [Severity/rule]`), emitting structured line/column/rule diagnostics instead of a raw text dump. oxlint checks require `--format=unix --deny-warnings` since warnings exit 0 otherwise and are never reported. `oxfmt --check` maps to the existing `prettier` parser.
- **Skills:** oxlint and oxfmt in init/refresh tool discovery, config examples, and refresh's wrong-invocation-pattern checks.
- **Hooks:** Runtime pre-flight in the PostToolUse quality hook. Path-like commands/args are existence-checked before spawning. Missing `node_modules` paths skip the check with a "run `<manager> install`" hint, with manager inferred from the root lockfile. `MODULE_NOT_FOUND` spawn output also maps to a skip.
- **Quality Hook:** On a failed check, surface a `<reproduce-with>` block echoing the exact command checkmate ran, with `$FILE` resolved to a project-relative path and shell-unsafe arguments quoted. A manual fix reuses the configured invocation (e.g. `shfmt -i 2 -d`) instead of drifting to a tool's defaults.

### Changed

- **npm Environments:** Tools now invoke via the real bin script resolved from each package's `package.json` `bin` field (`node node_modules/<pkg>/<bin-path>`, e.g. `node_modules/eslint/bin/eslint.js`) instead of `npx`. Benchmarked ~3x faster per run (eslint 215ms to 72ms) and never hits the npm registry from a synchronous hook. Detection agent returns a per-tool `bins` map; init/refresh skills build configs from it. Missing tools get a manager-specific install recommendation (`pnpm add -D` / `yarn add -D` / `npm i -D` / `bun add -d`) instead of an `npx` fallback. Works cross-platform since Windows `.bin/` shims are not node-executable but real bin scripts are.

### Fixed

- **Hooks:** "not found - skipping" warnings previously set the failure flag and blocked every edit. Skipped checks are now non-blocking, render as ⊘ in the status line, and surface their reason in the pass message.
- **Parsers:** `ruff check` invocations now pass `--output-format=concise`. Ruff 0.15 changed the default output to a multi-line format the `ruff` parser cannot match, silently degrading diagnostics to the generic raw dump.
- **Task Hook:** Skip background agent launches. `PostToolUse:Agent` fires when the Agent tool returns, which for background agents is at launch, before the subagent has done any work; review rules were emitting blocking errors immediately, once per launched agent in a fan-out. Launches are detected via `tool_input.run_in_background` or a launch status (`async_launched`, `remote_launched`, `teammate_spawned`) in the tool response, verified against the Claude Code 2.1.205 binary. Task rules now apply only to foreground completions; background completions cannot trigger reviews (documented limitation in README). Integrates PR #3 by @tedserbinski with amendments.

## [2.2.5] - 2026-06-10

### Fixed

- **Quality Checks:** Remove "not found" substring guard that silently discarded failing check output containing that phrase (e.g. formatter diffs quoting source lines). Missing-command spawn failures now detected via `ENOENT` error code with a warning diagnostic.

## [2.2.4] - 2026-03-05

### Changed

- **Agent Delegation:** Improve deny message to instruct batching pending changes

## [2.2.3] - 2026-03-05

### Fixed

- **Task Hook:** Pass substituted message to model in `message` action (was discarded)
- **Task Hook:** Fix stale comment referencing "Task" tool name

## [2.2.2] - 2026-03-05

### Fixed

- **Task Hook:** Update matcher and guard from `Task` to `Agent` to match current Claude Code payload

## [2.2.1] - 2026-03-04

### Changed

- **Agent Delegation:** Requires Claude Code v2.1.69+. Uses `agent_type` hook field for subagent detection. Authorized subagent now verified by name match against config.

## [2.2.0] - 2026-01-29

### Added

- **Agent Delegation (Experimental):** Force file edits through specialist subagents
  - New `agents` field in environment config maps extensions to subagent names
  - Main conversation Edit/Write blocked when extension matches; must delegate to specified agent
  - Supports comma-delimited patterns (same as `checks`): `.mjs,.js`
  - Skipped during git operations (same as quality checks)
  - New PreToolUse hook (`pre-tool` subcommand) handles enforcement

## [2.1.2] - 2026-01-29

### Changed

- **BREAKING:** Flip git config boolean logic for intuitive semantics
  - `true` = enabled (run checks)
  - `false` = disabled (skip checks)
- Rename internal `DEFAULT_SKIP_OPERATIONS` to `DEFAULT_GIT_CHECKS`

### Migration

Update `checkmate.json` git overrides - flip boolean values:
```json
// Old (2.1.1): true = skip, false = run
{ "git": { "rebase": false } }

// New (2.1.2): true = run, false = skip
{ "git": { "rebase": true } }
```

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
