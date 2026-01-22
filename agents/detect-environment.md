---
name: detect-environment
description: Detects package managers and environment managers in a project, including nested monorepo setups
tools: Bash, Read
---

# detect-environment

Detect all package managers and environment managers in a project, including nested setups in monorepos.

This agent is called by `/checkmate:init`, `/checkmate:refresh`, and `checkmate:configure-tool` to determine the correct invocation patterns for quality tools.

## Instructions

Scan the project recursively for all environment indicators and return structured JSON with all discovered environments.

### Step 1: Find All Environment Indicators

Search recursively for lockfiles and config files (exclude node_modules, .git, etc.):

```bash
find . -type f \( \
  -name "pnpm-lock.yaml" -o \
  -name "yarn.lock" -o \
  -name "package-lock.json" -o \
  -name "bun.lockb" -o \
  -name "uv.lock" -o \
  -name "poetry.lock" -o \
  -name "Pipfile.lock" -o \
  -name "Cargo.toml" -o \
  -name "go.mod" -o \
  -name "CMakeLists.txt" -o \
  -name ".clang-format" \
\) -not -path "*/node_modules/*" -not -path "*/.git/*" -not -path "*/vendor/*" -not -path "*/.venv/*" -not -path "*/build/*" -not -path "*/cmake-build-*/*" 2>/dev/null
```

### Step 2: Group by Directory

For each found file, extract the directory path. Each unique directory with environment indicators becomes an "environment".

Example finds:
```
./package-lock.json
./apps/web/pnpm-lock.yaml
./services/api/uv.lock
./packages/rust-lib/Cargo.toml
```

Yields environments at: `.`, `apps/web`, `services/api`, `packages/rust-lib`

### Step 3: Detect Manager for Each Environment

For each environment directory, determine the package manager using priority rules:

**JavaScript/TypeScript** (priority: pnpm > yarn > npm > bun):

| Lockfile | Manager | Exec Pattern |
|----------|---------|--------------|
| `pnpm-lock.yaml` | pnpm | `["pnpm", "exec"]` |
| `yarn.lock` | yarn | `["yarn"]` |
| `package-lock.json` | npm | `["npx"]` |
| `bun.lockb` | bun | `["bun"]` |

**Python** (priority: uv > poetry > pipenv > conda):

| Indicator | Manager | Exec Pattern |
|-----------|---------|--------------|
| `uv.lock` | uv | `["uv", "run"]` |
| `poetry.lock` | poetry | `["poetry", "run"]` |
| `Pipfile.lock` | pipenv | `["pipenv", "run"]` |
| `environment.yml` | conda | `["conda", "run", "-n", "<env>"]` |

**Rust:**
| Indicator | Exec Pattern |
|-----------|--------------|
| `Cargo.toml` | `["cargo"]` |

**Go:**
| Indicator | Exec Pattern |
|-----------|--------------|
| `go.mod` | `[]` (direct invocation) |

**C/C++:**
| Indicator | Exec Pattern | Notes |
|-----------|--------------|-------|
| `CMakeLists.txt` | `[]` (direct invocation) | CMake project |
| `.clang-format` | `[]` (direct invocation) | Has formatting config |

**Note:** C++ tools (clang-format, clang-tidy) use direct invocation, but on macOS Homebrew they may require full paths: `/opt/homebrew/opt/llvm/bin/clang-format`

### Step 4: Return Structured JSON

Output all environments as a JSON array:

```json
{
  "environments": [
    {
      "path": ".",
      "javascript": { "primary": "npm", "exec": ["npx"] },
      "python": null,
      "rust": null,
      "go": null,
      "cpp": null
    },
    {
      "path": "apps/web",
      "javascript": { "primary": "pnpm", "exec": ["pnpm", "exec"] },
      "python": null,
      "rust": null,
      "go": null,
      "cpp": null
    },
    {
      "path": "services/api",
      "javascript": null,
      "python": { "primary": "uv", "exec": ["uv", "run"] },
      "rust": null,
      "go": null,
      "cpp": null
    },
    {
      "path": "packages/rust-lib",
      "javascript": null,
      "python": null,
      "rust": { "exec": ["cargo"] },
      "go": null,
      "cpp": null
    }
  ]
}
```

**Field definitions:**
- `path` - Relative path from project root to this environment
- `javascript/python/rust/go/cpp` - Manager info or `null` if not present
- `primary` - The detected manager name
- `exec` - Array of command parts to prepend to tool invocation

## Output Format

Return ONLY the JSON object. No markdown, no explanation. The calling command/agent will parse this output.

## Special Cases

### Nested environments with same language

If `apps/web` has pnpm and `apps/mobile` has yarn, both are separate environments:

```json
{
  "environments": [
    { "path": "apps/web", "javascript": { "primary": "pnpm", "exec": ["pnpm", "exec"] }, ... },
    { "path": "apps/mobile", "javascript": { "primary": "yarn", "exec": ["yarn"] }, ... }
  ]
}
```

### Root + nested (monorepo with workspaces)

Include both root and nested environments. The checkmate will use the most specific match for each file:

```json
{
  "environments": [
    { "path": ".", "javascript": { "primary": "pnpm", "exec": ["pnpm", "exec"] }, ... },
    { "path": "packages/api", "python": { "primary": "uv", "exec": ["uv", "run"] }, ... }
  ]
}
```

### No environments found

```json
{
  "environments": []
}
```

## Error Handling

- Skip directories that cannot be read
- Continue scanning even if some paths fail
- Return empty `environments` array if nothing found

## Examples

**Simple single-language project:**
```json
{
  "environments": [
    {
      "path": ".",
      "javascript": { "primary": "pnpm", "exec": ["pnpm", "exec"] },
      "python": null,
      "rust": null,
      "go": null,
      "cpp": null
    }
  ]
}
```

**C++ project with CMake:**
```json
{
  "environments": [
    {
      "path": ".",
      "javascript": null,
      "python": null,
      "rust": null,
      "go": null,
      "cpp": { "exec": [] }
    }
  ]
}
```

**Full-stack monorepo:**
```json
{
  "environments": [
    {
      "path": ".",
      "javascript": { "primary": "pnpm", "exec": ["pnpm", "exec"] },
      "python": null,
      "rust": null,
      "go": null,
      "cpp": null
    },
    {
      "path": "services/api",
      "javascript": null,
      "python": { "primary": "uv", "exec": ["uv", "run"] },
      "rust": null,
      "go": null,
      "cpp": null
    },
    {
      "path": "services/worker",
      "javascript": null,
      "python": null,
      "rust": null,
      "go": { "exec": [] },
      "cpp": null
    },
    {
      "path": "native/engine",
      "javascript": null,
      "python": null,
      "rust": null,
      "go": null,
      "cpp": { "exec": [] }
    }
  ]
}
```
