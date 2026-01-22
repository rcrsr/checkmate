#!/usr/bin/env node
/**
 * PostToolUse hook: Check formatting, linting, and types for edited files
 *
 * Reads checkmate.json from .claude/ directory to determine which commands
 * to run for each file type. Config-driven approach allows users to adapt
 * checks to their specific toolchain.
 *
 * Exit codes: 0 = continue, 2 = block with feedback
 *
 * NOTE: Auto-fix disabled to prevent file state desynchronization.
 * Claude must fix issues manually to maintain consistent file state.
 */

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// =============================================================================
// Config Loading
// =============================================================================

/**
 * Config schema (array format):
 * {
 *   "environments": [
 *     {
 *       "name": "root",
 *       "paths": ["."],
 *       "exclude": ["vendor/**"],
 *       "checks": {
 *         ".py": [
 *           { "name": "ruff", "command": "uv", "args": ["run", "ruff", "check", "$FILE"], "parser": "ruff" }
 *         ],
 *         ".ts,.tsx": [
 *           { "name": "eslint", "command": "pnpm", "args": ["exec", "eslint", "$FILE"], "parser": "eslint" }
 *         ]
 *       }
 *     }
 *   ]
 * }
 *
 * Parser can be:
 * - string: predefined parser name (ruff, ty, eslint, tsc, prettier, biome, generic)
 * - object: { pattern: "regex with named groups", severity?: "error"|"warning" }
 *   Named groups: line, column, message, rule, severity (all optional)
 */

function getProjectRoot() {
  // Use CLAUDE_PROJECT_DIR env var set by Claude Code
  return process.env.CLAUDE_PROJECT_DIR || null;
}

function loadConfig() {
  const projectRoot = getProjectRoot();
  if (!projectRoot) {
    return { config: null, projectRoot: null };
  }

  const configPath = path.join(projectRoot, ".claude", "checkmate.json");
  if (!fs.existsSync(configPath)) {
    return { config: null, projectRoot };
  }

  try {
    const content = fs.readFileSync(configPath, "utf-8");
    return { config: JSON.parse(content), projectRoot };
  } catch (err) {
    return { config: null, projectRoot };
  }
}

/**
 * Validate a checkmate.json config file.
 * Runs the validate-config.mjs script and returns results.
 */
function validateConfigFile(configPath) {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  const validatorPath = path.join(scriptDir, "validate-config.mjs");

  const result = spawnSync("node", [validatorPath, configPath], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  const output = (result.stdout + result.stderr).trim();
  const valid = result.status === 0;

  if (valid) {
    return { valid: true, errors: [] };
  }

  // Parse error lines into structured format
  // Format: "path.to.field: message"
  const errors = output
    .split("\n")
    .filter((line) => line.includes("•"))
    .map((line) => {
      const text = line.replace(/^\s*•\s*/, "").trim();
      const colonIndex = text.indexOf(": ");
      if (colonIndex > 0) {
        return {
          path: text.substring(0, colonIndex),
          message: text.substring(colonIndex + 2),
        };
      }
      return { path: "", message: text };
    });

  return { valid: false, errors: errors.length > 0 ? errors : [{ path: "", message: output }] };
}

/**
 * Check if a file path matches an exclude pattern.
 * Supports simple glob patterns: ** (any path), * (any segment)
 */
function matchesExcludePattern(relativePath, pattern) {
  // Convert glob pattern to regex
  const regexPattern = pattern
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{GLOBSTAR}}/g, ".*")
    .replace(/\//g, "\\/");
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(relativePath);
}

/**
 * Check if a file path starts with any of the given paths.
 */
function fileMatchesPaths(relativePath, paths) {
  const fileDir = path.dirname(relativePath);

  for (const envPath of paths) {
    const normalizedEnvPath = envPath === "." ? "" : envPath;
    if (
      normalizedEnvPath === "" ||
      relativePath.startsWith(normalizedEnvPath + "/") ||
      relativePath === normalizedEnvPath ||
      fileDir === normalizedEnvPath ||
      fileDir.startsWith(normalizedEnvPath + "/")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Get checks for a file extension from an environment's checks config.
 */
function getChecksForExtension(checksConfig, ext) {
  if (!checksConfig) return [];

  // Direct extension match
  if (checksConfig[ext]) {
    return checksConfig[ext];
  }

  // Comma-separated extensions
  for (const [key, checks] of Object.entries(checksConfig)) {
    const extensions = key.split(",").map((e) => e.trim());
    if (extensions.includes(ext)) {
      return checks;
    }
  }

  return [];
}

/**
 * Get checks for a file based on its extension and environment.
 * Returns { checks: [], reason: string } where reason explains why no checks ran.
 */
function getChecksForFile(config, filePath, projectRoot) {
  const ext = path.extname(filePath);
  const relativePath = path.relative(projectRoot, filePath);

  if (!config?.environments || !Array.isArray(config.environments)) {
    return { checks: [], reason: "no-config" };
  }

  // Check each environment to understand why no checks would run
  for (const env of config.environments) {
    if (!env.paths || !Array.isArray(env.paths)) continue;

    // Check if file matches any of the environment's paths
    if (!fileMatchesPaths(relativePath, env.paths)) continue;

    // File matches this environment's paths - check if excluded
    if (env.exclude && Array.isArray(env.exclude)) {
      const matchedPattern = env.exclude.find((pattern) =>
        matchesExcludePattern(relativePath, pattern)
      );
      if (matchedPattern) {
        // File was excluded - check if extension has checks in this env
        const hasChecksForExt = getChecksForExtension(env.checks, ext).length > 0;
        if (hasChecksForExt) {
          return { checks: [], reason: "path-excluded", pattern: matchedPattern, env: env.name };
        }
        continue; // No checks for this extension anyway, try next env
      }
    }

    // Not excluded - return checks for this extension
    const checks = getChecksForExtension(env.checks, ext);
    if (checks.length > 0) {
      return { checks, reason: "ok" };
    }
    // Environment matches but no checks for this extension
    return { checks: [], reason: "no-checks-for-extension" };
  }

  // No environment matched the file path
  return { checks: [], reason: "no-matching-environment" };
}

// =============================================================================
// Helpers
// =============================================================================

function commandExists(cmd) {
  try {
    execSync(`command -v ${cmd}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runCommand(cmd, args, cwd) {
  const result = spawnSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
  });

  return {
    success: result.status === 0,
    stderr: result.stderr || "",
    stdout: result.stdout || "",
  };
}

function truncateOutput(output, lines) {
  return output.split("\n").slice(0, lines).join("\n");
}

// =============================================================================
// Output Parsers
// =============================================================================

const parsers = {
  ruff(output) {
    // Ruff format: path/file.py:10:5: E501 Line too long
    const results = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const match = line.match(/:(\d+):(\d+): ([A-Z]+\d+) (.+)$/);
      if (match) {
        results.push({
          line: parseInt(match[1], 10),
          column: parseInt(match[2], 10),
          rule: match[3],
          message: match[4],
          severity: "error",
        });
      }
    }
    return results;
  },

  ty(output) {
    // ty format: error[rule-name]: Message
    //   --> path/file.py:10:5
    const results = [];
    const lines = output.split("\n");

    let currentRule = "";
    let currentMessage = "";
    let currentSeverity = "error";

    for (const line of lines) {
      const ruleMatch = line.match(/^(error|warning)\[([^\]]+)\]: (.+)$/);
      if (ruleMatch) {
        currentSeverity = ruleMatch[1];
        currentRule = ruleMatch[2];
        currentMessage = ruleMatch[3];
        continue;
      }

      const locMatch = line.match(/^\s*-->\s+.+:(\d+):(\d+)/);
      if (locMatch && currentMessage) {
        results.push({
          line: parseInt(locMatch[1], 10),
          column: parseInt(locMatch[2], 10),
          message: currentMessage,
          rule: currentRule,
          severity: currentSeverity,
        });
        currentMessage = "";
        currentRule = "";
      }
    }
    return results;
  },

  eslint(output) {
    // ESLint format: /path/file.ts:10:5 - error message (rule-name)
    const results = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const match = line.match(/:(\d+):(\d+)\s+(error|warning)\s+(.+?)\s+(\S+)$/);
      if (match) {
        results.push({
          line: parseInt(match[1], 10),
          column: parseInt(match[2], 10),
          message: match[4],
          rule: match[5],
          severity: match[3],
        });
      }
    }
    return results;
  },

  tsc(output) {
    // TSC format: path/file.ts(10,5): error TS2345: Message
    const results = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const match = line.match(/\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/);
      if (match) {
        results.push({
          line: parseInt(match[1], 10),
          column: parseInt(match[2], 10),
          message: match[5],
          rule: match[4],
          severity: match[3],
        });
      }
    }
    return results;
  },

  prettier(output) {
    // Prettier outputs file path if check fails, no structured diagnostics
    if (output.includes("would be reformatted") || output.trim()) {
      return [{ message: "File needs formatting", severity: "error" }];
    }
    return [];
  },

  biome(output) {
    // Biome format: path/file.ts:10:5 lint/rule message
    const results = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const match = line.match(/:(\d+):(\d+)\s+(\S+)\s+(.+)$/);
      if (match) {
        results.push({
          line: parseInt(match[1], 10),
          column: parseInt(match[2], 10),
          rule: match[3],
          message: match[4],
          severity: "error",
        });
      }
    }
    return results;
  },

  generic(output) {
    // Generic parser - just return the output as a single message if non-empty
    const trimmed = output.trim();
    if (trimmed) {
      return [{ message: truncateOutput(trimmed, 5), severity: "error" }];
    }
    return [];
  },

  jsonl(output) {
    // JSONL format: one JSON object per line
    // { "file": "path/to/file.md", "line": 114, "message": "error description" }
    // { "file": "path/to/file.md", "line": 200, "column": 5, "message": "error with column" }
    const results = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.file && typeof obj.line === "number" && obj.message) {
          results.push({
            line: obj.line,
            column: typeof obj.column === "number" ? obj.column : 1,
            message: obj.message,
            severity: "error",
          });
        }
      } catch {
        // Skip non-JSON lines
      }
    }
    return results;
  },

  gcc(output) {
    // GCC-style format: file:line:col: severity: message
    // Used by: clang-format, clang-tidy, gcc, shellcheck --format=gcc
    // Examples:
    //   src/main.cpp:10:5: error: expected ';' after expression
    //   script.sh:15:1: warning: Use $(...) instead of `...` [SC2006]
    const results = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      // Match: file:line:col: severity: message
      // Also handles: file:line:col: severity: message [CODE]
      const match = line.match(/:(\d+):(\d+):\s*(error|warning|note|info):\s*(.+)$/i);
      if (match) {
        const message = match[4].trim();
        // Extract rule code if present (e.g., [SC2006] or [-Wclang-format-violations])
        const ruleMatch = message.match(/\[([^\]]+)\]$/);
        results.push({
          line: parseInt(match[1], 10),
          column: parseInt(match[2], 10),
          message: ruleMatch ? message.replace(/\s*\[[^\]]+\]$/, "") : message,
          rule: ruleMatch ? ruleMatch[1] : undefined,
          severity: match[3].toLowerCase() === "error" ? "error" : "warning",
        });
      }
    }
    return results;
  },
};

/**
 * Create a parser function from an inline regex config
 * @param {object} config - { pattern: string, severity?: string }
 * @returns {function} Parser function
 */
function createRegexParser(config) {
  const regex = new RegExp(config.pattern, "gm");
  const defaultSeverity = config.severity || "error";

  return function regexParser(output) {
    const results = [];
    const lines = output.split("\n");

    for (const line of lines) {
      // Reset regex lastIndex for each line
      regex.lastIndex = 0;
      const match = regex.exec(line);

      if (match?.groups) {
        const g = match.groups;
        results.push({
          line: g.line ? parseInt(g.line, 10) : undefined,
          column: g.column ? parseInt(g.column, 10) : undefined,
          message: g.message || line.trim(),
          rule: g.rule,
          severity: g.severity || defaultSeverity,
        });
      }
    }

    return results;
  };
}

/**
 * Get parser function for a check config
 * @param {string|object} parserConfig - Parser name or inline config
 * @returns {function} Parser function
 */
function getParser(parserConfig) {
  if (!parserConfig) {
    return parsers.generic;
  }

  // Predefined parser
  if (typeof parserConfig === "string") {
    return parsers[parserConfig] || parsers.generic;
  }

  // Inline regex parser
  if (typeof parserConfig === "object" && parserConfig.pattern) {
    try {
      return createRegexParser(parserConfig);
    } catch (err) {
      // Invalid regex - fall back to generic
      return parsers.generic;
    }
  }

  return parsers.generic;
}

// =============================================================================
// Check Runner
// =============================================================================

function runCheck(check, filePath, projectRoot) {
  const diagnostics = [];

  // Check if command exists
  if (!commandExists(check.command)) {
    diagnostics.push({
      message: `${check.command} not found - skipping ${check.name}`,
      source: check.name,
      severity: "warning",
    });
    return diagnostics;
  }

  // Replace $FILE placeholder in args
  const args = check.args.map((arg) =>
    arg === "$FILE" ? filePath : arg.replace("$FILE", filePath)
  );

  const result = runCommand(check.command, args, projectRoot);

  if (!result.success) {
    const combined = result.stdout + result.stderr;

    // Skip if tool not found in output
    if (combined.includes("not found") || combined.includes("command not found")) {
      return diagnostics;
    }

    const parser = getParser(check.parser);
    const parsed = parser(combined);

    if (parsed.length > 0) {
      const maxDiagnostics = check.maxDiagnostics || 5;
      for (const d of parsed.slice(0, maxDiagnostics)) {
        diagnostics.push({
          ...d,
          source: check.name,
        });
      }
    } else {
      // Fallback: include raw output
      diagnostics.push({
        message: truncateOutput(combined, 3),
        source: check.name,
        severity: "error",
      });
    }
  }

  return diagnostics;
}

// =============================================================================
// Output Helpers
// =============================================================================

function outputJson(output) {
  console.log(JSON.stringify(output));
}

function formatDiagnostic(d) {
  const icon = d.severity === "error" ? "X" : "!";
  const location = d.line
    ? `[Line ${d.line}${d.column ? `:${d.column}` : ""}]`
    : "";
  const rule = d.rule ? ` [${d.rule}]` : "";
  const source = `(${d.source})`;

  return `  ${icon} ${location} ${d.message}${rule} ${source}`;
}

function formatDiagnosticsBlock(diags, fileName) {
  const lines = diags.map((d) => formatDiagnostic(d));
  return `<new-diagnostics>\n${fileName}:\n${lines.join("\n")}\n</new-diagnostics>`;
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  let inputData = "";
  for await (const chunk of process.stdin) {
    inputData += chunk;
  }

  const input = JSON.parse(inputData);
  const filePath = input.tool_input?.file_path;

  // No file path provided - skip silently
  if (!filePath) {
    outputJson({ systemMessage: "[checkmate] No file path provided" });
    process.exit(0);
  }

  // File doesn't exist - skip silently
  if (!fs.existsSync(filePath)) {
    outputJson({ systemMessage: `[checkmate] File not found: ${filePath}` });
    process.exit(0);
  }

  // Load config
  const { config, projectRoot } = loadConfig();
  if (!projectRoot) {
    outputJson({
      systemMessage: "[checkmate] CLAUDE_PROJECT_DIR not set - hook requires Claude Code environment",
    });
    process.exit(0);
  }

  const isConfigFile = filePath.endsWith(".claude/checkmate.json");

  // No config and not editing the config file - nothing to do
  if (!config && !isConfigFile) {
    outputJson({
      systemMessage: "[checkmate] disabled (run /checkmate:init to configure)",
    });
    process.exit(0);
  }

  const diagnostics = [];

  // Run configured checks (if config exists and checks are configured)
  let checkResult = { checks: [], reason: "no-config" };
  if (config) {
    checkResult = getChecksForFile(config, filePath, projectRoot);
    for (const check of checkResult.checks) {
      const checkDiagnostics = runCheck(check, filePath, projectRoot);
      diagnostics.push(...checkDiagnostics);
    }
  }

  // Self-check: validate checkmate.json schema when it's edited
  if (isConfigFile) {
    const validationResult = validateConfigFile(filePath);
    if (!validationResult.valid) {
      for (const err of validationResult.errors) {
        diagnostics.push({
          message: err.message,
          rule: err.path || "schema",
          source: "checkmate-schema",
          severity: "error",
        });
      }
    }
  }

  const fileName = path.basename(filePath);

  // Any diagnostics found - block
  if (diagnostics.length > 0) {
    const reason = formatDiagnosticsBlock(diagnostics, fileName);
    const failedChecks = [...new Set(diagnostics.map((d) => d.source))].join(", ");

    outputJson({
      decision: "block",
      reason,
      systemMessage: `[checkmate] fail: ${failedChecks}`,
    });
    process.exit(0);
  }

  // Determine if any checks ran and provide appropriate message
  const checksRan = checkResult.checks.length > 0;

  if (!checksRan && !isConfigFile) {
    const message = checkResult.reason === "path-excluded" ? "excluded" : "skipped";
    outputJson({ systemMessage: `[checkmate] ${message}` });
    process.exit(0);
  }

  // All clean - approve
  outputJson({ systemMessage: "[checkmate] pass" });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
