# refresh

Maintain and update the existing `.claude/checker.json` configuration.

## Instructions

You are helping maintain an existing checker configuration. This command:
1. Validates current config against installed tools
2. Detects newly installed tools
3. Identifies removed or broken tools
4. Suggests config updates

### Step 1: Load Current Config

Read the existing configuration:

```bash
cat .claude/checker.json
```

**If file not found, STOP and warn the user:**

```
No checker configuration found at .claude/checker.json

The /checker:refresh command updates an existing configuration.
To create a new configuration, run /checker:create instead.
```

Do not proceed if no config exists. Direct user to `/checker:create`.

### Step 2: Detect Current Package Managers

Use the `checker:detect-environment` agent to get current invocation patterns.

Compare against config - if package manager changed (e.g., switched from npm to pnpm), suggest updating all tool commands.

### Step 3: Validate Configured Tools

For each check in the config, verify the command exists using the detected exec pattern:

```bash
<exec> <tool> --version 2>/dev/null && echo "<tool> OK" || echo "<tool> MISSING"
```

Report:
- Tools that are configured but missing
- Tools with version changes (if version flags available)
- Tools using wrong invocation pattern (e.g., `npx` when `pnpm exec` should be used)

### Step 4: Discover New Tools

Using the detected invocation pattern, check for tools that aren't in the config:

**JavaScript/TypeScript** (using detected exec pattern):
```bash
<exec> prettier --version 2>/dev/null && echo "prettier available"
<exec> eslint --version 2>/dev/null && echo "eslint available"
<exec> biome --version 2>/dev/null && echo "biome available"
<exec> tsc-files --version 2>/dev/null && echo "tsc-files available"
```

**Note:** Avoid `tsc` - it checks the entire project on every file change. Use `tsc-files` (per-file) or `eslint` with `@typescript-eslint` instead.

**Python** (using detected exec pattern):
```bash
<exec> ruff --version 2>/dev/null && echo "ruff available"
<exec> ty --version 2>/dev/null && echo "ty available"
<exec> mypy --version 2>/dev/null && echo "mypy available"
```

**Go:**
```bash
command -v golangci-lint && golangci-lint --version
command -v staticcheck && staticcheck --version
```

Compare against config - identify tools present but not configured.

### Step 5: Check for File Type Coverage

Find file types in the project:

```bash
# Code files
find . -type f \( -name "*.py" -o -name "*.ts" -o -name "*.tsx" -o -name "*.js" -o -name "*.go" -o -name "*.rs" \) | \
  sed 's/.*\./\./' | sort | uniq -c | sort -rn

# Formatter-compatible files
find . -type f \( -name "*.json" -o -name "*.md" -o -name "*.yaml" -o -name "*.yml" -o -name "*.css" \) | \
  sed 's/.*\./\./' | sort | uniq -c | sort -rn
```

Report file types that exist but have no checks configured. Include formatter-compatible files if prettier or biome is available.

### Step 6: Present Findings

Show the user a summary:

**Status Report:**
- Configured tools: X working, Y missing
- New tools detected: [list]
- Uncovered file types: [list]

**Suggested changes:**
- Remove checks for missing tools: [list]
- Add checks for new tools: [list with proposed config]
- Add coverage for file types: [list]

**Related file types:** If prettier or biome is configured, suggest extending to:
- `.json` - package.json, tsconfig.json, config files
- `.md` - README, documentation
- `.yaml,.yml` - CI configs, docker-compose
- `.css,.scss` - stylesheets (if present in project)

### Step 7: Apply Updates

After user confirmation:

**Critical: Only modify checks with `_auto: true`**

The `_auto` field marks checks that were auto-discovered by `/checker:create`. Checks without this marker are user-added and must never be modified or removed.

1. **Remove broken auto checks:** Delete entries with `_auto: true` for tools that are no longer installed
2. **Add new tools:** Append new check configurations with `_auto: true` (use `/checker:configure-tool` for unfamiliar tools)
3. **Update auto checks:** Modify invocation patterns only for checks with `_auto: true`
4. **Never touch user checks:** Checks without `_auto` marker are always preserved exactly as-is

Write the updated config:

```bash
# Backup first
cp .claude/checker.json .claude/checker.json.bak
```

Then write the new configuration.

### Step 8: Review Changes

**Always ask the user to review changes before finishing:**

Show a structured diff that distinguishes auto vs user checks:

```
Config Changes Summary

PRESERVED (user checks, no _auto marker):
  ✓ .py: custom-linter (user-added, never modified)
  ✓ .go: project-specific-check (user-added, never modified)

AUTO CHECKS - PROPOSED CHANGES:
  + Add: prettier for .ts,.tsx (_auto: true)
  + Add: eslint for .ts,.tsx (_auto: true)
  - Remove: old-linter for .py (tool not found, was _auto: true)
  ~ Update: ruff invocation npm→pnpm (_auto: true)

NO CHANGES:
  = .py: ruff (auto, still valid)

Confirm to apply, or specify changes.
```

Ask:
- Are the suggested additions correct?
- Are the removed checks intentional (tools uninstalled)?
- Are invocation patterns still correct after any package manager changes?

### Step 9: Test Updated Config

After user confirms, test with a sample file:

```bash
# Find a file that matches configured extensions
find . -name "*.py" -o -name "*.ts" | head -1
```

Run one of the updated commands manually to verify it works.

Report success or any issues found.

## Notes

- Always backup before modifying config
- **Only modify checks with `_auto: true`** - user checks (no marker) are never touched
- If a tool moved (e.g., from global to project-local), update the command path for `_auto` checks only
- For tools with major version upgrades, output format may have changed - suggest re-running configure-tool
- Users can remove `_auto: true` from any check to "claim" it and prevent future modifications
