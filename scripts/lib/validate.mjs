/**
 * validate.mjs
 * Validate checkmate.json configuration files.
 *
 * Exports:
 *   validateConfig(config) — returns { errors: string[], warnings: string[] }
 *   run()                  — CLI entry point (argv / --stdin)
 *
 * Exit codes (CLI):
 *   0 = valid
 *   1 = invalid (errors found)
 *   2 = file not found or read error
 */

import * as fs from "node:fs";

// =============================================================================
// Schema Definitions
// =============================================================================

const PREDEFINED_PARSERS = ["ruff", "ty", "eslint", "tsc", "prettier", "biome", "generic", "jsonl", "gcc"];

// =============================================================================
// Validation Functions
// =============================================================================

function validateCheck(check, envName, ext, index) {
  const errors = [];
  const prefix = `environments[${envName}].checks["${ext}"][${index}]`;

  if (!check || typeof check !== "object") {
    errors.push(`${prefix}: must be an object`);
    return errors;
  }

  // Required: name
  if (!check.name || typeof check.name !== "string") {
    errors.push(`${prefix}.name: required string`);
  }

  // Required: command
  if (!check.command || typeof check.command !== "string") {
    errors.push(`${prefix}.command: required string`);
  }

  // Required: args (array)
  if (!check.args || !Array.isArray(check.args)) {
    errors.push(`${prefix}.args: required array`);
  } else {
    // Check that $FILE appears somewhere in args
    const hasFileArg = check.args.some(
      (arg) => arg === "$FILE" || (typeof arg === "string" && arg.includes("$FILE"))
    );
    if (!hasFileArg) {
      errors.push(`${prefix}.args: should contain "$FILE" placeholder`);
    }
  }

  // Optional: parser (string or object)
  if (check.parser !== undefined) {
    if (typeof check.parser === "string") {
      if (!PREDEFINED_PARSERS.includes(check.parser)) {
        errors.push(
          `${prefix}.parser: unknown parser "${check.parser}". Valid: ${PREDEFINED_PARSERS.join(", ")}`
        );
      }
    } else if (typeof check.parser === "object") {
      if (!check.parser.pattern || typeof check.parser.pattern !== "string") {
        errors.push(`${prefix}.parser.pattern: required string for custom parser`);
      } else {
        // Validate regex
        try {
          new RegExp(check.parser.pattern);
        } catch (e) {
          errors.push(`${prefix}.parser.pattern: invalid regex - ${e.message}`);
        }
      }
      if (check.parser.severity && !["error", "warning"].includes(check.parser.severity)) {
        errors.push(`${prefix}.parser.severity: must be "error" or "warning"`);
      }
    } else {
      errors.push(`${prefix}.parser: must be string or object`);
    }
  }

  // Optional: maxDiagnostics (positive integer)
  if (check.maxDiagnostics !== undefined) {
    if (typeof check.maxDiagnostics !== "number" || check.maxDiagnostics < 1) {
      errors.push(`${prefix}.maxDiagnostics: must be positive integer`);
    }
  }

  // Optional: _auto (boolean) - marks auto-discovered checks
  if (check._auto !== undefined && typeof check._auto !== "boolean") {
    errors.push(`${prefix}._auto: must be boolean`);
  }

  return errors;
}

function validateChecks(checks, envName) {
  const errors = [];

  if (!checks || typeof checks !== "object") {
    errors.push(`environments[${envName}].checks: required object`);
    return errors;
  }

  for (const [ext, checkList] of Object.entries(checks)) {
    // Validate extension key (supports comma-delimited like ".ts,.tsx")
    const extensions = ext.split(",").map((e) => e.trim());
    for (const extension of extensions) {
      if (!extension.startsWith(".")) {
        errors.push(
          `environments[${envName}].checks: extension "${extension}" in key "${ext}" should start with "."`
        );
      }
    }

    if (!Array.isArray(checkList)) {
      errors.push(`environments[${envName}].checks["${ext}"]: must be array`);
      continue;
    }

    for (let i = 0; i < checkList.length; i++) {
      errors.push(...validateCheck(checkList[i], envName, ext, i));
    }
  }

  return errors;
}

function validateAgents(agents, envName) {
  const errors = [];

  if (typeof agents !== "object" || agents === null) {
    errors.push(`environments[${envName}].agents: must be an object`);
    return errors;
  }

  for (const [key, agentName] of Object.entries(agents)) {
    // Validate extension key (supports comma-delimited like ".ts,.tsx")
    const extensions = key.split(",").map((e) => e.trim());
    for (const ext of extensions) {
      if (!ext.startsWith(".")) {
        errors.push(
          `environments[${envName}].agents: extension "${ext}" in key "${key}" should start with "."`
        );
      }
    }

    // Validate agent name
    if (typeof agentName !== "string" || agentName.trim() === "") {
      errors.push(
        `environments[${envName}].agents["${key}"]: agent name must be a non-empty string`
      );
    }
  }

  return errors;
}

function validateEnvironmentArray(environments) {
  const errors = [];
  const names = new Set();

  if (!Array.isArray(environments)) {
    errors.push("environments: must be array");
    return errors;
  }

  for (let i = 0; i < environments.length; i++) {
    const env = environments[i];
    const envName = env.name || `[${i}]`;

    if (!env || typeof env !== "object") {
      errors.push(`environments[${i}]: must be object`);
      continue;
    }

    // Optional: name (but must be unique if provided)
    if (env.name !== undefined) {
      if (typeof env.name !== "string") {
        errors.push(`environments[${i}].name: must be string`);
      } else if (names.has(env.name)) {
        errors.push(`environments[${i}].name: duplicate name "${env.name}"`);
      } else {
        names.add(env.name);
      }
    }

    // Required: paths (array of strings)
    if (!env.paths || !Array.isArray(env.paths)) {
      errors.push(`environments[${envName}].paths: required array`);
    } else {
      for (let j = 0; j < env.paths.length; j++) {
        if (typeof env.paths[j] !== "string") {
          errors.push(`environments[${envName}].paths[${j}]: must be string`);
        }
      }
      if (env.paths.length === 0) {
        errors.push(`environments[${envName}].paths: must have at least one path`);
      }
    }

    // Optional: exclude (array of strings/patterns)
    if (env.exclude !== undefined) {
      if (!Array.isArray(env.exclude)) {
        errors.push(`environments[${envName}].exclude: must be array`);
      } else {
        for (let j = 0; j < env.exclude.length; j++) {
          if (typeof env.exclude[j] !== "string") {
            errors.push(`environments[${envName}].exclude[${j}]: must be string`);
          }
        }
      }
    }

    // Required: checks
    errors.push(...validateChecks(env.checks, envName));

    // Optional: agents (object mapping extension patterns to agent names)
    if (env.agents !== undefined) {
      errors.push(...validateAgents(env.agents, envName));
    }
  }

  return errors;
}

function validateTaskRule(rule, index) {
  const errors = [];
  const prefix = `tasks[${index}]`;

  if (!rule || typeof rule !== "object") {
    errors.push(`${prefix}: must be an object`);
    return errors;
  }

  // Required: name (string, used in output)
  if (!rule.name || typeof rule.name !== "string") {
    errors.push(`${prefix}.name: required string`);
  }

  // Required: match
  if (!rule.match || typeof rule.match !== "string") {
    errors.push(`${prefix}.match: required string`);
  }

  // Required: action (must be "skip", "message", or "review")
  const validActions = ["skip", "message", "review"];
  if (!rule.action || typeof rule.action !== "string") {
    errors.push(`${prefix}.action: required string (skip|message|review)`);
  } else if (!validActions.includes(rule.action)) {
    errors.push(`${prefix}.action: must be one of: ${validActions.join(", ")}`);
  }

  // message: required for "message" and "review" actions
  if (rule.action === "message" || rule.action === "review") {
    if (!rule.message || typeof rule.message !== "string") {
      errors.push(`${prefix}.message: required string for action "${rule.action}"`);
    }
  }

  // message should not be present for "skip" action
  if (rule.action === "skip" && rule.message !== undefined) {
    errors.push(`${prefix}.message: should not be present for action "skip"`);
  }

  return errors;
}

function validateTasksArray(tasks) {
  const errors = [];

  if (!Array.isArray(tasks)) {
    errors.push("tasks: must be array");
    return errors;
  }

  for (let i = 0; i < tasks.length; i++) {
    errors.push(...validateTaskRule(tasks[i], i));
  }

  return errors;
}

function validateSkipDuringGitOperations(skipConfig) {
  const errors = [];
  const validOps = ["rebase", "bisect", "merge", "cherryPick", "revert", "am"];

  if (typeof skipConfig !== "object" || skipConfig === null) {
    errors.push("git: must be an object");
    return errors;
  }

  for (const [key, value] of Object.entries(skipConfig)) {
    if (!validOps.includes(key)) {
      errors.push(
        `git.${key}: unknown git operation (valid: ${validOps.join(", ")})`
      );
    }
    if (typeof value !== "boolean") {
      errors.push(`git.${key}: must be a boolean`);
    }
  }

  return errors;
}

/**
 * Validate a checkmate config object.
 * @param {object} config - Parsed checkmate.json
 * @returns {{ errors: string[], warnings: string[] }}
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  if (!config || typeof config !== "object") {
    errors.push("config: must be object");
    return { errors, warnings };
  }

  if (!config.environments) {
    errors.push("config: must have 'environments' array");
    return { errors, warnings };
  }

  if (!Array.isArray(config.environments)) {
    errors.push("environments: must be array");
    return { errors, warnings };
  }

  errors.push(...validateEnvironmentArray(config.environments));

  // Optional: tasks (array)
  if (config.tasks !== undefined) {
    errors.push(...validateTasksArray(config.tasks));
  }

  // Optional: git (object)
  if (config.git !== undefined) {
    errors.push(...validateSkipDuringGitOperations(config.git));
  }

  return { errors, warnings };
}

// =============================================================================
// Output Formatting
// =============================================================================

function formatResults(results, filePath) {
  const lines = [];

  if (results.errors.length === 0 && results.warnings.length === 0) {
    lines.push(`\u2713 ${filePath || "config"} is valid`);
    return { output: lines.join("\n"), valid: true };
  }

  if (results.errors.length > 0) {
    lines.push(`\u2717 ${filePath || "config"} has ${results.errors.length} error(s):`);
    for (const error of results.errors) {
      lines.push(`  \u2022 ${error}`);
    }
  }

  if (results.warnings.length > 0) {
    if (results.errors.length > 0) lines.push("");
    lines.push(`\u26A0 ${results.warnings.length} warning(s):`);
    for (const warning of results.warnings) {
      lines.push(`  \u2022 ${warning}`);
    }
  }

  return { output: lines.join("\n"), valid: results.errors.length === 0 };
}

// =============================================================================
// CLI Entry Point
// =============================================================================

/**
 * CLI runner for `checkmate.mjs validate`.
 * Reads config from argv path or --stdin, validates, prints results.
 */
export async function run() {
  const args = process.argv.slice(3); // skip: node, checkmate.mjs, validate

  let configContent;
  let filePath;

  if (args.includes("--stdin")) {
    let data = "";
    for await (const chunk of process.stdin) {
      data += chunk;
    }
    configContent = data;
    filePath = "<stdin>";
  } else if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: node checkmate.mjs validate <path-to-checkmate.json>
       node checkmate.mjs validate --stdin < checkmate.json

Validates a checkmate.json configuration file.

Exit codes:
  0 = valid
  1 = invalid (errors found)
  2 = file not found or read error`);
    process.exit(0);
  } else if (args.length > 0) {
    filePath = args[0];
    if (!fs.existsSync(filePath)) {
      console.error(`Error: file not found: ${filePath}`);
      process.exit(2);
    }
    try {
      configContent = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      console.error(`Error reading file: ${err.message}`);
      process.exit(2);
    }
  } else {
    const defaultPath = ".claude/checkmate.json";
    if (fs.existsSync(defaultPath)) {
      filePath = defaultPath;
      configContent = fs.readFileSync(filePath, "utf-8");
    } else {
      console.error("Usage: node checkmate.mjs validate <path-to-checkmate.json>");
      console.error("       node checkmate.mjs validate --stdin < checkmate.json");
      console.error("\nNo checkmate.json found in current directory.");
      process.exit(2);
    }
  }

  let config;
  try {
    config = JSON.parse(configContent);
  } catch (err) {
    console.error(`\u2717 Invalid JSON: ${err.message}`);
    process.exit(1);
  }

  const results = validateConfig(config);
  const { output, valid } = formatResults(results, filePath);

  console.log(output);
  process.exit(valid ? 0 : 1);
}
