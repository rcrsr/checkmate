# checker

Runs linters and formatters after Edit/Write operations. Blocks on errors.

## Development

```bash
claude --plugin-dir /path/to/checker
```

## Architecture

```
hooks/
└── hooks.json               # PostToolUse bindings (Edit|Write)
scripts/
├── check-code-quality.mjs   # Core hook: runs checks, parses output
└── validate-config.mjs      # Schema validator for checker.json
commands/
├── create.md                # /checker:create - generate config
└── refresh.md               # /checker:refresh - sync with installed tools
agents/
├── detect-environment.md    # Detects package managers (pnpm/npm/uv/cargo)
└── configure-tool.md        # Builds parsers for unknown tools
```

## Hook Flow

1. PostToolUse fires on Edit/Write
2. Loads `.claude/checker.json`, matches file to environment
3. Runs checks via spawnSync, parses output
4. Blocks if errors found; passes silently if clean
5. Self-validates when `.claude/checker.json` is edited

## Key Files

| File | Responsibility |
|------|----------------|
| `scripts/check-code-quality.mjs` | Main hook logic, parser implementations |
| `scripts/validate-config.mjs` | JSON schema validation |

## Adding Parsers

1. Add parser function to `parsers` object in `check-code-quality.mjs`
2. Add parser name to `PREDEFINED_PARSERS` array in `validate-config.mjs`

## Tool Selection

Avoid whole-project tools that run on every file change:

| Avoid | Use Instead |
|-------|-------------|
| `tsc` | `tsc-files` or `eslint` with `@typescript-eslint` |
| `mypy` | `mypy --follow-imports=skip` |
| `cargo check` | `clippy` on single file |

Target: <2 seconds per tool invocation.
