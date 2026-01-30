This project is a Claude Code plugin. It uses PreToolUse and PostToolUse hooks to enforce agent delegation, run quality checks (Edit/Write), and trigger task reviews (Task).

## Key Files

| File | Purpose |
|------|---------|
| `scripts/checkmate.mjs` | Entry point, routes subcommands |
| `scripts/lib/pre-tool.mjs` | Agent delegation: block main thread, require subagent |
| `scripts/lib/post-tool.mjs` | Quality hook: git detection, check execution, parsers |
| `scripts/lib/post-task.mjs` | Task hook: subagent matching, review triggers |
| `scripts/lib/validate.mjs` | Config schema validation |
| `scripts/lib/lib.mjs` | Shared utilities: config loading, JSON output, `pass()`/`block()` |

## Hook Flow

**Agent delegation:** Edit/Write (PreToolUse) → load config → match extension to `agents` → if main thread and no git op → deny with agent name.

**Quality checks:** Edit/Write (PostToolUse) → load config → detect git state (skip if rebase/bisect/am) → run checks → block on errors.

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
