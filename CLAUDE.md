# checker

Code quality checks plugin. Runs linters/formatters after Edit/Write, blocks on errors.

See [README.md](README.md) for usage and configuration.

## Architecture

```
hooks/
├── hooks.json               # PostToolUse bindings
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

# Validate config
node hooks/validate-config.mjs .claude/checker.json

# Simulate hook
echo '{"tool_input": {"file_path": "test.py"}}' | node hooks/check-code-quality.mjs
```

## Adding Parsers

Add to `parsers` object in `check-code-quality.mjs` and `PREDEFINED_PARSERS` array in `validate-config.mjs`.
