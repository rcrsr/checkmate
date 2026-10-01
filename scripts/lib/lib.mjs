/**
 * lib.mjs
 * Shared utilities for checkmate scripts.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import * as fs from "node:fs";
import * as os from "node:os";
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

// =============================================================================
// Bash Write Detection (shared by post-bash.mjs and scan-bash)
// =============================================================================

// Safety valve against pathological commands, not a working limit: only the
// head of a longer command is scanned. Long heredoc scripts must fit under it.
const BASH_SCAN_LIMIT = 100000;

// Cap on unique candidate paths collected from one command.
const BASH_PATH_LIMIT = 500;

// Scratch and system targets that are never project files.
const SCRATCH_TARGETS = "/tmp/|/dev/|/proc/|\\$TMPDIR/|\\$\\{TMPDIR\\}/|~/\\.claude/|\\$HOME/\\.claude/";

// Up to 3 trailing redirections (`2>&1`, `>&2`, `2>/dev/null`, `&>file`, `> file`)
// that may follow a cp/mv destination without being the destination itself.
const TRAILING_REDIRECTS = "(?:[ \\t]+[0-9&]?>{1,2}&?[ \\t]*[^\\s;&|<>)(]*)?".repeat(3);

/**
 * Default patterns that flag a Bash command as a likely file write.
 * Order is significant: config entries override by name in place.
 */
export const DEFAULT_WRITE_PATTERNS = [
  // In-place flag anywhere among the options; the span stops at a command
  // separator and is bounded, which keeps matching linear.
  { name: "sed-inplace", match: "\\bsed(?=[ \\t])[^;&|\\n]{0,300}?[ \\t](?:-[a-zA-Z]*i|--in-place)" },
  { name: "perl-inplace", match: "\\bperl(?=[ \\t])[^;&|\\n]{0,300}?[ \\t]-[a-zA-Z]*i" },
  {
    name: "python-write",
    match:
      "\\.write_text\\(|\\bopen\\([^)\\n]{0,200}?(?:,[ \\t]*|\\bmode[ \\t]*=[ \\t]*)['\"][rbtU]*[wax+][rwaxbtU+]*['\"]",
  },
  { name: "node-write", match: "writeFileSync|appendFileSync|writeFile\\(|appendFile\\(" },
  {
    name: "redirect",
    match: `(?:^|[^0-9&><=-])(?:[0-9]|&)?>{1,2}\\s*['"]?(?!(?:${SCRATCH_TARGETS}))[^\\s&|;<>'"]+\\.[A-Za-z0-9]+\\b`,
  },
  // Matches only when the first non-option target is not a scratch target.
  {
    name: "tee",
    match: `\\btee(?:[ \\t]+-[a-zA-Z-]*){0,3}[ \\t]+(?!['"]?(?:${SCRATCH_TARGETS}))[^\\s;&|<>)(-]`,
  },
  // Known limits: matches only when cp/mv is a command word right after the
  // start or one of ;&|( or a newline (so `sudo cp`, `x=1 cp`, `time cp`,
  // `then cp` are not matched). The destination is taken as the last argument,
  // so `cp -t dest/ a.py` is judged by `a.py` and `cp a b > /tmp/log` is not
  // matched; trailing redirections (up to 3) are skipped when picking the
  // destination. The git dirty check drops any resulting false positive.
  // A span never crosses another command-word start (`;&|(` or a newline),
  // which keeps matching linear. An argument containing `(` or `)` (such as
  // `cp "a (1).py" dir/`) is not matched (accepted: a miss, not a false positive).
  {
    name: "cp-mv-into-repo",
    match: `(?:^|[;&|(\\n])[ \\t]*(?:cp|mv)[ \\t]+(?![ \\t])[^;&|>\\n)(]{0,300}[ \\t](?!['"]?(?:${SCRATCH_TARGETS}))[^\\s;&|>)(]+(?=${TRAILING_REDIRECTS}[ \\t]*(?:[;&|\\n)]|$))`,
  },
];

function isSafeWritePattern(match) {
  try {
    new RegExp(match);
  } catch {
    return false;
  }
  return !hasNestedQuantifier(match);
}

/**
 * Merge config write patterns over the defaults, by name, and compile them.
 * A config entry replaces the default of the same name in place; a new name is
 * appended. Entries whose regex does not compile or risks catastrophic
 * backtracking are dropped before the merge, so a default of the same name
 * survives. Never throws.
 * @param {object|null|undefined} bashConfig - Config `bash` section
 * @returns {{ name: string, match: string, re: RegExp }[]}
 */
export function resolveWritePatterns(bashConfig) {
  const merged = DEFAULT_WRITE_PATTERNS.map((p) => ({ name: p.name, match: p.match }));
  const custom = bashConfig && Array.isArray(bashConfig.writePatterns) ? bashConfig.writePatterns : [];

  for (const entry of custom) {
    if (!entry || typeof entry.name !== "string" || typeof entry.match !== "string") continue;
    if (!isSafeWritePattern(entry.match)) continue;
    const index = merged.findIndex((p) => p.name === entry.name);
    if (index >= 0) {
      merged[index] = { name: entry.name, match: entry.match };
    } else {
      merged.push({ name: entry.name, match: entry.match });
    }
  }

  const resolved = [];
  for (const p of merged) {
    try {
      resolved.push({ name: p.name, match: p.match, re: new RegExp(p.match) });
    } catch {
      // drop patterns that do not compile
    }
  }
  return resolved;
}

/**
 * Collect every file extension that any environment has checks for.
 * @param {object|null|undefined} config - Parsed checkmate.json
 * @returns {string[]} Extensions without leading dot, de-duplicated
 */
export function getCheckedExtensions(config) {
  const found = new Set();
  const environments = config && config.environments ? Object.values(config.environments) : [];

  for (const env of environments) {
    if (!env || !env.checks || typeof env.checks !== "object") continue;
    for (const key of Object.keys(env.checks)) {
      for (const part of key.split(",")) {
        const ext = part.trim().replace(/^\./, "");
        if (ext) found.add(ext);
      }
    }
  }
  return [...found];
}

const PATH_CHAR_RE = /^[\w.$~@/[\]-]$/;
const QUOTED_PATH_RE = /^[\w.$~@/[\]-](?:[\w.$~@/ [\]-]*[\w.$~@/[\]-])?$/;
const CD_UNSAFE_RE = /[$`*?[]/;
const CD_ARG_STOP_RE = /^[\s;&|()'"<>]$/;
const PATH_START_CHARS = " \t\n\r='\"(>";
const PATH_END_CHARS = " \t\n\r'\";)|&";
const QUOTED_PATH_MAX = 1024;

function hasAllowedExtension(token, extSet) {
  const dot = token.lastIndexOf(".");
  if (dot < 1 || token[dot - 1] === "/") return false;
  const ext = token.slice(dot + 1);
  if (extSet === null) return /^[A-Za-z]\w*$/.test(ext);
  return extSet.has(ext);
}

// Resolve a cd chain lazily: relative arguments accumulate and are joined in
// one path.resolve call, and the result is cached on the node.
function resolveCwd(node) {
  if (node.resolved !== null) return node.resolved;
  const args = [];
  let cur = node;
  while (cur.resolved === null) {
    args.push(cur.arg);
    cur = cur.up;
  }
  args.reverse();
  node.resolved = path.resolve(cur.resolved, args.join("/"));
  return node.resolved;
}

/**
 * Detect file writes in a Bash command. Pure: no fs access, no spawning.
 * One pass in source order; each candidate path resolves against the last
 * `cd` that precedes it. os.homedir() is read at most once, and only when a
 * ~ must expand.
 * @param {string} command
 * @param {{ patterns: { name: string, re: RegExp }[], baseDir: string, extensions: string[]|null }} options
 *   extensions: [] yields an empty result; null accepts any extension that starts with a letter.
 * @returns {{ matched: string[], paths: string[] }}
 */
export function detectBashWrites(command, { patterns, baseDir, extensions }) {
  const result = { matched: [], paths: [] };
  if (typeof command !== "string" || typeof baseDir !== "string" || baseDir === "") return result;
  if (extensions !== null && !(Array.isArray(extensions) && extensions.length > 0)) return result;

  const cmd = command.slice(0, BASH_SCAN_LIMIT);
  for (const p of patterns) {
    if (p.re.test(cmd)) result.matched.push(p.name);
  }
  if (result.matched.length === 0) return result;

  const extSet = extensions === null ? null : new Set(extensions);
  const len = cmd.length;
  const seen = new Set();
  let home = null;
  let cwd = { arg: "", up: null, resolved: path.resolve(baseDir), cache: new Map() };
  let prevCwd = null;
  let cmdWord = true;
  let i = 0;

  const homeDir = () => {
    if (home === null) home = os.homedir();
    return home;
  };
  const emit = (raw, expandTilde) => {
    const key = expandTilde ? "u" + raw : "q" + raw;
    if (cwd.cache.has(key)) return;
    const p = expandTilde && raw.startsWith("~/") ? homeDir() + raw.slice(1) : raw;
    const abs = path.resolve(resolveCwd(cwd), p);
    cwd.cache.set(key, abs);
    if (!seen.has(abs)) {
      seen.add(abs);
      result.paths.push(abs);
    }
  };

  while (i < len && seen.size < BASH_PATH_LIMIT) {
    const ch = cmd[i];

    if (ch === "\n" || ch === ";" || ch === "&" || ch === "|" || ch === "(") {
      cmdWord = true;
      i += 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      i += 1;
      continue;
    }

    if (cmdWord && ch === "c" && cmd.startsWith("cd", i) && (cmd[i + 2] === " " || cmd[i + 2] === "\t")) {
      cmdWord = false;
      let j = i + 2;
      while (cmd[j] === " " || cmd[j] === "\t") j += 1;
      let arg = "";
      let quoted = false;
      let end = j;
      const q = cmd[j];
      if (q === "'" || q === '"') {
        const close = cmd.indexOf(q, j + 1);
        if (close === -1) {
          end = j + 1;
        } else {
          quoted = true;
          end = close + 1;
          arg = cmd.slice(j + 1, close);
          if (arg.includes("\n")) arg = "";
        }
      } else {
        while (end < len && !CD_ARG_STOP_RE.test(cmd[end])) end += 1;
        arg = cmd.slice(j, end);
      }

      if (arg === "-") {
        if (prevCwd !== null) {
          const swap = cwd;
          cwd = prevCwd;
          prevCwd = swap;
        }
      } else if (arg !== "" && !CD_UNSAFE_RE.test(arg)) {
        const target = !quoted && (arg === "~" || arg.startsWith("~/")) ? homeDir() + arg.slice(1) : arg;
        prevCwd = cwd;
        cwd = path.isAbsolute(target)
          ? { arg: "", up: null, resolved: path.resolve(target), cache: new Map() }
          : { arg: target, up: cwd, resolved: null, cache: new Map() };
      }
      i = Math.max(end, i + 2);
      continue;
    }

    cmdWord = false;

    if (ch === "'" || ch === '"') {
      const close = cmd.indexOf(ch, i + 1);
      if (close !== -1 && close - i - 1 <= QUOTED_PATH_MAX) {
        const content = cmd.slice(i + 1, close);
        if (QUOTED_PATH_RE.test(content) && hasAllowedExtension(content, extSet)) {
          emit(content, false);
          // Content with an option word may wrap a command (bash -c "sed -i ... x.py"): scan inside too.
          i = /\s-/.test(content) ? i + 1 : close + 1;
          continue;
        }
      }
      i += 1;
      continue;
    }

    if (PATH_CHAR_RE.test(ch)) {
      let j = i + 1;
      while (j < len && PATH_CHAR_RE.test(cmd[j])) j += 1;
      const token = cmd.slice(i, j);
      // An empty string (start or end of command) counts as a boundary.
      const before = i === 0 ? "" : cmd[i - 1];
      const after = j >= len ? "" : cmd[j];
      if (PATH_START_CHARS.includes(before) && PATH_END_CHARS.includes(after) && hasAllowedExtension(token, extSet)) {
        emit(token, true);
      }
      i = j;
      continue;
    }

    i += 1;
  }
  return result;
}

// =============================================================================
// Git State Detection
// =============================================================================


const DEFAULT_GIT_CHECKS = {
  rebase: false,     // Disabled: formatting after commit N conflicts with patch N+1
  am: false,         // Disabled: sequential patch application (same issue as rebase)
  bisect: false,     // Disabled: any change corrupts historical state being tested
  merge: true,       // Enabled: single operation, safe to format
  cherryPick: true,  // Enabled: usually single commit; user can override for multi-pick
  revert: true,      // Enabled: single operation, safe to format
};

/**
 * Resolve the actual .git directory path.
 * Handles worktrees where .git is a file pointing to the real git dir.
 */
function getGitDir(projectRoot) {
  const gitPath = path.join(projectRoot, ".git");

  if (!existsSync(gitPath)) return null;

  try {
    const stat = statSync(gitPath);
    if (stat.isDirectory()) return gitPath;

    // .git is a file (worktree) - parse gitdir line
    const content = readFileSync(gitPath, "utf-8");
    const match = content.match(/^gitdir:\s*(.+)$/m);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Detect if repository is in a git operation state where running
 * checks could interfere. Uses file-based detection for speed and reliability.
 */
export function detectGitOperation(projectRoot) {
  const gitDir = getGitDir(projectRoot);
  if (!gitDir) return null;

  // Modern git uses merge backend (rebase-merge), legacy uses apply backend (rebase-apply)
  if (existsSync(path.join(gitDir, "rebase-merge"))) return "rebase";

  // git am creates rebase-apply with an "applying" marker file
  if (existsSync(path.join(gitDir, "rebase-apply", "applying"))) return "am";

  // rebase --apply creates rebase-apply without "applying" marker
  if (existsSync(path.join(gitDir, "rebase-apply"))) return "rebase";

  // Other operations - check their HEAD files
  if (existsSync(path.join(gitDir, "BISECT_LOG"))) return "bisect";
  if (existsSync(path.join(gitDir, "CHERRY_PICK_HEAD"))) return "cherryPick";
  if (existsSync(path.join(gitDir, "REVERT_HEAD"))) return "revert";
  if (existsSync(path.join(gitDir, "MERGE_HEAD"))) return "merge";

  return null;
}

/**
 * Check if quality checks should be skipped for the current git operation.
 */
export function shouldSkipForGitOperation(config, projectRoot) {
  const operation = detectGitOperation(projectRoot);
  if (!operation) return { skip: false };

  const gitConfig = config?.git ?? {};
  const enabled = gitConfig[operation] ?? DEFAULT_GIT_CHECKS[operation];

  return { skip: !enabled, operation };
}

// =============================================================================
// Output Helpers
// =============================================================================

function formatDiagnostic(d) {
  const icon = d.severity === "error" ? "X" : "!";
  const location = d.line
    ? `[Line ${d.line}${d.column ? `:${d.column}` : ""}]`
    : "";
  const rule = d.rule ? ` [${d.rule}]` : "";
  const source = `(${d.source})`;

  return `  ${icon} ${location} ${d.message}${rule} ${source}`;
}

export function formatDiagnosticsBlock(diags, fileName) {
  const lines = diags.map((d) => formatDiagnostic(d));
  return `<new-diagnostics>\n${fileName}:\n${lines.join("\n")}\n</new-diagnostics>`;
}

/**
 * Format the set of commands checkmate ran into a reproduce-with block,
 * de-duplicated so repeated failures on the same check don't repeat lines.
 * @param {string[]} commands - Resolved command strings from failed checks
 * @returns {string}
 */
export function formatCommandsBlock(commands) {
  const lines = [...new Set(commands)].map((c) => `  ${c}`);
  return `<reproduce-with>\n${lines.join("\n")}\n</reproduce-with>`;
}

// =============================================================================
// Bash Config Validation
// =============================================================================

const BASH_KEYS = ["enabled", "maxFiles", "writePatterns"];

/**
 * Detect catastrophic-backtracking risks (best effort). R1: an unbounded
 * repeat applied to a group that itself contains an unbounded repeat. R2: an
 * unbounded repeat (+, * or {n,}) applied to a group whose own top level
 * contains |. Character-class contents and escaped characters are ignored;
 * `?` is not a repeat.
 */
export function hasNestedQuantifier(source) {
  const stack = [];
  let current = false;
  let currentAlt = false;
  let closedWithRepeat = false;
  let closedWithAlt = false;
  let i = 0;

  while (i < source.length) {
    const ch = source[i];
    let repeat = false;
    let closedGroup = false;

    if (ch === "\\") {
      i += 2;
      closedWithRepeat = false;
      closedWithAlt = false;
      continue;
    }
    if (ch === "[") {
      i += 1;
      while (i < source.length && source[i] !== "]") {
        i += source[i] === "\\" ? 2 : 1;
      }
      i += 1;
      closedWithRepeat = false;
      closedWithAlt = false;
      continue;
    }
    if (ch === "(") {
      stack.push({ repeat: current, alt: currentAlt });
      current = false;
      currentAlt = false;
    } else if (ch === ")") {
      closedGroup = true;
      closedWithRepeat = current;
      closedWithAlt = currentAlt;
      const parent = stack.length > 0 ? stack.pop() : { repeat: false, alt: false };
      current = parent.repeat || current;
      currentAlt = parent.alt;
    } else if (ch === "|") {
      currentAlt = true;
    } else if (ch === "+" || ch === "*") {
      repeat = true;
    } else if (ch === "{") {
      const m = /^\{\d+,\}/.exec(source.slice(i));
      if (m) {
        repeat = true;
        i += m[0].length - 1;
      }
    }

    if (repeat) {
      if (closedWithRepeat || closedWithAlt) return true;
      current = true;
    }
    if (!closedGroup) {
      closedWithRepeat = false;
      closedWithAlt = false;
    }
    i += 1;
  }

  return false;
}

/**
 * Validate the optional `bash` config section.
 * @param {*} bash - Value of config.bash
 * @returns {string[]} Errors, each prefixed `bash.`
 */
export function validateBash(bash) {
  const errors = [];

  if (typeof bash !== "object" || bash === null || Array.isArray(bash)) {
    errors.push("bash: must be an object");
    return errors;
  }

  for (const key of Object.keys(bash)) {
    if (!BASH_KEYS.includes(key)) {
      errors.push(`bash.${key}: unknown key (valid: ${BASH_KEYS.join(", ")})`);
    }
  }

  if (bash.enabled !== undefined && typeof bash.enabled !== "boolean") {
    errors.push("bash.enabled: must be a boolean");
  }

  if (bash.maxFiles !== undefined) {
    if (!Number.isInteger(bash.maxFiles) || bash.maxFiles < 1) {
      errors.push("bash.maxFiles: must be a positive integer");
    }
  }

  if (bash.writePatterns !== undefined) {
    if (!Array.isArray(bash.writePatterns)) {
      errors.push("bash.writePatterns: must be an array");
      return errors;
    }
    const names = new Set();
    for (let i = 0; i < bash.writePatterns.length; i++) {
      const entry = bash.writePatterns[i];
      const prefix = `bash.writePatterns[${i}]`;
      if (!entry || typeof entry !== "object") {
        errors.push(`${prefix}: must be an object`);
        continue;
      }
      if (typeof entry.name !== "string" || entry.name === "") {
        errors.push(`${prefix}.name: required non-empty string`);
      } else if (names.has(entry.name)) {
        errors.push(`${prefix}.name: duplicate name "${entry.name}"`);
      } else {
        names.add(entry.name);
      }
      if (typeof entry.match !== "string") {
        errors.push(`${prefix}.match: required string`);
      } else {
        let compiled = true;
        try {
          new RegExp(entry.match);
        } catch (e) {
          compiled = false;
          errors.push(`${prefix}.match: invalid regex - ${e.message}`);
        }
        if (compiled && hasNestedQuantifier(entry.match)) {
          errors.push(`${prefix}.match: nested quantifier or repeated alternation risks catastrophic backtracking`);
        }
      }
    }
  }

  return errors;
}

/**
 * Select the config that governs a resolved file root.
 * worktree: the worktree's own config, else the session config.
 * nested-repo: the nested repo's own config only (never the parent's).
 * project (and anything else): the session config.
 * @param {{root: string, kind: string}} resolved - Result of resolveFileRoot
 * @param {object|null} sessionConfig - Config loaded for the session root
 * @returns {object|null}
 */
export function resolveOwningConfig(resolved, sessionConfig) {
  try {
    if (resolved.kind === "worktree") {
      return loadConfig(resolved.root).config || sessionConfig || null;
    }
    if (resolved.kind === "nested-repo") {
      return loadConfig(resolved.root).config || null;
    }
    return sessionConfig || null;
  } catch {
    return null;
  }
}

/**
 * Build the pass() status text for a check outcome.
 * @param {{skippedReason: string|null, statusLine: string, results: object[]}} outcome
 * @returns {string}
 */
export function formatOutcomeStatus(outcome) {
  if (outcome.skippedReason) return outcome.skippedReason;
  const skipMessages = (outcome.results || [])
    .filter((r) => r.skipped)
    .map((r) => r.skipMessage)
    .filter(Boolean);
  if (skipMessages.length === 0) return outcome.statusLine;
  return `${outcome.statusLine} | ${skipMessages.join("; ")}`;
}
