# create

Configure code quality checks for this project by discovering available tools and creating `.claude/checker.json`.

## Instructions

You are helping the user set up automated code quality checks. Follow this process:

### Step 0: Check for Existing Config

First, check if a config already exists:

```bash
ls -la .claude/checker.json 2>/dev/null
```

**If config exists, STOP and warn the user:**

```
A checker configuration already exists at .claude/checker.json

Running /checker:create will delete the existing config and create a new one.
If you want to update the existing config, run /checker:refresh instead.

Do you want to proceed and replace the existing configuration? (yes/no)
```

Only proceed if user explicitly confirms. If they say no, suggest `/checker:refresh`.

### Step 1: Discover Project Structure

Run these commands to understand the project:

```bash
# Find project root (look for .git, package.json, pyproject.toml, Cargo.toml)
ls -la

# Detect file types in the project
find . -type f -name "*.py" | head -1
find . -type f -name "*.ts" -o -name "*.tsx" | head -1
find . -type f -name "*.js" -o -name "*.jsx" | head -1
find . -type f -name "*.rs" | head -1
find . -type f -name "*.go" | head -1

# Check for package managers and config files
ls package.json pyproject.toml Cargo.toml go.mod 2>/dev/null
```

### Step 2: Detect All Environments

Use the `checker:detect-environment` agent to scan for all package managers, including nested setups in monorepos.

The agent returns an array of environments:
```json
{
  "environments": [
    {
      "path": ".",
      "javascript": { "primary": "pnpm", "exec": ["pnpm", "exec"] },
      "python": null,
      "rust": null,
      "go": null
    },
    {
      "path": "services/api",
      "javascript": null,
      "python": { "primary": "uv", "exec": ["uv", "run"] },
      "rust": null,
      "go": null
    }
  ]
}
```

Use the `exec` array to build tool invocation commands:
- `exec: ["pnpm", "exec"]` → `{ "command": "pnpm", "args": ["exec", "prettier", "--check", "$FILE"] }`
- `exec: ["uv", "run"]` → `{ "command": "uv", "args": ["run", "ruff", "check", "$FILE"] }`
- `exec: []` (empty) → `{ "command": "golangci-lint", "args": ["run", "$FILE"] }`

**For monorepos:** Each environment path needs its own check configuration with the correct invocation pattern.

### Step 3: Discover Available Tools

Using the detected invocation pattern, check which tools are available:

**JavaScript/TypeScript tools** (using detected exec pattern):
```bash
<exec> prettier --version 2>/dev/null && echo "prettier available"
<exec> eslint --version 2>/dev/null && echo "eslint available"
<exec> tsc --version 2>/dev/null && echo "tsc available"
<exec> biome --version 2>/dev/null && echo "biome available"
```

**Python tools** (using detected exec pattern):
```bash
<exec> ruff --version 2>/dev/null && echo "ruff available"
<exec> ty --version 2>/dev/null && echo "ty available"
<exec> mypy --version 2>/dev/null && echo "mypy available"
```

**Rust tools:**
```bash
cargo fmt --version 2>/dev/null && echo "rustfmt available"
cargo clippy --version 2>/dev/null && echo "clippy available"
```

**Go tools:**
```bash
command -v golangci-lint && golangci-lint --version
command -v staticcheck && staticcheck --version
```

**If no tools found:** Suggest installation based on detected environment:
- Python + uv: `uv add --dev ruff`
- Python + pip: `pip install ruff`
- TypeScript + pnpm: `pnpm add -D prettier eslint typescript`
- TypeScript + npm: `npm install -D prettier eslint typescript`
- Go: `go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest`

### Step 4: Build Configuration

Based on discovered tools, file types, and **detected invocation pattern**, propose a `checker.json` configuration.

**Schema (array format):**

```json
{
  "environments": [
    {
      "name": "<environment name>",
      "paths": ["<path1>", "<path2>"],
      "exclude": ["<pattern>"],
      "checks": {
        "<extension>": [
          {
            "name": "<display name>",
            "command": "<executable>",
            "args": ["<arg1>", "$FILE"],
            "parser": "<parser name or object>",
            "maxDiagnostics": 5
          }
        ]
      }
    }
  ]
}
```

**Field definitions:**
- `name` - Optional descriptive name for the environment
- `paths` - Array of paths this environment covers (use `"."` for root)
- `exclude` - Optional array of glob patterns to exclude (e.g., `"**/*.test.ts"`)
- `checks` - Object mapping file extensions to check arrays
- `$FILE` - Placeholder replaced with actual file path at runtime

**Matching rule:** First environment in the array that matches wins. Put specific environments before general ones.

**Simple project (single environment):**
```json
{
  "environments": [
    {
      "name": "root",
      "paths": ["."],
      "checks": {
        ".ts,.tsx": [
          { "name": "prettier", "command": "pnpm", "args": ["exec", "prettier", "--check", "$FILE"], "parser": "prettier", "_auto": true }
        ]
      }
    }
  ]
}
```

**Monorepo (multiple environments):**
```json
{
  "environments": [
    {
      "name": "frontend",
      "paths": ["apps/web", "packages/ui"],
      "checks": {
        ".ts,.tsx": [
          { "name": "prettier", "command": "pnpm", "args": ["exec", "prettier", "--check", "$FILE"], "parser": "prettier", "_auto": true }
        ]
      }
    },
    {
      "name": "api",
      "paths": ["services/api"],
      "checks": {
        ".py": [
          { "name": "ruff", "command": "uv", "args": ["run", "ruff", "check", "$FILE"], "parser": "ruff", "_auto": true }
        ]
      }
    },
    {
      "name": "root",
      "paths": ["."],
      "exclude": ["apps/**", "packages/**", "services/**"],
      "checks": {
        ".md,.json": [
          { "name": "prettier", "command": "pnpm", "args": ["exec", "prettier", "--check", "$FILE"], "parser": "prettier", "_auto": true }
        ]
      }
    }
  ]
}
```

**Important:** Array order matters - first matching environment wins. Put specific environments (like `services/api`) before general ones (like `.`).

**Predefined parsers:**

| Parser | Use For | Output Format |
|--------|---------|---------------|
| `ruff` | Ruff linter | `path:line:col: CODE message` |
| `ty` | ty type checker | Multi-line Rust-style errors |
| `eslint` | ESLint | `path:line:col severity message rule` |
| `tsc` | TypeScript compiler | `path(line,col): error TScode: message` |
| `biome` | Biome | `path:line:col rule message` |
| `prettier` | Any format checker | Pass/fail only (non-empty = fail) |
| `generic` | Fallback | Returns raw output truncated |

**Custom regex parser:** For tools without a predefined parser, use an inline regex with named capture groups:

```json
{
  "name": "my-linter",
  "command": "my-linter",
  "args": ["check", "$FILE"],
  "parser": {
    "pattern": ":(?<line>\\d+):(?<column>\\d+):\\s*(?<message>.+)",
    "severity": "error"
  }
}
```

Named groups: `line`, `column`, `message`, `rule`, `severity` (all optional).

For unfamiliar tools, use the `checker:configure-tool` agent to analyze output and build a regex.

**Common configurations by environment:**

All auto-discovered checks include `"_auto": true` so `/checker:refresh` can manage them.

Python (adapt runner to detected environment):
```json
// uv (uv.lock present)
{ "name": "ruff", "command": "uv", "args": ["run", "ruff", "check", "$FILE"], "parser": "ruff", "_auto": true }

// poetry (poetry.lock present)
{ "name": "ruff", "command": "poetry", "args": ["run", "ruff", "check", "$FILE"], "parser": "ruff", "_auto": true }

// pipenv (Pipfile present)
{ "name": "ruff", "command": "pipenv", "args": ["run", "ruff", "check", "$FILE"], "parser": "ruff", "_auto": true }

// global install or activated venv
{ "name": "ruff", "command": "ruff", "args": ["check", "$FILE"], "parser": "ruff", "_auto": true }
```

TypeScript/JavaScript (adapt runner to detected package manager):
```json
// pnpm (pnpm-lock.yaml present)
{ "name": "eslint", "command": "pnpm", "args": ["exec", "eslint", "$FILE"], "parser": "eslint", "_auto": true }

// npm (package-lock.json present)
{ "name": "eslint", "command": "npx", "args": ["eslint", "$FILE"], "parser": "eslint", "_auto": true }

// yarn (yarn.lock present)
{ "name": "eslint", "command": "yarn", "args": ["eslint", "$FILE"], "parser": "eslint", "_auto": true }

// bun (bun.lockb present)
{ "name": "eslint", "command": "bun", "args": ["eslint", "$FILE"], "parser": "eslint", "_auto": true }
```

Rust (always use cargo):
```json
{ "name": "clippy", "command": "cargo", "args": ["clippy", "--", "-D", "warnings"], "parser": "generic", "_auto": true }
{ "name": "rustfmt", "command": "cargo", "args": ["fmt", "--check"], "parser": "prettier", "_auto": true }
```

Go (direct invocation):
```json
{ "name": "golangci-lint", "command": "golangci-lint", "args": ["run", "$FILE"], "parser": { "pattern": ":(?<line>\\d+):(?<column>\\d+):\\s*(?<message>.+)", "severity": "error" }, "_auto": true }
```

**Full example (Python + uv):**
```json
{
  "environments": [
    {
      "name": "root",
      "paths": ["."],
      "checks": {
        ".py": [
          { "name": "ruff format", "command": "uv", "args": ["run", "ruff", "format", "--check", "$FILE"], "parser": "prettier", "_auto": true },
          { "name": "ruff check", "command": "uv", "args": ["run", "ruff", "check", "$FILE"], "parser": "ruff", "_auto": true },
          { "name": "ty", "command": "uv", "args": ["run", "ty", "check", "$FILE"], "parser": "ty", "_auto": true }
        ]
      }
    }
  ]
}
```

**Full example (TypeScript + npm):**
```json
{
  "environments": [
    {
      "name": "root",
      "paths": ["."],
      "checks": {
        ".ts,.tsx": [
          { "name": "prettier", "command": "npx", "args": ["prettier", "--check", "$FILE"], "parser": "prettier", "_auto": true },
          { "name": "eslint", "command": "npx", "args": ["eslint", "$FILE"], "parser": "eslint", "_auto": true },
          { "name": "tsc", "command": "npx", "args": ["tsc", "--noEmit"], "parser": "tsc", "_auto": true }
        ]
      }
    }
  ]
}
```

### Step 5: Present and Confirm

Show the user:
1. What file types were detected
2. What tools were found
3. The proposed configuration

**Decision guidance:**
- **biome vs prettier+eslint:** biome is faster but less configurable. Use prettier+eslint for existing configs.
- **maxDiagnostics:** 5 is good default. Increase to 10 for strict projects. Set to 1 for slow tools.
- **Check order:** Format checks first, then lint, then type check (fastest to slowest).

Ask the user:
- Are there additional checks they want to add?
- Are there file types or tools we missed?
- Any custom scripts or project-specific checks?

For unfamiliar tools, offer to use the `checker:configure-tool` agent to analyze output and build a parser.

### Step 6: Write Configuration

After user confirmation, create `.claude/checker.json` with the agreed configuration.

Ensure the `.claude/` directory exists:
```bash
mkdir -p .claude
```

Then write the configuration file.

### Step 7: Validate Configuration

Run the validation script to check for errors:

```bash
node $PLUGIN_DIR/hooks/validate-config.mjs .claude/checker.json
```

If validation fails, fix the errors before proceeding. Common issues:
- Missing `$FILE` in args
- Invalid parser name
- Missing required fields (paths, checks)
- Invalid regex in custom parser

### Step 8: Review Configuration

**Always ask the user to review the generated config before finishing:**

Show the user the complete `.claude/checker.json` and ask them to verify:
- Are the environment paths correct for their project structure?
- Are the invocation patterns correct (`pnpm exec` vs `npx` vs `uv run`)?
- Are the file extensions correctly grouped?
- Are there any tools or directories that should be added?

```
Please review the configuration above. Does everything look correct?
- Environment paths match your project structure
- Package managers are detected correctly
- File extensions are grouped appropriately

Reply with any changes needed, or confirm to proceed.
```

### Step 9: Test Configuration

After user confirms, test with a sample file:
```bash
# Find a sample file and run its checks manually
find . -name "*.py" -o -name "*.ts" | head -1
```

Run one of the configured commands manually to verify it works.

Inform the user that the checker hook will now run automatically on file edits. Suggest running `/checker:refresh` periodically to keep the config up to date.

## Notes

- The `$FILE` placeholder in args gets replaced with the actual file path
- Comma-separated extensions (e.g., `.ts,.tsx`) apply the same checks to multiple types
- The `parser` field determines how output is parsed into diagnostics
- Use `generic` parser for tools without a specific parser
- `maxDiagnostics` limits output per check (default: 5)
