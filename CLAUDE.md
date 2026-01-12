# checker

Code quality checks plugin. Runs linters/formatters after Edit/Write, blocks on errors.

See [README.md](README.md) for usage and configuration.

## Architecture

```
hooks/
└── hooks.json               # PostToolUse bindings

scripts/
├── check-code-quality.mjs   # Runs checks, parses output
└── validate-config.mjs      # Schema validator

commands/
├── create.md                # /checker:create
└── refresh.md               # /checker:refresh

agents/
├── detect-environment.md    # Package manager detection
└── configure-tool.md        # Parser builder for unknown tools
```

## Hook Flow

1. PostToolUse fires on Edit/Write
2. Loads `.claude/checker.json`, finds matching environment
3. Runs checks via spawnSync, parses output
4. Blocks if errors found, passes silently if clean
5. Self-validates when `.claude/checker.json` is edited

## Testing

```bash
# Load plugin
claude --plugin-dir /path/to/checker
```

Config validation runs automatically when `.claude/checker.json` is edited.

## Tool Selection

Avoid tools that require whole-project analysis on every file change:

| Avoid | Use Instead | Reason |
|-------|-------------|--------|
| `tsc` | `tsc-files` or `eslint` with `@typescript-eslint` | tsc checks entire project; alternatives check single files |
| `mypy` (whole project) | `mypy --follow-imports=skip` | Limits scope to edited file |
| `cargo check` | `clippy` on single file | Faster incremental feedback |

The hook runs after every Edit/Write. Tools taking 2+ seconds per invocation degrade the editing experience.

## Adding Parsers

Add to `parsers` object in `scripts/check-code-quality.mjs` and `PREDEFINED_PARSERS` array in `scripts/validate-config.mjs`.
