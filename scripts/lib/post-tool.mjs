/**
 * post-tool.mjs
 * PostToolUse hook: Check formatting, linting, and types for edited files
 *
 * Reads checkmate.json from .claude/ directory to determine which commands
 * to run for each file type. Config-driven approach allows users to adapt
 * checks to their specific toolchain.
 *
 * Exit codes: 0 = continue, 2 = block with feedback
 *
 * NOTE: Auto-fix disabled to prevent file state desynchronization.
 * Claude must fix issues manually to maintain consistent file state.
 */

import { execSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  loadConfig,
  readStdinJson,
  pass,
  block,
  resolveFileRoot,
  fileMatchesPaths,
  matchesExcludePattern,
} from "./lib.mjs";
import { validateConfig } from "./validate.mjs";

// =============================================================================
// Config schema (array format):
// {
//   "environments": [
//     {
//       "name": "root",
//       "paths": ["."],
//       "exclude": ["vendor/**"],
//       "checks": {
//         ".py": [
//           { "name": "ruff", "command": "uv", "args": ["run", "ruff", "check", "$FILE"], "parser": "ruff" }
//         ],
//         ".ts,.tsx": [
//           { "name": "eslint", "command": "pnpm", "args": ["exec", "eslint", "$FILE"], "parser": "eslint" }
//         ]
//       }
//     }
//   ]
// }
//
// Parser can be:
// - string: predefined parser name (ruff, ty, eslint, oxlint, tsc, prettier, biome, generic, jsonl, gcc)
// - object: { pattern: "regex with named groups", severity?: "error"|"warning" }
//   Named groups: line, column, message, rule, severity (all optional)
// =============================================================================

/**
 * Get checks for a file extension from an environment's checks config.
 */
function getChecksForExtension(checksConfig, ext) {
  if (!checksConfig) return [];

  if (checksConfig[ext]) {
    return checksConfig[ext];
  }

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
 * Returns { checks: [], reason: string } where reason explains why no checks ran.
 */
function getChecksForFile(config, filePath, projectRoot) {
  const ext = path.extname(filePath);
  const relativePath = path.relative(projectRoot, filePath);

  if (!config?.environments || !Array.isArray(config.environments)) {
    return { checks: [], reason: "no-config" };
  }

  for (const env of config.environments) {
    if (!env.paths || !Array.isArray(env.paths)) continue;

    if (!fileMatchesPaths(relativePath, env.paths)) continue;

    if (env.exclude && Array.isArray(env.exclude)) {
      const matchedPattern = env.exclude.find((pattern) =>
        matchesExcludePattern(relativePath, pattern)
      );
      if (matchedPattern) {
        const hasChecksForExt = getChecksForExtension(env.checks, ext).length > 0;
        if (hasChecksForExt) {
          return { checks: [], reason: "path-excluded", pattern: matchedPattern, env: env.name };
        }
        continue;
      }
    }

    const checks = getChecksForExtension(env.checks, ext);
    if (checks.length > 0) {
      return { checks, reason: "ok" };
    }
    return { checks: [], reason: "no-checks-for-extension" };
  }

  return { checks: [], reason: "no-matching-environment" };
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
function detectGitOperation(projectRoot) {
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
function shouldSkipForGitOperation(config, projectRoot) {
  const operation = detectGitOperation(projectRoot);
  if (!operation) return { skip: false };

  const gitConfig = config?.git ?? {};
  const enabled = gitConfig[operation] ?? DEFAULT_GIT_CHECKS[operation];

  return { skip: !enabled, operation };
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
    error: result.error || null,
  };
}

function truncateOutput(output, lines) {
  return output.split("\n").slice(0, lines).join("\n");
}

/**
 * Shell-quote a single token, shlex.quote-style: wrap in single quotes if it
 * contains shell-unsafe characters (or is empty), escaping embedded quotes.
 */
function shellQuote(token) {
  if (token !== "" && !/[^A-Za-z0-9_@%+=:,./-]/.test(token)) {
    return token;
  }
  return `'${token.replace(/'/g, "'\\''")}'`;
}

/**
 * Build a display string of the command checkmate ran, with $FILE resolved to
 * a project-relative path. Surfaced on failure so a manual fix reuses the
 * configured flags (e.g. shfmt's `-i 2`) instead of the tool's defaults.
 * Tokens containing shell-unsafe characters are single-quoted so the string
 * is copy-paste safe.
 * @param {string} command - The check's command name
 * @param {string[]} args - The check's raw args, with $FILE placeholder
 * @param {string} filePath - Absolute path to the file being checked
 * @param {string} projectRoot - Absolute path to the project root
 * @returns {string}
 */
export function resolveCommand(command, args, filePath, projectRoot) {
  const rel = path.relative(projectRoot, filePath);
  const resolvedArgs = args.map((arg) =>
    arg === "$FILE" ? rel : arg.replace("$FILE", rel)
  );
  return [command, ...resolvedArgs].map(shellQuote).join(" ");
}

// =============================================================================
// Output Parsers
// =============================================================================

const parsers = {
  ruff(output) {
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

  oxlint(output) {
    const results = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const match = line.match(/:(\d+):(\d+): (.+) \[(\w+)\/(.+)\]$/);
      if (match) {
        results.push({
          line: parseInt(match[1], 10),
          column: parseInt(match[2], 10),
          message: match[3],
          rule: match[5],
          severity: match[4].toLowerCase() === "error" ? "error" : "warning",
        });
      }
    }
    return results;
  },

  tsc(output) {
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
    if (output.includes("would be reformatted") || output.trim()) {
      return [{ message: "File needs formatting", severity: "error" }];
    }
    return [];
  },

  biome(output) {
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
    const trimmed = output.trim();
    if (trimmed) {
      return [{ message: truncateOutput(trimmed, 5), severity: "error" }];
    }
    return [];
  },

  jsonl(output) {
    const results = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.file && typeof obj.line === "number" && obj.message) {
          results.push({
            line: obj.line,
            column: typeof obj.column === "number" ? obj.column : 1,
            message: obj.message,
            severity: "error",
          });
        }
      } catch {
        // Skip non-JSON lines
      }
    }
    return results;
  },

  gcc(output) {
    const results = [];
    const lines = output.split("\n").filter((l) => l.trim());

    for (const line of lines) {
      const match = line.match(/:(\d+):(\d+):\s*(error|warning|note|info):\s*(.+)$/i);
      if (match) {
        const message = match[4].trim();
        const ruleMatch = message.match(/\[([^\]]+)\]$/);
        results.push({
          line: parseInt(match[1], 10),
          column: parseInt(match[2], 10),
          message: ruleMatch ? message.replace(/\s*\[[^\]]+\]$/, "") : message,
          rule: ruleMatch ? ruleMatch[1] : undefined,
          severity: match[3].toLowerCase() === "error" ? "error" : "warning",
        });
      }
    }
    return results;
  },
};

/**
 * Create a parser function from an inline regex config
 */
function createRegexParser(config) {
  const regex = new RegExp(config.pattern, "gm");
  const defaultSeverity = config.severity || "error";

  return function regexParser(output) {
    const results = [];
    const lines = output.split("\n");

    for (const line of lines) {
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
 */
function getParser(parserConfig) {
  if (!parserConfig) {
    return parsers.generic;
  }

  if (typeof parserConfig === "string") {
    return parsers[parserConfig] || parsers.generic;
  }

  if (typeof parserConfig === "object" && parserConfig.pattern) {
    try {
      return createRegexParser(parserConfig);
    } catch (err) {
      return parsers.generic;
    }
  }

  return parsers.generic;
}

// =============================================================================
// Check Runner
// =============================================================================

const ROOT_LOCKFILE_MANAGERS = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lockb": "bun",
};

/**
 * Determine the install command hint from a root lockfile, defaulting to npm.
 */
function getInstallHint(projectRoot) {
  try {
    for (const [lockfile, manager] of Object.entries(ROOT_LOCKFILE_MANAGERS)) {
      if (existsSync(path.join(projectRoot, lockfile))) {
        return `${manager} install`;
      }
    }
  } catch {
    // fail open - fall through to default hint
  }
  return "npm install";
}

/**
 * Find the first missing path among the command and its substituted args.
 * Only path-like values (containing a path separator, not flags) are checked.
 */
function findMissingPath(command, args, projectRoot) {
  const hasSeparator = (value) => value.includes("/") || value.includes(path.sep);
  const candidates = [];

  if (hasSeparator(command)) {
    candidates.push(command);
  }
  for (const arg of args) {
    if (typeof arg === "string" && hasSeparator(arg) && !arg.startsWith("-")) {
      candidates.push(arg);
    }
  }

  for (const candidate of candidates) {
    try {
      if (!existsSync(path.resolve(projectRoot, candidate))) {
        return candidate;
      }
    } catch {
      // fail open - skip this candidate
    }
  }

  return null;
}

/**
 * Build a skip diagnostic, appending an install hint when the missing path
 * lives under node_modules.
 */
function skipDiagnostic(missingRef, checkName, projectRoot) {
  let message = `${missingRef} not found - skipping ${checkName}`;
  if (missingRef.includes("node_modules")) {
    message += ` (run ${getInstallHint(projectRoot)})`;
  }
  return { diagnostics: [{ message, source: checkName, severity: "warning" }], skipped: true, command: null };
}

function runCheck(check, filePath, projectRoot) {
  const diagnostics = [];

  if (!commandExists(check.command)) {
    return skipDiagnostic(check.command, check.name, projectRoot);
  }

  const args = check.args.map((arg) =>
    arg === "$FILE" ? filePath : arg.replace("$FILE", filePath)
  );

  const missingPath = findMissingPath(check.command, args, projectRoot);
  if (missingPath) {
    return skipDiagnostic(missingPath, check.name, projectRoot);
  }

  const result = runCommand(check.command, args, projectRoot);

  if (!result.success) {
    if (result.error?.code === "ENOENT") {
      return skipDiagnostic(check.command, check.name, projectRoot);
    }

    const combined = result.stdout + result.stderr;

    if (/MODULE_NOT_FOUND|Cannot find module/.test(combined)) {
      let message = `${check.name} skipped - module not found`;
      if (combined.includes("node_modules")) {
        message += ` (run ${getInstallHint(projectRoot)})`;
      }
      return {
        diagnostics: [{ message, source: check.name, severity: "warning" }],
        skipped: true,
        command: null,
      };
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
      diagnostics.push({
        message: truncateOutput(combined, 3),
        source: check.name,
        severity: "error",
      });
    }

    return {
      diagnostics,
      skipped: false,
      command: resolveCommand(check.command, check.args, filePath, projectRoot),
    };
  }

  return { diagnostics, skipped: false, command: null };
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

function formatDiagnosticsBlock(diags, fileName) {
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
// Validate config file directly (no subprocess)
// =============================================================================

function validateConfigFile(configPath) {
  let content;
  try {
    content = fs.readFileSync(configPath, "utf-8");
  } catch {
    return { valid: false, errors: [{ path: "", message: `Cannot read ${configPath}` }] };
  }

  let config;
  try {
    config = JSON.parse(content);
  } catch (err) {
    return { valid: false, errors: [{ path: "", message: `Invalid JSON: ${err.message}` }] };
  }

  const results = validateConfig(config);

  if (results.errors.length === 0) {
    return { valid: true, errors: [] };
  }

  const errors = results.errors.map((msg) => {
    const colonIndex = msg.indexOf(": ");
    if (colonIndex > 0) {
      return { path: msg.substring(0, colonIndex), message: msg.substring(colonIndex + 2) };
    }
    return { path: "", message: msg };
  });

  return { valid: false, errors };
}

// =============================================================================
// Main
// =============================================================================

export async function run() {
  const input = await readStdinJson();
  let filePath = input.tool_input?.file_path;

  // No file path provided - skip silently
  if (!filePath) {
    pass("No file path provided");
  }

  // File doesn't exist - skip silently
  if (!fs.existsSync(filePath)) {
    pass(`File not found: ${filePath}`);
  }

  // Load config
  const { config: sessionConfig, projectRoot } = loadConfig();
  if (!projectRoot) {
    pass("CLAUDE_PROJECT_DIR not set - hook requires Claude Code environment");
  }

  // A project's checks only ever apply to that project's own files. Files
  // outside the root, in a linked worktree, or in a nested repo/submodule
  // each need their own config selection - see resolveFileRoot in lib.mjs.
  // resolveFileRoot returns filePath realpath'd into the same coordinate
  // space as root; every downstream use of filePath must be this resolved
  // value, never the raw tool_input path, or a symlinked ancestor puts
  // path.relative(root, filePath) in 2 different coordinate spaces.
  const { root, kind, filePath: resolvedFilePath } = resolveFileRoot(filePath, projectRoot);
  filePath = resolvedFilePath;

  if (kind === "outside") {
    pass("skipped (outside project)");
  }

  const isConfigFile = filePath.endsWith(".claude/checkmate.json");

  // root is a terminator (see resolveFileRoot): it stops the upward walk
  // but grants no config by itself. Its type decides the fallback when it
  // has no checkmate.json of its own - worktree is the same repo in a
  // different checkout, so the session config legitimately reaches it;
  // nested-repo is a different project, so the parent's config must not
  // reach in.
  let config = sessionConfig;
  if (kind === "worktree") {
    // Same repo, same tracked config; fall back to the session config if
    // the worktree itself has no (untracked/gitignored) checkmate.json.
    config = loadConfig(root).config || sessionConfig;
  } else if (kind === "nested-repo") {
    // A different repo must own itself; the parent must never impose its
    // toolchain on a nested repo or submodule that hasn't shipped its own
    // config. A missing config still falls through to the shared
    // !config && !isConfigFile guard below, so an invalid (unparsable)
    // checkmate.json in the nested repo still reaches the schema
    // self-check instead of passing silently.
    config = loadConfig(root).config;
  }

  // No config and not editing the config file - nothing to do
  if (!config && !isConfigFile) {
    pass(
      kind === "nested-repo"
        ? "skipped (nested repo has no checkmate.json)"
        : "disabled (run /checkmate:init to configure)"
    );
  }

  // Skip during certain git operations
  const gitCheck = shouldSkipForGitOperation(config, root);
  if (gitCheck.skip) {
    pass(`skipped (git ${gitCheck.operation} in progress)`);
  }

  const diagnostics = [];

  // Run configured checks (if config exists and checks are configured)
  // Results track declaration order: { name, passed }
  let checkResult = { checks: [], reason: "no-config" };
  const results = [];
  const commands = [];
  let hasFailures = false;

  if (config) {
    checkResult = getChecksForFile(config, filePath, root);
    for (const check of checkResult.checks) {
      const { diagnostics: checkDiagnostics, skipped, command } = runCheck(check, filePath, root);
      if (skipped) {
        results.push({ name: check.name, passed: true, skipped: true, skipMessage: checkDiagnostics[0]?.message });
        continue;
      }
      if (checkDiagnostics.length > 0) {
        results.push({ name: check.name, passed: false });
        hasFailures = true;
        diagnostics.push(...checkDiagnostics);
        if (command) commands.push(command);
      } else {
        results.push({ name: check.name, passed: true });
      }
    }
  }

  // Self-check: validate checkmate.json schema when it's edited
  if (isConfigFile) {
    const validationResult = validateConfigFile(filePath);
    if (!validationResult.valid) {
      results.push({ name: "schema", passed: false });
      hasFailures = true;
      for (const err of validationResult.errors) {
        diagnostics.push({
          message: err.message,
          rule: err.path || "schema",
          source: "schema",
          severity: "error",
        });
      }
    } else {
      results.push({ name: "schema", passed: true });
    }
  }

  const fileName = path.basename(filePath);
  const statusLine = results
    .map((r) => {
      if (r.skipped) return `\u2298 ${r.name}`;
      return `${r.passed ? "\u2705" : "\u274C"} ${r.name}`;
    })
    .join(" ");

  // Any diagnostics found - block
  if (hasFailures) {
    let reason = formatDiagnosticsBlock(diagnostics, fileName);
    if (commands.length > 0) {
      reason += "\n" + formatCommandsBlock(commands);
    }
    block(reason, statusLine);
  }

  // Determine if any checks ran and provide appropriate message
  const checksRan = checkResult.checks.length > 0;

  if (!checksRan && !isConfigFile) {
    pass(checkResult.reason === "path-excluded" ? "excluded" : "skipped");
  }

  // All clean - approve, but surface why any check was skipped
  const skipMessages = results.filter((r) => r.skipped).map((r) => r.skipMessage).filter(Boolean);
  const finalStatus = skipMessages.length > 0
    ? `${statusLine} | ${skipMessages.join("; ")}`
    : statusLine;
  pass(finalStatus);
}
