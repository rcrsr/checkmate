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
 *
 * TODO(hooks-review): pass() emits systemMessage on every call, including no-op
 * paths ("no config", "skipped", "subagent context"). Each systemMessage adds
 * tokens to model context. Consider: (a) silent exit (no stdout) for no-op cases,
 * or (b) a separate silentPass() that exits without output. Only emit systemMessage
 * when checkmate has actionable information (check results, status lines).
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

// =============================================================================
// File Root Resolution
// =============================================================================

/**
 * Resolve a path with realpathSync, falling back to the input path on error
 * so callers never throw on a permissions issue or dangling symlink.
 */
function safeRealpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Realpath a file path that may not exist yet (Write creates new files).
 * Walks up to the first existing ancestor directory, realpaths that, and
 * rejoins the remaining (not-yet-existing) segments.
 */
function realpathPossiblyMissing(filePath) {
  const segments = [];
  let dir = filePath;
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    segments.unshift(path.basename(dir));
    dir = parent;
  }
  const realDir = safeRealpath(dir);
  return segments.length > 0 ? path.join(realDir, ...segments) : realDir;
}

/**
 * Check whether a resolved file path is contained within a resolved root.
 * Pure lexical comparison; never throws.
 */
function isContained(realRoot, realFilePath) {
  const rel = path.relative(realRoot, realFilePath);
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/**
 * Resolve a gitdir line's target to an absolute path, relative to the
 * directory containing the .git file when the target itself is relative.
 */
function resolveGitdirTarget(rawTarget, gitFileDir) {
  return path.isAbsolute(rawTarget) ? rawTarget : path.resolve(gitFileDir, rawTarget);
}

/**
 * Read a .git marker at dir and classify it.
 *
 * Worktree vs. nested-repo/submodule is decided with a layout-independent,
 * pure-fs check: a real worktree's gitdir target directory contains a
 * `commondir` file, while a submodule's does not. The `.git/worktrees/`
 * substring check runs first as a fast path but is not relied on for
 * correctness, since a relocated GIT_DIR/GIT_COMMON_DIR or a bare-repo-
 * adjacent layout won't contain that substring.
 * @returns {"dir"|"worktree"|"nested-repo"|null}
 */
function classifyGitMarker(dir) {
  const gitPath = path.join(dir, ".git");
  if (!fs.existsSync(gitPath)) return null;

  const stat = fs.statSync(gitPath);
  if (stat.isDirectory()) return "dir";

  const content = fs.readFileSync(gitPath, "utf-8");
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match) return "nested-repo";

  const rawTarget = match[1].trim();
  if (/[\\/]\.git[\\/]worktrees[\\/]/.test(rawTarget)) {
    return "worktree";
  }

  try {
    const target = resolveGitdirTarget(rawTarget, dir);
    if (fs.existsSync(path.join(target, "commondir"))) {
      return "worktree";
    }
  } catch {
    // fail open - fall through to nested-repo classification
  }
  return "nested-repo";
}

/**
 * Resolve which project a file belongs to and the root checks should run from.
 *
 * A project's checks only ever apply to that project's own files. This
 * guards against 2 failure modes: files that escape the project root
 * entirely (a sibling repo, a /tmp scratchpad), and files that are lexically
 * inside the root but belong to a different checkout (a linked git
 * worktree, a nested repo, a submodule).
 *
 * `.git` and `checkmate.json` play 2 different roles here. `.git` is a
 * TERMINATOR: it marks a project boundary and stops the upward walk, but
 * grants no trust and supplies no config by itself. `checkmate.json`
 * supplies the config; whether one sits at the terminator decides the
 * outcome (see post-tool.mjs and pre-tool.mjs). When the walk stops at a
 * terminator with no config of its own, the terminator's TYPE decides the
 * fallback: a worktree is the same project in a different checkout, so the
 * session config legitimately reaches it; a nested repo is a different
 * project, so the parent's config has no business reaching in and the file
 * is skipped instead. Misclassifying the terminator's type therefore swaps
 * behavior, not just a label - see classifyGitMarker's commondir check.
 *
 * The returned `filePath` is always the realpath'd (or realpath-as-possible,
 * for not-yet-existing Write targets) version of the input, in the same
 * coordinate space as `root`. Callers must relativize against the returned
 * `filePath`, never the raw input, so a symlinked ancestor can't put `root`
 * and the file path in 2 different coordinate spaces.
 *
 * @param {string} filePath - Absolute path to the file being edited
 * @param {string} projectRoot - Absolute path to CLAUDE_PROJECT_DIR
 * @returns {{ root: string, filePath: string, kind: "project"|"worktree"|"nested-repo"|"outside" }}
 */
export function resolveFileRoot(filePath, projectRoot) {
  // Step 1: containment. Pure lexical work; must never fail open.
  const realProjectRoot = safeRealpath(projectRoot);
  const realFilePath = realpathPossiblyMissing(filePath);
  if (!isContained(realProjectRoot, realFilePath)) {
    return { root: projectRoot, filePath: realFilePath, kind: "outside" };
  }

  // Step 2: walk up from the file's realpath'd directory looking for a .git
  // marker, never walking above realProjectRoot. Anchored to the realpath
  // values step 1 already validated (not the raw, possibly-unnormalized
  // filePath/projectRoot strings) so a symlink or a trailing separator in
  // CLAUDE_PROJECT_DIR can't defeat the `dir === realProjectRoot` check.
  // The isContained() guard is a second, independent termination condition:
  // the loop provably cannot examine a directory outside the project,
  // regardless of string formatting. Any fs error falls open to "project".
  try {
    let dir = path.dirname(realFilePath);
    while (true) {
      if (dir === realProjectRoot) {
        return { root: projectRoot, filePath: realFilePath, kind: "project" };
      }
      if (!isContained(realProjectRoot, dir)) {
        return { root: projectRoot, filePath: realFilePath, kind: "project" };
      }

      const marker = classifyGitMarker(dir);
      if (marker === "worktree") {
        return { root: dir, filePath: realFilePath, kind: "worktree" };
      }
      if (marker === "dir" || marker === "nested-repo") {
        return { root: dir, filePath: realFilePath, kind: "nested-repo" };
      }

      const parent = path.dirname(dir);
      if (parent === dir) {
        return { root: projectRoot, filePath: realFilePath, kind: "project" };
      }
      dir = parent;
    }
  } catch {
    return { root: projectRoot, filePath: realFilePath, kind: "project" };
  }
}

// =============================================================================
// Path Matching (shared by pre-tool.mjs and post-tool.mjs)
// =============================================================================

/**
 * Normalize a path to POSIX-style ("/") separators. `path.relative()` yields
 * "\\" separators on Windows, and config `paths`/`exclude` entries are
 * authored with "/"; without normalizing both sides, checks and agents
 * silently stop matching on Windows.
 */
function toPosixPath(p) {
  return p.split(path.sep).join("/").replace(/\\/g, "/");
}

/**
 * Check if a file path starts with any of the given paths.
 * @param {string} relativePath - Project-relative path of the file
 * @param {string[]} paths - Environment's configured `paths` entries
 * @returns {boolean}
 */
export function fileMatchesPaths(relativePath, paths) {
  const normalizedRelativePath = toPosixPath(relativePath);
  const fileDir = path.posix.dirname(normalizedRelativePath);

  for (const envPath of paths) {
    const posixEnvPath = toPosixPath(envPath);
    const normalizedEnvPath = posixEnvPath === "." ? "" : posixEnvPath;
    if (
      normalizedEnvPath === "" ||
      normalizedRelativePath.startsWith(normalizedEnvPath + "/") ||
      normalizedRelativePath === normalizedEnvPath ||
      fileDir === normalizedEnvPath ||
      fileDir.startsWith(normalizedEnvPath + "/")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Check if a file path matches an exclude glob pattern (** = any path,
 * * = any segment). Regex metacharacters in the pattern (including the "?"
 * quantifier) are escaped before the glob substitutions so literal
 * characters like "." or "?" don't act as wildcards (e.g. "dist.old/**"
 * must not match "distXold/foo.txt"). Both inputs are normalized to
 * POSIX-style separators first (see toPosixPath) so excludes still apply
 * on Windows.
 * @param {string} relativePath - Project-relative path of the file
 * @param {string} pattern - Single exclude glob pattern
 * @returns {boolean}
 */
export function matchesExcludePattern(relativePath, pattern) {
  const normalizedRelativePath = toPosixPath(relativePath);
  const regexPattern = toPosixPath(pattern)
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
    .replace(/\*\*/g, "{{GLOBSTAR}}")
    .replace(/\*/g, "[^/]*")
    .replace(/{{GLOBSTAR}}/g, ".*")
    .replace(/\//g, "\\/");
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(normalizedRelativePath);
}
