# Release Notes

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
