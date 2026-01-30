/**
 * pre-tool.mjs
 * PreToolUse hook: Enforce agent delegation for file types.
 *
 * Blocks Edit/Write from main conversation when a file extension
 * matches an agent mapping. Forces delegation to specialist agents.
 *
 * Exit codes: 0 = continue (pass or deny emitted via stdout)
 */

import { createReadStream, existsSync, statSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import * as path from "node:path";
import { loadConfig, readStdinJson, pass, outputJson } from "./lib.mjs";

// =============================================================================
// Extension Matching
// =============================================================================

/**
 * Find agent name for a file extension from environment's agents config.
 * Supports comma-delimited keys: ".mjs,.js": "javascript-engineer"
 */
function getAgentForExtension(agentsConfig, ext) {
  if (!agentsConfig || typeof agentsConfig !== "object") return null;

  for (const [key, agentName] of Object.entries(agentsConfig)) {
    const extensions = key.split(",").map((e) => e.trim());
    if (extensions.includes(ext)) {
      return agentName;
    }
  }
  return null;
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
 * Check if a file path matches an exclude pattern.
 */
function matchesExcludePattern(relativePath, pattern) {
  const regexPattern = pattern
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{GLOBSTAR}}/g, ".*")
    .replace(/\//g, "\\/");
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(relativePath);
}

/**
 * Find agent for a file based on extension and environment matching.
 */
function getAgentForFile(config, filePath, projectRoot) {
  const ext = path.extname(filePath);
  const relativePath = path.relative(projectRoot, filePath);

  if (!config?.environments || !Array.isArray(config.environments)) {
    return null;
  }

  for (const env of config.environments) {
    if (!env.paths || !Array.isArray(env.paths)) continue;
    if (!fileMatchesPaths(relativePath, env.paths)) continue;

    if (env.exclude && Array.isArray(env.exclude)) {
      const excluded = env.exclude.some((pattern) =>
        matchesExcludePattern(relativePath, pattern)
      );
      if (excluded) continue;
    }

    const agent = getAgentForExtension(env.agents, ext);
    if (agent) return agent;
  }

  return null;
}

// =============================================================================
// Git State Detection (reused from post-tool.mjs)
// =============================================================================

/**
 * Resolve the actual .git directory path.
 */
function getGitDir(projectRoot) {
  const gitPath = path.join(projectRoot, ".git");

  if (!existsSync(gitPath)) return null;

  try {
    const stat = statSync(gitPath);
    if (stat.isDirectory()) return gitPath;

    const content = readFileSync(gitPath, "utf-8");
    const match = content.match(/^gitdir:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Detect if repository is in a git operation state.
 */
function detectGitOperation(projectRoot) {
  const gitDir = getGitDir(projectRoot);
  if (!gitDir) return null;

  if (existsSync(path.join(gitDir, "rebase-merge"))) return "rebase";
  if (existsSync(path.join(gitDir, "rebase-apply", "applying"))) return "am";
  if (existsSync(path.join(gitDir, "rebase-apply"))) return "rebase";
  if (existsSync(path.join(gitDir, "BISECT_LOG"))) return "bisect";
  if (existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) return "cherryPick";
  if (existsSync(path.join(gitDir, "REVERT_HEAD"))) return "revert";
  if (existsSync(path.join(gitDir, "MERGE_HEAD"))) return "merge";

  return null;
}

// =============================================================================
// Transcript Parsing
// =============================================================================

/**
 * Check if tool call originated from main conversation (no parent Task).
 * Returns true if main thread, false if inside a subagent.
 */
async function isMainConversation(toolUseId, transcriptPath) {
  if (!toolUseId || !transcriptPath || !existsSync(transcriptPath)) {
    // Can't determine - fail open (allow the edit)
    return false;
  }

  const rl = createInterface({
    input: createReadStream(transcriptPath),
    crlfDelay: Infinity,
  });

  let parentToolUseID = null;

  for await (const line of rl) {
    if (line.includes(toolUseId)) {
      try {
        const parsed = JSON.parse(line);
        parentToolUseID = parsed.parentToolUseID || null;
      } catch {
        // Not valid JSON, continue
      }
      break;
    }
  }

  // No parent = main conversation
  return parentToolUseID === null;
}

// =============================================================================
// Hook Output
// =============================================================================

/**
 * Emit a deny decision for PreToolUse hook.
 */
function deny(reason) {
  outputJson({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
  process.exit(0);
}

// =============================================================================
// Main
// =============================================================================

export async function run() {
  const input = await readStdinJson();

  const toolName = input.tool_name;
  const toolUseId = input.tool_use_id;
  const transcriptPath = input.transcript_path;
  const filePath = input.tool_input?.file_path;

  // Only handle Edit and Write
  if (toolName !== "Edit" && toolName !== "Write") {
    pass("non-file tool");
  }

  // No file path - skip
  if (!filePath) {
    pass("no file path");
  }

  // Load config
  const { config, projectRoot } = loadConfig();
  if (!projectRoot || !config) {
    pass("no config");
  }

  // Find agent mapping for this file
  const requiredAgent = getAgentForFile(config, filePath, projectRoot);
  if (!requiredAgent) {
    pass("no agent mapping");
  }

  // Skip during git operations
  const gitOp = detectGitOperation(projectRoot);
  if (gitOp) {
    pass(`git ${gitOp} in progress`);
  }

  // Check if this is main conversation
  const isMain = await isMainConversation(toolUseId, transcriptPath);
  if (!isMain) {
    pass("subagent context");
  }

  // Main conversation trying to edit protected file type - deny
  const ext = path.extname(filePath);
  deny(`Use ${requiredAgent} to modify ${ext} files.`);
}
