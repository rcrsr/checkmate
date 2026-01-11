# checker

A Claude Code plugin.

## Development

To test locally:
```bash
claude --plugin-dir ~/projects/rcrsr/checker
```

## Architecture

```
checker/
├── .claude-plugin/plugin.json   # Plugin manifest
├── hooks/
│   └── hooks.json               # Hook event bindings
├── agents/                      # Subagent definitions
└── commands/                    # Slash commands
```
