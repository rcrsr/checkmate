# Release Notes

## 1.2.0

### Features

- Add Task Reviewer system for triggering code review agents after subagent completions
  - Configure `reviewers` array in `checkmate.json` to map subagent types to reviewer agents
  - Exact matches take priority over wildcard patterns
  - Wildcard patterns (`*-engineer`) capture prefix for substitution
  - Use `*` or `$1` in `reviewer` and `message` fields for captured value
  - Use `action: "skip"` to exempt specific agents from review
  - Default message: "Task review required. Invoke the $REVIEWER subagent to validate the work."

### Changes

- Rename `check-code-quality.mjs` to `checkmate-quality.mjs` for consistency
- Add `checkmate-review.mjs` hook for Task tool completions
- Update `hooks.json` to include Task matcher

## 1.1.5

### Features

- Add `gcc` parser for GCC-style output format (`file:line:col: severity: message`)
  - Supports clang-format, clang-tidy, shellcheck --format=gcc, gcc, and similar tools
  - Extracts rule codes from bracketed suffixes (e.g., `[SC2006]`, `[-Wclang-format-violations]`)

### Documentation

- Add C++ tooling support to `/checkmate:init`
  - clang-format, clang-tidy, cppcheck discovery and configuration
  - macOS Homebrew LLVM path notes (`/opt/homebrew/opt/llvm/bin/`)
  - Full C++ project example configuration
- Add shell script tooling support
  - shellcheck with `--format=gcc` for parseable output
  - shfmt for format checking
- Update `detect-environment` to detect C++/CMake projects
  - Detects CMakeLists.txt and .clang-format as project indicators
- Improve subagent invocation wording in commands
  - Use "subagent" terminology for clearer delegation patterns

## 1.1.4

### Documentation

- Add `jsonl` parser to all reference docs (README, init command, configure-tool agent)

## 1.1.3

### Features

- Add `jsonl` parser for JSON Lines output format
  - Each line: `{"file": "path", "line": 10, "message": "error"}`
  - Optional `column` field (defaults to 1)

### Improvements

- Simplify hook output messages
  - Pass: `[checkmate] pass`
  - Fail: `[checkmate] fail: eslint, prettier` (lists failed checks)
  - Excluded path: `[checkmate] excluded`
  - No checks configured: `[checkmate] skipped`
  - No config: `[checkmate] disabled (run /checkmate:init to configure)`

## 1.1.2

### Improvements

- Prefix all hook messages with `[checkmate]` for clear attribution

## 1.1.1

### Fixes

- Clarify hook message when file path is excluded from checks
  - Old: `No checks configured for .ts files` (misleading)
  - New: `Skipped: path excluded by "**/*.test.ts"` (shows matched pattern)
- Add distinct message for files outside any configured environment path

## 1.1.0

### Features

- Add validation for comma-delimited extension keys in `checkmate.json`
  - Keys like `.ts,.tsx` are now properly validated
  - Each extension in a comma-separated key must start with `.`
  - Invalid keys like `.ts,tsx` now produce clear error messages

### Fixes

- Validator now catches malformed comma-delimited extensions that would fail at runtime

## 1.0.0

Initial release.

- PostToolUse hook for Edit/Write operations
- Configurable linters and formatters per file extension
- Built-in parsers: ruff, ty, eslint, tsc, prettier, biome, generic
- Custom regex parser support
- Multi-environment support for monorepos
- Schema validation for `checkmate.json`
- `/checkmate:init` command for auto-discovery
- `/checkmate:refresh` command for syncing with installed tools
