# Release Notes

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
