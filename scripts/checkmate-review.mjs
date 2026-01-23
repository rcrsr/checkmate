#!/usr/bin/env node
/**
 * checkmate-review.mjs
 * PostToolUse hook: Trigger code review agents after Task completion
 *
 * Reads checkmate.json from .claude/ directory to determine which
 * reviewer agent to invoke based on the completed subagent type.
 *
 * Exit codes: 0 = continue (with optional block decision)
 */

import * as fs from "node:fs";
import * as path from "node:path";

// =============================================================================
// Config Loading
// =============================================================================

function getProjectRoot() {
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

// =============================================================================
// Reviewer Matching
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
  // Exact match
  if (pattern === subagentType) {
    return { matches: true };
  }

  // Wildcard pattern: * matches any prefix
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
 * Find the first matching reviewer rule for a subagent type.
 * Exact matches have highest priority, then wildcards in declaration order.
 *
 * @param {Array} reviewers - Array of reviewer rules
 * @param {string} subagentType - The subagent type to match
 * @returns {{ rule: object, capture?: string } | null} Matching rule or null
 */
function findMatchingReviewer(reviewers, subagentType) {
  if (!Array.isArray(reviewers) || reviewers.length === 0) {
    return null;
  }

  // First pass: exact matches only
  for (const rule of reviewers) {
    if (!rule.match) continue;
    if (rule.match === subagentType) {
      return { rule };
    }
  }

  // Second pass: wildcard patterns in order
  for (const rule of reviewers) {
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
 * Supports $REVIEWER, $1, and * placeholders.
 *
 * @param {string} template - String with placeholders
 * @param {string} reviewer - Reviewer name for $REVIEWER
 * @param {string} capture - Captured prefix for $1 and *
 * @returns {string} String with substitutions applied
 */
function applySubstitutions(template, reviewer, capture) {
  let result = template;
  if (reviewer) {
    result = result.replace(/\$REVIEWER/g, reviewer);
  }
  if (capture !== undefined) {
    result = result.replace(/\$1/g, capture);
    result = result.replace(/\*/g, capture);
  }
  return result;
}

// =============================================================================
// Output Helpers
// =============================================================================

function outputJson(output) {
  console.log(JSON.stringify(output));
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

  // No config or no reviewers - skip silently
  if (!config?.reviewers) {
    process.exit(0);
  }

  // Find matching reviewer rule
  const match = findMatchingReviewer(config.reviewers, subagentType);
  if (!match) {
    process.exit(0);
  }

  const { rule, capture } = match;

  // Skip action - exit silently
  if (rule.action === "skip") {
    outputJson({ systemMessage: `[checkmate] review skipped for ${subagentType}` });
    process.exit(0);
  }

  // Get reviewer name with substitution
  let reviewer = rule.reviewer;
  if (!reviewer) {
    process.exit(0);
  }
  reviewer = applySubstitutions(reviewer, null, capture);

  // Get message with substitutions
  const defaultMessage = "Task review required. Invoke the $REVIEWER subagent to validate the work.";
  const message = applySubstitutions(rule.message || defaultMessage, reviewer, capture);

  // Output block decision
  outputJson({
    decision: "block",
    reason: message,
    systemMessage: `[checkmate] review: invoke ${reviewer}`,
  });
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
