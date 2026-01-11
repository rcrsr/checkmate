#!/usr/bin/env node
/**
 * PostToolUse hook: Check formatting, linting, and types for edited files
 *
 * Reads checker.json from .claude/ directory to determine which commands
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

function findProjectRoot(startPath) {
  let current = path.resolve(startPath);
  while (current !== "/") {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    current = path.dirname(current);
  }
  return null;
}

function loadConfig(filePath) {
  const projectRoot = findProjectRoot(path.dirname(filePath));
  if (!projectRoot) {
    return { config: null, projectRoot: null };
  }

  const configPath = path.join(projectRoot, ".claude", "checker.json");
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
 * Validate a checker.json config file.
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
 * Find the matching environment for a file path.
 * First match wins (iterate in order, check paths/exclude).
 */
function findEnvironmentForFile(config, filePath, projectRoot) {
  if (!config?.environments || !Array.isArray(config.environments)) return null;

  const relativePath = path.relative(projectRoot, filePath);

  for (const env of config.environments) {
    if (!env.paths || !Array.isArray(env.paths)) continue;

    // Check if file matches any of the environment's paths
    if (!fileMatchesPaths(relativePath, env.paths)) continue;

    // Check exclude patterns
    if (env.exclude && Array.isArray(env.exclude)) {
      const excluded = env.exclude.some((pattern) =>
        matchesExcludePattern(relativePath, pattern)
      );
      if (excluded) continue;
    }

    // First match wins
    return env;
  }
  return null;
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
 */
function getChecksForFile(config, filePath, projectRoot) {
  const ext = path.extname(filePath);
  const env = findEnvironmentForFile(config, filePath, projectRoot);
  if (!env) return [];
  return getChecksForExtension(env.checks, ext);
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
    outputJson({ systemMessage: "No file path provided" });
    process.exit(0);
  }

  // File doesn't exist - skip silently
  if (!fs.existsSync(filePath)) {
    outputJson({ systemMessage: `File not found: ${filePath}` });
    process.exit(0);
  }

  // Self-check: validate checker.json when it's edited
  if (filePath.endsWith(".claude/checker.json")) {
    const validationResult = validateConfigFile(filePath);
    if (!validationResult.valid) {
      const errorReport = {
        file: filePath,
        valid: false,
        errorCount: validationResult.errors.length,
        errors: validationResult.errors,
      };
      outputJson({
        decision: "block",
        reason: `<checker-config-validation file="${filePath}">\n${JSON.stringify(errorReport, null, 2)}\n</checker-config-validation>`,
        systemMessage: `${filePath} has ${validationResult.errors.length} validation error(s) - fix before continuing`,
      });
      process.exit(0);
    }
    outputJson({ systemMessage: `${filePath} is valid` });
    process.exit(0);
  }

  // Load config
  const { config, projectRoot } = loadConfig(filePath);
  if (!config) {
    outputJson({
      systemMessage: "No checker.json found - run /checker:create to configure",
    });
    process.exit(0);
  }

  const ext = path.extname(filePath);
  const checks = getChecksForFile(config, filePath, projectRoot);

  if (checks.length === 0) {
    outputJson({ systemMessage: `No checks configured for ${ext}` });
    process.exit(0);
  }

  const diagnostics = [];

  for (const check of checks) {
    const checkDiagnostics = runCheck(check, filePath, projectRoot);
    diagnostics.push(...checkDiagnostics);
  }

  const fileName = path.basename(filePath);

  // Any diagnostics found - block
  if (diagnostics.length > 0) {
    const hasErrors = diagnostics.some((d) => d.severity === "error");
    const reason = formatDiagnosticsBlock(diagnostics, fileName);

    outputJson({
      decision: "block",
      reason,
      systemMessage: hasErrors
        ? `Quality check failed for ${fileName}`
        : `Quality warnings for ${fileName}`,
    });
    process.exit(0);
  }

  // All clean - approve
  outputJson({
    systemMessage: `Quality check passed for ${fileName}`,
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
