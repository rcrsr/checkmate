#!/usr/bin/env node
/**
 * Validate checkmate.json configuration files.
 *
 * Usage:
 *   node validate-config.mjs <path-to-checkmate.json>
 *   node validate-config.mjs --stdin < checkmate.json
 *
 * Exit codes:
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
  }

  return errors;
}

function validateReviewerRule(rule, index) {
  const errors = [];
  const prefix = `reviewers[${index}]`;

  if (!rule || typeof rule !== "object") {
    errors.push(`${prefix}: must be an object`);
    return errors;
  }

  // Required: match
  if (!rule.match || typeof rule.match !== "string") {
    errors.push(`${prefix}.match: required string`);
  }

  // Optional: action (must be "skip" if present)
  if (rule.action !== undefined) {
    if (rule.action !== "skip") {
      errors.push(`${prefix}.action: must be "skip" if present`);
    }
  }

  // reviewer: required unless action is "skip"
  if (rule.action !== "skip") {
    if (!rule.reviewer || typeof rule.reviewer !== "string") {
      errors.push(`${prefix}.reviewer: required string (unless action is "skip")`);
    }
  }

  // Optional: message (string)
  if (rule.message !== undefined && typeof rule.message !== "string") {
    errors.push(`${prefix}.message: must be string`);
  }

  return errors;
}

function validateReviewersArray(reviewers) {
  const errors = [];

  if (!Array.isArray(reviewers)) {
    errors.push("reviewers: must be array");
    return errors;
  }

  for (let i = 0; i < reviewers.length; i++) {
    errors.push(...validateReviewerRule(reviewers[i], i));
  }

  return errors;
}

function validateConfig(config) {
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

  // Optional: reviewers (array)
  if (config.reviewers !== undefined) {
    errors.push(...validateReviewersArray(config.reviewers));
  }

  return { errors, warnings };
}

// =============================================================================
// Output Formatting
// =============================================================================

function formatResults(results, filePath) {
  const lines = [];

  if (results.errors.length === 0 && results.warnings.length === 0) {
    lines.push(`✓ ${filePath || "config"} is valid`);
    return { output: lines.join("\n"), valid: true };
  }

  if (results.errors.length > 0) {
    lines.push(`✗ ${filePath || "config"} has ${results.errors.length} error(s):`);
    for (const error of results.errors) {
      lines.push(`  • ${error}`);
    }
  }

  if (results.warnings.length > 0) {
    if (results.errors.length > 0) lines.push("");
    lines.push(`⚠ ${results.warnings.length} warning(s):`);
    for (const warning of results.warnings) {
      lines.push(`  • ${warning}`);
    }
  }

  return { output: lines.join("\n"), valid: results.errors.length === 0 };
}

// =============================================================================
// Main
// =============================================================================

async function main() {
  const args = process.argv.slice(2);

  let configContent;
  let filePath;

  if (args.includes("--stdin")) {
    // Read from stdin
    let data = "";
    for await (const chunk of process.stdin) {
      data += chunk;
    }
    configContent = data;
    filePath = "<stdin>";
  } else if (args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: node validate-config.mjs <path-to-checkmate.json>
       node validate-config.mjs --stdin < checkmate.json

Validates a checkmate.json configuration file.

Exit codes:
  0 = valid
  1 = invalid (errors found)
  2 = file not found or read error`);
    process.exit(0);
  } else if (args.length > 0) {
    // Read from file
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
    // Try to find checkmate.json in current directory
    const defaultPath = ".claude/checkmate.json";
    if (fs.existsSync(defaultPath)) {
      filePath = defaultPath;
      configContent = fs.readFileSync(filePath, "utf-8");
    } else {
      console.error("Usage: node validate-config.mjs <path-to-checkmate.json>");
      console.error("       node validate-config.mjs --stdin < checkmate.json");
      console.error("\nNo checkmate.json found in current directory.");
      process.exit(2);
    }
  }

  // Parse JSON
  let config;
  try {
    config = JSON.parse(configContent);
  } catch (err) {
    console.error(`✗ Invalid JSON: ${err.message}`);
    process.exit(1);
  }

  // Validate
  const results = validateConfig(config);
  const { output, valid } = formatResults(results, filePath);

  console.log(output);
  process.exit(valid ? 0 : 1);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(2);
});
