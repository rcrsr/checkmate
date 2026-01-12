---
name: configure-tool
description: Analyzes linting/formatting tool output and creates parser configurations for the checker plugin
tools: Bash, Read, Glob, Grep
---

# configure-tool

Analyze a linting/formatting tool's output and create a parser configuration.

This agent creates parser configs for use with the checker plugin. Run `/checker:create` after to integrate the config.

## Instructions

You are helping configure a code quality tool for the checker plugin. Your goal is to:
1. Run the tool on a sample file to capture its output format
2. Analyze the output structure
3. Create a parser config (predefined or custom regex)
4. Test the regex against sample output

### Input

The user provides:
- Tool name and command (e.g., `golangci-lint run`)
- File extension it applies to (e.g., `.go`)
- Optionally: a sample file path to test with

Example: "Configure golangci-lint for .go files" or "Add mypy checker for Python"

### Step 1: Find a Sample File

If no sample file provided, find one:
```bash
find . -name "*.<ext>" -type f | head -1
```

### Step 2: Run the Tool and Capture Output

Run the tool to see its output format. Use timeout to prevent hangs:

```bash
timeout 10s <command> <sample-file> 2>&1 | head -50
```

**If command not found:** Check if tool is installed. Suggest installation command or package manager.

**If tool passes (no output):** Try:
- Running on the whole project instead of single file
- Using a verbose/debug flag (e.g., `--verbose`, `-v`)
- Creating a temporary file with intentional issues (syntax error, unused import)

**If output is empty or minimal:** The tool may use JSON output by default. Check for `--format text` or similar flags.

### Step 3: Analyze Output Format

Look for patterns in the output. Common formats:

| Format | Example | Regex Pattern |
|--------|---------|---------------|
| `file:line:col: message` | `main.go:10:5: undefined` | `:(?<line>\d+):(?<column>\d+):\s*(?<message>.+)` |
| `file:line: message` | `main.go:10: error here` | `:(?<line>\d+):\s*(?<message>.+)` |
| `file(line,col): message` | `main.ts(10,5): error` | `\((?<line>\d+),(?<column>\d+)\):\s*(?<message>.+)` |
| `[severity] message (rule)` | `[error] bad code (no-eval)` | `\[(?<severity>\w+)\]\s*(?<message>.+)\s*\((?<rule>[^)]+)\)` |

Check if output matches a predefined parser:

| Parser | Expected Format | Example |
|--------|-----------------|---------|
| `ruff` | `path:line:col: CODE message` | `main.py:10:5: E501 Line too long` |
| `ty` | `error[rule]: msg` + `--> path:line:col` | Multi-line Rust-style |
| `eslint` | `path:line:col severity message rule` | `app.ts:5:1 error msg no-console` |
| `tsc` | `path(line,col): error TScode: message` | `app.ts(5,1): error TS2304: msg` |
| `biome` | `path:line:col rule message` | `app.ts:5:1 lint/style msg` |
| `prettier` | Pass/fail only (no structured diagnostics) | Any non-empty output = fail |
| `generic` | Fallback - returns raw output truncated | Use when no pattern matches |

### Step 4: Build Custom Regex (if needed)

If no predefined parser matches, create an inline regex with named capture groups:

```json
{
  "parser": {
    "pattern": ":(?<line>\\d+):(?<column>\\d+):\\s*(?<message>.+)",
    "severity": "error"
  }
}
```

**Named groups (all optional):**
- `line` - Line number (parsed as integer)
- `column` - Column number (parsed as integer)
- `message` - Error/warning message
- `rule` - Rule/code identifier
- `severity` - "error" or "warning"

**Important:** Double-escape backslashes in JSON (`\\d` not `\d`).

**Severity inference:** If output includes `error:` or `warning:` prefixes, add `(?<severity>error|warning)` to the pattern. Otherwise, hardcode severity in the parser object.

### Step 5: Test the Regex

Test the regex against captured output using Node.js:

```bash
# Single line test
node -e "
const pattern = /:(?<line>\\d+):(?<column>\\d+):\\s*(?<message>.+)/;
const line = 'main.go:10:5: undefined variable';
const match = line.match(pattern);
console.log(match?.groups);
"

# Multi-line test (paste full output)
node -e "
const pattern = /:(?<line>\\d+):(?<column>\\d+):\\s*(?<message>.+)/;
const output = \`
main.go:10:5: undefined variable
main.go:15:1: unused import
\`;
output.trim().split('\\n').forEach(line => {
  const match = line.match(pattern);
  if (match) console.log('MATCH:', match.groups);
});
"
```

**Note:** Most patterns match single lines. If diagnostics span multiple lines, consider using a `--oneline` flag or falling back to `generic` parser.

### Step 6: Generate Config Entry

Output the complete check configuration:

```json
{
  "name": "<tool-name>",
  "command": "<executable>",
  "args": ["<arg1>", "$FILE"],
  "parser": "<predefined-or-object>",
  "maxDiagnostics": 5
}
```

### Step 7: Confirm with User

Show the user:
1. Sample output you analyzed
2. The parser you chose (predefined name or custom regex)
3. The complete config entry
4. Ask if they want to test on another file or adjust

## Output

Return the final check configuration ready to add to `checker.json`.
