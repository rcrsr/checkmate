/**
 * post-bash.mjs
 * PostToolUse hook: run the configured checks on files a Bash command wrote.
 *
 * Detection is heuristic (see detectBashWrites in lib.mjs); a candidate path is
 * only checked once git confirms it is dirty, so a command that merely names a
 * file does not trigger checks. Every no-op path exits silently.
 *
 * This hook never modifies files.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadConfig,
  readStdinJson,
  pass,
  block,
  resolveFileRoot,
  resolveOwningConfig,
  formatOutcomeStatus,
  resolveWritePatterns,
  getCheckedExtensions,
  detectBashWrites,
  shouldSkipForGitOperation,
  formatDiagnosticsBlock,
  formatCommandsBlock,
} from "./lib.mjs";
// Deviation from handlers importing only lib.mjs: checkFile needs
// validateConfig and the parsers object, which stay in post-tool.mjs.
import { checkFile } from "./post-tool.mjs";

const DEFAULT_MAX_FILES = 10;
const BASH_CHECK_BUDGET_MS = 2000;
const CONFIG_FILE_SUFFIX = ".claude/checkmate.json";

function realpathOrSelf(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * Parse `git status --porcelain -z` output into the set of changed paths
 * (relative to the repo top level). Deleted entries are dropped; the second
 * path of a rename/copy entry is consumed.
 */
function parsePorcelain(output) {
  const changed = [];
  const fields = output.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    if (entry.length < 4) continue;
    const x = entry[0];
    const y = entry[1];
    const file = entry.slice(3);
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      i += 1;
    }
    if (x === "D" || y === "D") continue;
    changed.push(file);
  }
  return changed;
}

/**
 * Ask git which of `files` (absolute, all under one root) are dirty.
 * @returns {Set<string>|null} Absolute dirty paths, or null if git failed
 */
function dirtyFilesInRoot(root, files) {
  try {
    const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: root,
      encoding: "utf-8",
    });
    if (top.error || top.status !== 0) return null;
    const topLevel = realpathOrSelf(top.stdout.trim());

    const status = spawnSync(
      "git",
      ["--no-optional-locks", "-c", "core.fsmonitor=", "status", "--porcelain", "-z", "--untracked-files=all", "--", ...files],
      { cwd: root, encoding: "utf-8" },
    );
    if (status.error || status.status !== 0) return null;

    const dirty = new Set();
    for (const rel of parsePorcelain(status.stdout || "")) {
      dirty.add(path.resolve(topLevel, rel));
    }
    return dirty;
  } catch {
    return null;
  }
}

/**
 * Keep only candidates that git reports as dirty; fall back to "file exists"
 * for a root where git fails. Order of first appearance is preserved.
 */
function confirmWrittenFiles(candidates) {
  const byRoot = new Map();
  for (const c of candidates) {
    if (!byRoot.has(c.root)) byRoot.set(c.root, []);
    byRoot.get(c.root).push(c.filePath);
  }

  const confirmed = new Set();
  for (const [root, files] of byRoot) {
    const dirty = dirtyFilesInRoot(root, files);
    for (const file of files) {
      const keep = dirty ? dirty.has(file) : fs.existsSync(file);
      if (keep) confirmed.add(file);
    }
  }
  return [...confirmed];
}

function resolveMaxFiles(sessionConfig) {
  const rawMax = sessionConfig?.bash?.maxFiles;
  return Number.isInteger(rawMax) && rawMax > 0 ? rawMax : DEFAULT_MAX_FILES;
}

/**
 * Detect candidate files, drop those outside the project, keep those the
 * owning config checks, and confirm via git. Any error means "no write found".
 * @returns {{ files: string[], gitSkip: string|null }} Confirmed absolute paths, or the git operation in progress
 */
function findWrittenFiles(input, sessionConfig, projectRoot, maxFiles) {
  try {
    const bash = sessionConfig?.bash || {};
    const baseDir =
      typeof input.cwd === "string" && input.cwd !== "" && path.isAbsolute(input.cwd) ? input.cwd : projectRoot;

    const detected = detectBashWrites(input.tool_input.command, {
      patterns: resolveWritePatterns(bash),
      extensions: null,
      baseDir,
    });

    const ownerByRoot = new Map();
    const extensionsByRoot = new Map();
    const seen = new Set();
    const candidates = [];
    const limit = 3 * maxFiles;
    for (const p of detected.paths) {
      if (candidates.length >= limit) break;
      const resolved = resolveFileRoot(p, projectRoot);
      if (resolved.kind === "outside") continue;
      if (seen.has(resolved.filePath)) continue;

      let eligible = resolved.filePath.endsWith(CONFIG_FILE_SUFFIX);
      if (!eligible) {
        if (!ownerByRoot.has(resolved.root)) {
          const owner = resolveOwningConfig(resolved, sessionConfig);
          ownerByRoot.set(resolved.root, owner);
          extensionsByRoot.set(resolved.root, getCheckedExtensions(owner));
        }
        const ext = path.extname(resolved.filePath).slice(1);
        eligible = ext !== "" && extensionsByRoot.get(resolved.root).includes(ext);
      }
      if (!eligible) continue;

      seen.add(resolved.filePath);
      candidates.push({ root: resolved.root, filePath: resolved.filePath });
    }
    if (candidates.length === 0) return { files: [], gitSkip: null };

    const gitCheck = shouldSkipForGitOperation(sessionConfig, projectRoot);
    if (gitCheck.skip) return { files: [], gitSkip: gitCheck.operation };

    return { files: confirmWrittenFiles(candidates), gitSkip: null };
  } catch {
    return { files: [], gitSkip: null };
  }
}

export async function run() {
  let input;
  try {
    input = await readStdinJson();
  } catch {
    return;
  }

  if (!input || input.tool_name !== "Bash") return;
  const command = input.tool_input?.command;
  if (typeof command !== "string" || command.trim() === "") return;
  if (input.tool_input.run_in_background === true) return;

  const { config: sessionConfig, projectRoot } = loadConfig();
  if (!projectRoot) return;
  if (sessionConfig?.bash?.enabled === false) return;

  const maxFiles = resolveMaxFiles(sessionConfig);
  const { files, gitSkip } = findWrittenFiles(input, sessionConfig, projectRoot, maxFiles);
  if (gitSkip) {
    pass(`skipped (git ${gitSkip} in progress)`);
  }
  if (files.length === 0) return;

  const slice = files.slice(0, maxFiles);
  const overflow = files.slice(maxFiles);

  const realRoot = realpathOrSelf(projectRoot);
  const relOf = (f) => path.relative(realRoot, f);

  const outcomes = [];
  const started = performance.now();
  let budgetSkipped = [];
  for (let i = 0; i < slice.length; i++) {
    if (i > 0 && performance.now() - started >= BASH_CHECK_BUDGET_MS) {
      budgetSkipped = slice.slice(i);
      break;
    }
    outcomes.push({ rel: relOf(slice[i]), outcome: checkFile(slice[i], projectRoot, sessionConfig) });
  }

  const notices = [];
  if (overflow.length > 0) {
    notices.push(`${overflow.length} file(s) over maxFiles skipped: ${overflow.map(relOf).join(",")}`);
  }
  if (budgetSkipped.length > 0) {
    notices.push(`${budgetSkipped.length} file(s) skipped (time budget): ${budgetSkipped.map(relOf).join(",")}`);
  }

  const failing = outcomes.filter((o) => o.outcome.hasFailures);
  if (failing.length > 0) {
    const blocks = failing.map((o) => formatDiagnosticsBlock(o.outcome.diagnostics, o.rel));
    const commands = failing.flatMap((o) => o.outcome.commands);
    let reason = blocks.join("\n");
    if (commands.length > 0) {
      reason += "\n" + formatCommandsBlock(commands);
    }
    for (const notice of notices) {
      reason += "\n" + notice;
    }
    let message = failing.map((o) => `${o.rel}: ${o.outcome.statusLine}`).join(" | ");
    if (notices.length > 0) message += `; ${notices.join("; ")}`;
    block(reason, message);
  }

  if (notices.length === 0 && outcomes.every((o) => o.outcome.skippedReason)) return;

  let message = outcomes.map((o) => `${o.rel}: ${formatOutcomeStatus(o.outcome)}`).join(" | ");
  if (notices.length > 0) message += `; ${notices.join("; ")}`;
  pass(message);
}
