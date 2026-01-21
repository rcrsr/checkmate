---
description: Auto-discover tools and generate checkmate configuration
argument-hint: ""
---

# init

Configure code quality checks for this project by discovering available tools and creating `.claude/checkmate.json`.

## Instructions

You are helping the user set up automated code quality checks. Follow this process:

### Step 0: Check for Existing Config

First, check if a config already exists:

```bash
ls -la .claude/checkmate.json 2>/dev/null
```

**If config exists, STOP and warn the user:**

```
A checkmate configuration already exists at .claude/checkmate.json

Running /checkmate:init will delete the existing config and create a new one.
If you want to update the existing config, run /checkmate:refresh instead.

Do you want to proceed and replace the existing configuration? (yes/no)
```

Only proceed if user explicitly confirms. If they say no, suggest `/checkmate:refresh`.

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

# Check for formatter-compatible files
find . -type f \( -name "*.json" -o -name "*.md" -o -name "*.yaml" -o -name "*.yml" \) | head -1

# Check for package managers and config files
ls package.json pyproject.toml Cargo.toml go.mod 2>/dev/null

# Detect build/temp directories to exclude
ls -d dist build out .next .nuxt coverage __pycache__ .pytest_cache target 2>/dev/null
```

### Step 2: Detect All Environments

Use the `checkmate:detect-environment` agent to scan for all package managers, including nested setups in monorepos.

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
<exec> biome --version 2>/dev/null && echo "biome available"
<exec> tsc-files --version 2>/dev/null && echo "tsc-files available"
```

**Note:** Avoid `tsc` - it checks the entire project on every file change. Use `tsc-files` (per-file) or `eslint` with `@typescript-eslint` instead.

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

Based on discovered tools, file types, and **detected invocation pattern**, propose a `checkmate.json` configuration.

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

**Default excludes:** Always exclude build artifacts and temp directories that exist in the project:
- JavaScript/TypeScript: `dist/**`, `build/**`, `out/**`, `.next/**`, `.nuxt/**`, `coverage/**`
- Python: `__pycache__/**`, `.pytest_cache/**`, `.venv/**`, `*.egg-info/**`
- Rust: `target/**`
- General: `node_modules/**` (already excluded by most tools)

**Matching rule:** First environment in the array that matches wins. Put specific environments before general ones.

**Simple project (single environment):**
```json
{
  "environments": [
    {
      "name": "root",
      "paths": ["."],
      "exclude": ["dist/**", "coverage/**"],
      "checks": {
        ".ts,.tsx": [
          { "name": "prettier", "command": "pnpm", "args": ["exec", "prettier", "--check", "$FILE"], "parser": "prettier", "_auto": true }
        ]
      }
    }
  ]
}
```

**Note:** Only include excludes for directories that actually exist in the project.

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
| `eslint` | ESLint (with `@typescript-eslint` for type checks) | `path:line:col severity message rule` |
| `tsc-files` | tsc-files (per-file TypeScript) | `path(line,col): error TScode: message` |
| `biome` | Biome | `path:line:col rule message` |
| `prettier` | Any format checker | Pass/fail only (non-empty = fail) |
| `jsonl` | JSON Lines output | `{"file":"x.ts","line":10,"message":"err"}` |
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

For unfamiliar tools, use the `checkmate:configure-tool` agent to analyze output and build a regex.

**Common configurations by environment:**

All auto-discovered checks include `"_auto": true` so `/checkmate:refresh` can manage them.

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
      "exclude": ["__pycache__/**", ".pytest_cache/**", ".venv/**"],
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
      "exclude": ["dist/**", "build/**", "coverage/**"],
      "checks": {
        ".ts,.tsx": [
          { "name": "prettier", "command": "npx", "args": ["prettier", "--check", "$FILE"], "parser": "prettier", "_auto": true },
          { "name": "eslint", "command": "npx", "args": ["eslint", "$FILE"], "parser": "eslint", "_auto": true },
          { "name": "tsc-files", "command": "npx", "args": ["tsc-files", "--noEmit", "$FILE"], "parser": "tsc-files", "_auto": true }
        ],
        ".json,.md": [
          { "name": "prettier", "command": "npx", "args": ["prettier", "--check", "$FILE"], "parser": "prettier", "_auto": true }
        ]
      }
    }
  ]
}
```

**Note:** For TypeScript type checking, use `tsc-files` (checks single files) instead of `tsc` (checks entire project). Alternatively, configure `eslint` with `@typescript-eslint` for type-aware linting.

### Step 5: Present and Confirm

Show the user:
1. What file types were detected
2. What tools were found
3. The proposed configuration

**Decision guidance:**
- **biome vs prettier+eslint:** biome is faster but less configurable. Use prettier+eslint for existing configs.
- **maxDiagnostics:** 5 is good default. Increase to 10 for strict projects. Set to 1 for slow tools.
- **Check order:** Format checks first, then lint, then type check (fastest to slowest).
- **Related file types:** Formatters like prettier handle more than code. Recommend adding checks for:
  - `.json` - package.json, tsconfig.json, config files
  - `.md` - README, documentation
  - `.yaml,.yml` - CI configs, docker-compose
  - `.css,.scss` - stylesheets
  - `.html` - templates

Ask the user:
- Are there additional checks they want to add?
- Are there file types or tools we missed?
- Any custom scripts or project-specific checks?
- Should test files be included or excluded? (e.g., `"tests/**"`, `"**/*.test.ts"`)

For unfamiliar tools, offer to use the `checkmate:configure-tool` agent to analyze output and build a parser.

### Step 6: Write Configuration

After user confirmation, create `.claude/checkmate.json` with the agreed configuration.

Ensure the `.claude/` directory exists:
```bash
mkdir -p .claude
```

Then write the configuration file. The validation hook runs automatically and flags any schema errors.

### Step 7: Review Configuration

**Always ask the user to review the generated config before finishing:**

Show the user the complete `.claude/checkmate.json` and ask them to verify:
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

### Step 8: Test Configuration

After user confirms, test with a sample file:
```bash
# Find a sample file and run its checks manually
find . -name "*.py" -o -name "*.ts" | head -1
```

Run one of the configured commands manually to verify it works.

Inform the user that the checkmate hook will now run automatically on file edits. Suggest running `/checkmate:refresh` periodically to keep the config up to date.

## Notes

- The `$FILE` placeholder in args gets replaced with the actual file path
- Comma-separated extensions (e.g., `.ts,.tsx`) apply the same checks to multiple types
- The `parser` field determines how output is parsed into diagnostics
- Use `generic` parser for tools without a specific parser
- `maxDiagnostics` limits output per check (default: 5)
