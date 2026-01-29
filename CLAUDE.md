This project is a Claude Code plugin. It uses PostToolUse hooks to run user-configured (`.claude/checkmate.json`) quality checks (Edit/Write) and task review (Task).

## Key Files

| File | Purpose |
|------|---------|
| `scripts/checkmate.mjs` | Entry point, routes subcommands |
| `scripts/lib/post-tool.mjs` | Quality hook: git detection, check execution, parsers |
| `scripts/lib/post-task.mjs` | Task hook: subagent matching, review triggers |
| `scripts/lib/validate.mjs` | Config schema validation |
| `scripts/lib/lib.mjs` | Shared utilities: config loading, JSON output, `pass()`/`block()` |

## Hook Flow

**Quality checks:** Edit/Write → load config → detect git state (skip if rebase/bisect/am) → run checks → block on errors.

**Task review:** Task completion → match `subagent_type` against rules → skip/message/review action.

## Adding Parsers

1. Add parser function to `parsers` object in `scripts/lib/post-tool.mjs`
2. Add parser name to `PREDEFINED_PARSERS` array in `scripts/lib/validate.mjs`

## Do

- Use `pass()` and `block()` from `lib.mjs` for consistent output format
- Keep check execution under 2 seconds
- Fail open: if detection fails, let checks run
- Test with `node scripts/checkmate.mjs validate` after config changes

## Don't

- Modify files directly (desynchronizes Claude Code's internal state)
- Spawn long-running processes (hooks must complete synchronously)
- Add auto-fix behavior (causes false positives during non-atomic edits)
- Hard-code paths (use `projectRoot` from config loader)
