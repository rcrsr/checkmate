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
| `package-lock.json` | npm | `["node", "<resolved-bin-path>"]` (see "npm: resolve real bin paths" below) |
| `bun.lockb` | bun | `["bun"]` |

**npm: resolve real bin paths (do not use npx)**

npm environments do not use `npx`. `npx` re-resolves the package on every invocation (benchmarked 215ms vs 72ms for a direct `node` call to eslint's bin script), and when a tool is missing locally it falls back to fetching from the npm registry. The quality-check hook that runs these commands is a synchronous `PostToolUse` hook and must never touch the network, so an `npx` fallback is unacceptable at any step.

Instead, resolve the real bin script for each tool directly:

1. For each tool the project's checks reference (e.g. `eslint`, `prettier`), read `node_modules/<pkg>/package.json` with the Read tool (or `node -p "require('./node_modules/<pkg>/package.json').bin"`).
2. Take the `"bin"` field verbatim. It is either a string (`"bin/eslint.js"`) or an object keyed by command name (e.g. `{ "prettier": "bin/prettier.cjs" }`); use the matching entry. Never guess the path yourself, bin file names and extensions vary per package (`eslint` uses `bin/eslint.js`, `prettier` uses `bin/prettier.cjs`).
3. Join it with the package directory to build the real path: `node_modules/<pkg>/<bin-path>`.
4. Record this path in the environment's `"bins"` field (see Field definitions) and use `["node", "<resolved-bin-path>"]` as that tool's exec pattern.
5. If `node_modules` is absent, or `node_modules/<pkg>` does not exist: do not emit any `npx` fallback and do not guess a path. Mark the tool unavailable and recommend installing it via the detected manager, for npm that means `npm install` to install the full dependency tree, or `npm i -D <tool>` to add a single missing tool.
6. For nested environments, the resolved path is relative to that environment's directory. Callers prefix it with the environment path, for example `apps/web/node_modules/eslint/bin/eslint.js`.

This works cross-platform because `node_modules/.bin/<tool>` entries are symlinks on POSIX but `.cmd`/`.ps1` shims on Windows. Reading the package's `"bin"` field and invoking it with `node` directly avoids depending on either shim format.

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
      "javascript": {
        "primary": "npm",
        "exec": ["node", "<resolved-bin-path>"],
        "bins": { "eslint": "node_modules/eslint/bin/eslint.js" }
      },
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
- `exec` - Array of command parts to prepend to tool invocation. For npm, this is `["node", "<resolved-bin-path>"]`, where `<resolved-bin-path>` is the per-tool path from `bins` (the calling skill substitutes the actual tool's entry).
- `bins` - npm only. Object mapping each tool name to its resolved bin script path (`node_modules/<pkg>/<bin-path>`), read from that package's `"bin"` field. Absent for pnpm/yarn/bun/other managers, which use a single static `exec` prefix for every tool.

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
