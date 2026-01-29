/**
 * post-task.mjs
 * PostToolUse hook: Handle Task completions with configurable actions
 *
 * Reads checkmate.json from .claude/ directory to determine what action
 * to take based on the completed subagent type.
 *
 * Actions:
 *   - skip: silent, no output
 *   - message: non-blocking systemMessage
 *   - review: blocking, requires review
 *
 * Exit codes: 0 = continue (with optional block decision)
 */

import { loadConfig, readStdinJson, pass, block } from "./lib.mjs";

// =============================================================================
// Task Matching
// =============================================================================

/**
 * Match a subagent type against a pattern.
 * Supports exact matches and wildcard patterns with * capturing prefix.
 *
 * @param {string} subagentType - The subagent type to match
 * @param {string} pattern - Pattern to match against (exact or wildcard like "*-engineer")
 * @returns {{ matches: boolean, capture?: string }} Match result with optional capture
 */
function matchPattern(subagentType, pattern) {
  if (pattern === subagentType) {
    return { matches: true };
  }

  if (pattern.startsWith("*")) {
    const suffix = pattern.slice(1);
    if (subagentType.endsWith(suffix)) {
      const capture = subagentType.slice(0, -suffix.length);
      return { matches: true, capture };
    }
  }

  return { matches: false };
}

/**
 * Find the first matching task rule for a subagent type.
 * Exact matches have highest priority, then wildcards in declaration order.
 *
 * @param {Array} tasks - Array of task rules
 * @param {string} subagentType - The subagent type to match
 * @returns {{ rule: object, capture?: string } | null} Matching rule or null
 */
function findMatchingTask(tasks, subagentType) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return null;
  }

  // First pass: exact matches only
  for (const rule of tasks) {
    if (!rule.match) continue;
    if (rule.match === subagentType) {
      return { rule };
    }
  }

  // Second pass: wildcard patterns in order
  for (const rule of tasks) {
    if (!rule.match || !rule.match.includes("*")) continue;
    const result = matchPattern(subagentType, rule.match);
    if (result.matches) {
      return { rule, capture: result.capture };
    }
  }

  return null;
}

/**
 * Apply substitutions to a string.
 * Supports $1 and * placeholders for captured prefix.
 *
 * @param {string} template - String with placeholders
 * @param {string} capture - Captured prefix for $1 and *
 * @returns {string} String with substitutions applied
 */
function applySubstitutions(template, capture) {
  let result = template;
  if (capture !== undefined) {
    result = result.replace(/\$1/g, capture);
    result = result.replace(/\*/g, capture);
  }
  return result;
}

// =============================================================================
// Main
// =============================================================================

export async function run() {
  const input = await readStdinJson();
  const toolName = input.tool_name;
  const subagentType = input.tool_input?.subagent_type;

  // Only process Task tool completions
  if (toolName !== "Task") {
    process.exit(0);
  }

  // No subagent type provided - skip silently
  if (!subagentType) {
    process.exit(0);
  }

  // Load config
  const { config, projectRoot } = loadConfig();
  if (!projectRoot) {
    process.exit(0);
  }

  // No config or no tasks - skip silently
  if (!config?.tasks) {
    process.exit(0);
  }

  // Find matching task rule
  const match = findMatchingTask(config.tasks, subagentType);
  if (!match) {
    process.exit(0);
  }

  const { rule, capture } = match;
  const ruleName = rule.name;

  // Skip action
  if (rule.action === "skip") {
    pass(`\u2705 ${ruleName}`);
  }

  // Message action - non-blocking systemMessage
  if (rule.action === "message") {
    applySubstitutions(rule.message || "", capture);
    pass(`\u2139\uFE0F ${ruleName}`);
  }

  // Review action - blocking
  if (rule.action === "review") {
    const reason = applySubstitutions(rule.message || "", capture);
    block(reason, `\uD83D\uDD0D ${ruleName}`);
  }

  // Unknown action - skip silently
  process.exit(0);
}
