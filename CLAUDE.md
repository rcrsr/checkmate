This project is a Claude Code plugin. It uses PreToolUse and PostToolUse hooks to enforce agent delegation, run quality checks (Edit/Write), and trigger task reviews (Task).

## Key Files

| File | Purpose |
|------|---------|
| `scripts/checkmate.mjs` | Entry point, routes subcommands |
| `scripts/lib/pre-tool.mjs` | Agent delegation: block main thread, require subagent |
| `scripts/lib/post-tool.mjs` | Quality hook: git detection, check execution, parsers |
| `scripts/lib/post-bash.mjs` | Bash hook: run checks on files a shell command wrote |
| `scripts/lib/scan-bash.mjs` | `scan-bash` CLI: replay transcript Bash commands through the write detector |
| `scripts/lib/post-task.mjs` | Task hook: subagent matching, review triggers |
| `scripts/lib/validate.mjs` | Config schema validation |
| `scripts/lib/lib.mjs` | Shared utilities: config loading, JSON output, `pass()`/`block()`, git-operation detection, bash config validation and write detection, outcome formatting |

## Hook Flow

**Agent delegation:** Edit/Write (PreToolUse) → load config → match extension to `agents` → if main thread and no git op → deny with agent name.

**Quality checks:** Edit/Write (PostToolUse) → load config → detect git state (skip if rebase/bisect/am) → run checks → block on errors.

**Bash writes:** Bash (PostToolUse) → skip if background or `bash.enabled` is `false` → match command against `bash.writePatterns` (defaults merged by name) → extract candidate paths with checked extensions, resolving `cd` → drop paths outside the project → keep paths whose extension the owning config (session, worktree or nested-repo config) checks, plus `checkmate.json` itself → skip if git operation in progress → keep paths git reports dirty (`git --no-optional-locks -c core.fsmonitor= status --porcelain -z --untracked-files=all`) → run checks on up to `bash.maxFiles` files within a 2000 ms budget (the rest are reported as skipped) → block on errors. The hook reads command text only: a write whose target path is not in the command (a script run as `python3 probe.py`, loops, variables, `make`) is not detected. See README "Bash Writes" → Known limits.

**Task review:** Agent completion → skip if background launch (tool returns at launch, nothing to review) → match `subagent_type` against rules → skip/message/review action. Background completions cannot trigger reviews (no parent-thread hook carries `subagent_type`).

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
