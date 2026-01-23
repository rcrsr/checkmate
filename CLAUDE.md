# checkmate

Runs linters and formatters after Edit/Write operations. Triggers code review agents after Task completions. Blocks on errors.

## Development

```bash
claude --plugin-dir /path/to/checkmate
```

## Architecture

```
hooks/
└── hooks.json               # PostToolUse bindings (Edit|Write|Task)
scripts/
├── checkmate-quality.mjs    # Quality hook: runs checks, parses output
├── checkmate-review.mjs     # Review hook: triggers reviewer agents
└── validate-config.mjs      # Schema validator for checkmate.json
commands/
├── init.md                  # /checkmate:init - generate config
└── refresh.md               # /checkmate:refresh - sync with installed tools
agents/
├── detect-environment.md    # Detects package managers (pnpm/npm/uv/cargo)
└── configure-tool.md        # Builds parsers for unknown tools
```

## Hook Flow

**Quality checks (Edit/Write):**
1. PostToolUse fires on Edit/Write
2. Loads `.claude/checkmate.json`, matches file to environment
3. Runs checks via spawnSync, parses output
4. Blocks if errors found; passes silently if clean
5. Self-validates when `.claude/checkmate.json` is edited

**Task reviews (Task):**
1. PostToolUse fires on Task completion
2. Loads `.claude/checkmate.json`, gets `reviewers` array
3. Matches `subagent_type` against rules (exact match first, then wildcards)
4. If `action: "skip"` → exits silently
5. If reviewer found → blocks with message to invoke reviewer agent

## Key Files

| File | Responsibility |
|------|----------------|
| `scripts/checkmate-quality.mjs` | Quality hook logic, parser implementations |
| `scripts/checkmate-review.mjs` | Task reviewer hook logic |
| `scripts/validate-config.mjs` | JSON schema validation |

## Adding Parsers

1. Add parser function to `parsers` object in `checkmate-quality.mjs`
2. Add parser name to `PREDEFINED_PARSERS` array in `validate-config.mjs`

## Tool Selection

Avoid whole-project tools that run on every file change:

| Avoid | Use Instead |
|-------|-------------|
| `tsc` | `tsc-files` or `eslint` with `@typescript-eslint` |
| `mypy` | `mypy --follow-imports=skip` |
| `cargo check` | `clippy` on single file |

Target: <2 seconds per tool invocation.
