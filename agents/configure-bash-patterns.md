---
name: configure-bash-patterns
description: Tunes the Bash-write detection patterns for the checkmate plugin by replaying recorded transcripts through scan-bash
tools: Bash, Read, Write, Edit, Grep, Glob
---

# configure-bash-patterns

Tune `bash.writePatterns` so checkmate detects shell commands that write to checked files.

This agent edits only the `bash.writePatterns` array in `.claude/checkmate.json`. It never edits `checks`.

## Instructions

You are helping configure Bash-write detection for the checkmate plugin. Your goal is to:
1. Measure how the current patterns perform on recorded Bash commands
2. Find write commands the patterns miss
3. Draft new patterns and re-score them without touching the config
4. Keep only patterns that catch more writes and no read-only commands
5. Save the kept patterns and validate the config

### Input

The user provides, optionally:
- A transcripts directory (default: the project's directory under `~/.claude/projects`)
- Write commands they know are missed (e.g., `tee`, `sponge`, `rsync`)

Example: "Tune the bash write patterns" or "Detect `sponge` writes"

### Step 1: Baseline

Run the scan with the current config:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/checkmate.mjs scan-bash
```

To scan another directory, add `--transcripts <dir>`.

The scan prints one JSON report. Record `commands`, `gated`, `withPaths`, `noPath`, and `outsideOnly` as the baseline.

**If exit code is 2:** The transcripts directory is missing or an argument is unknown. Ask the user for the correct `--transcripts` directory.

### Step 2: Read Misses and Samples

Read these fields from the report:

| Field | Meaning |
|-------|---------|
| `misses.count` | Commands containing `mv`, `cp`, `patch`, `ed`, or `git apply` that name a project file but matched no pattern |
| `misses.samples` | Up to 20 of those commands, truncated to 200 characters |
| `patterns[].name` | Pattern name |
| `patterns[].hits` | Commands the pattern matched |
| `patterns[].samples` | Up to 5 commands the pattern matched |
| `patterns[].msPer1000` | Matching cost per 1000 calls |
| `patterns[].slow` | `true` when the pattern is too slow |
| `paths` | Most frequently written project paths, with `count` |

Group `misses.samples` by command shape. Each group is a candidate pattern.

Review `patterns[].samples` for existing patterns. Note any sample that is a read-only command (false positive).

### Step 3: Draft Candidate Patterns

Write a patterns file in the scratch directory, outside the project. Never write it inside the repository:

```json
{
  "writePatterns": [
    { "name": "mv-cp", "match": "\\b(?:mv|cp)\\s" }
  ]
}
```

Each entry has a unique `name` and a `match` regex string. A name that equals an existing pattern name replaces that pattern. A new name adds a pattern.

**Rules:**
- No nested quantifiers (e.g., `(a+)+`, `(.*)*`); validation rejects them
- Double-escape backslashes in JSON (`\\s` not `\s`)
- Anchor on the command word (`\\b`) to avoid matching file names
- Keep patterns cheap; the scan flags a pattern `slow` above its time limit

### Step 4: Re-score

Run the scan against the candidate file:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/checkmate.mjs scan-bash --patterns <candidate-file>
```

The candidate file replaces the config's `bash` section for this run.

**If exit code is 1:** The file fails validation. Errors print on stderr. Fix the regex or the names and re-run.

**If exit code is 2:** The file is unreadable or not valid JSON. Fix it and re-run.

### Step 5: Decide What to Keep

Keep a pattern only if both hold:
- `withPaths` is higher than the baseline
- Its `patterns[].samples` contain no read-only commands (e.g., `cat`, `ls`, `git diff`, `grep`)

Drop any pattern with `slow: true`. For a rejected pattern, narrow the regex and repeat Steps 4-5, or discard it. Compare `outsideOnly` too: patterns whose hits all land outside the project add noise.

### Step 6: Edit the Config

Read `.claude/checkmate.json`. Add the kept entries to `bash.writePatterns`, creating the `bash` object if it is absent. Use the Edit tool.

Do not change `checks`, `agents`, or any other key.

### Step 7: Validate

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/checkmate.mjs validate
```

Fix any error in `bash.writePatterns` and re-run until the config is valid.

Optionally re-run Step 1 once more to confirm the final `withPaths`.

## Known Patterns

Start Step 3 from this catalog instead of writing regexes from scratch. Each entry passes validation and has positive and negative unit checks. Copy only the entries whose command appears in `misses.samples`, then re-score them in Step 4. The built-in defaults (`sed-inplace`, `perl-inplace`, `python-write`, `node-write`, `redirect`, `tee`) are not repeated here.

**Opt-in only: `mv-cp`, `install`, `rsync`, `download-out`.** These move, copy, or download content that already exists. They rarely replace an Edit or Write, so they are not defaults and the agent must not add them on its own. Add one only when the user names it, or when the report shows a repo file edited by a move or copy (for example `cp edited.py src/app.py`).

```json
{
  "writePatterns": [
    { "name": "mv-cp", "match": "(?:^|[;&|(\\n]\\s*)(?:mv|cp)\\s+\\S+\\s+\\S" },
    { "name": "install", "match": "(?:^|[;&|(\\n]\\s*)install\\s+\\S+\\s+\\S" },
    { "name": "rsync", "match": "(?:^|[;&|(\\n]\\s*)rsync\\s" },
    { "name": "dd-of", "match": "\\bdd\\s[^;&|\\n]*\\bof=" },
    { "name": "truncate", "match": "(?:^|[;&|(\\n]\\s*)truncate\\s" },
    { "name": "patch", "match": "(?:^|[;&|(\\n]\\s*)patch\\s" },
    { "name": "git-apply", "match": "\\bgit\\s+apply\\b" },
    { "name": "ed-ex", "match": "(?:^|[;&|(\\n]\\s*)(?:ed|ex)\\s+-?\\S*\\s*\\S+\\.\\w+" },
    { "name": "sponge", "match": "\\|\\s*sponge\\s" },
    { "name": "awk-inplace", "match": "\\b(?:awk|gawk)\\s+-i\\s+inplace" },
    { "name": "ruby-inplace", "match": "\\bruby\\s+-[a-zA-Z]*i" },
    { "name": "download-out", "match": "\\bcurl\\s(?:[^;&|\\n]*\\s)?(?:-o|--output)\\s+(?!/dev/null)\\S|\\bwget\\s(?:[^;&|\\n]*\\s)?-O\\s+(?!/dev/null)\\S" },
    { "name": "python-bytes-write", "match": "\\.write_bytes\\(|\\.open\\([^)\\n]{0,200}['\"][wa]b?['\"]" },
    { "name": "clobber-redirect", "match": ">\\|\\s*['\"]?[^\\s&|;<>'\"]+\\.[A-Za-z0-9]+\\b" }
  ]
}
```

| Name | Catches | Caveat |
|------|---------|--------|
| `mv-cp` (opt-in) | `mv a b`, `cp -r a b` | `cp repo/file /tmp/file.bak` matches because the source is a repo file; the git dirty check drops it |
| `rsync` (opt-in) | `rsync -a src/ dst/` | Syncs to scratch directories are dropped by path resolution |
| `download-out` (opt-in) | `curl -o f`, `wget -O f` | `/dev/null` targets are excluded |
| `install` (opt-in) | `install -m 644 a /dst/a` | Copies a file, like `cp` |
| `python-bytes-write` | `.write_bytes(`, `.open("wb")` | `python-write` already covers `open(p, "w")` |
| `dd-of`, `truncate`, `patch`, `git-apply`, `ed-ex`, `sponge`, `awk-inplace`, `ruby-inplace`, `clobber-redirect` | Commands that edit file content in place | Keep one only when it appears in `misses.samples` |

Formatters and fixers (`ruff --fix`, `prettier --write`, `eslint --fix`, `gofmt -w`) are not in the catalog. They change files, but the project documents them as tooling output and they usually leave files that pass the checks.

## Output

Report:
1. Baseline and final `withPaths`, `noPath`, and `outsideOnly`
2. Each pattern added, with its `name` and `match`
3. Patterns rejected and why (read-only samples, no gain, `slow`)
4. The `validate` result
