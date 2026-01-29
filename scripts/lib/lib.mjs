/**
 * lib.mjs
 * Shared utilities for checkmate scripts.
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Get the project root directory from CLAUDE_PROJECT_DIR env var.
 * @returns {string|null}
 */
export function getProjectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || null;
}

/**
 * Load checkmate.json from the project's .claude directory.
 * @param {string} [projectRoot] - Override project root (defaults to getProjectRoot())
 * @returns {{ config: object|null, projectRoot: string|null }}
 */
export function loadConfig(projectRoot) {
  projectRoot = projectRoot || getProjectRoot();
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
 * Write a JSON object to stdout.
 * @param {object} obj
 */
export function outputJson(obj) {
  console.log(JSON.stringify(obj));
}

/**
 * Emit a non-blocking system message and exit.
 * @param {string} message - Text after the [checkmate] prefix
 */
export function pass(message) {
  outputJson({ systemMessage: `[checkmate] ${message}` });
  process.exit(0);
}

/**
 * Emit a blocking decision with reason and exit.
 * @param {string} reason - Detailed reason shown to the agent
 * @param {string} message - Text after the [checkmate] prefix
 */
export function block(reason, message) {
  outputJson({ decision: "block", reason, systemMessage: `[checkmate] ${message}` });
  process.exit(0);
}

/**
 * Read and parse JSON from stdin.
 * @returns {Promise<object>}
 */
export async function readStdinJson() {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return JSON.parse(data);
}
