/**
 * scan-bash.mjs
 * CLI command: replay recorded Bash commands from Claude Code transcripts
 * through the Bash-write detector and print one JSON report.
 *
 * Usage:
 *   node checkmate.mjs scan-bash [--transcripts <dir>] [--patterns <file>]
 *
 * Exit codes:
 *   0 = report printed
 *   1 = patterns file fails bash validation (errors on stderr)
 *   2 = missing directory, unreadable/invalid patterns file, or unknown argument
 *
 * Transcripts are streamed line by line. Detection itself lives in lib.mjs.
 */

import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import {
  loadConfig,
  resolveWritePatterns,
  getCheckedExtensions,
  detectBashWrites,
} from "./lib.mjs";
import { validateBash } from "./validate.mjs";

const PATTERN_SAMPLE_LIMIT = 5;
const MISS_SAMPLE_LIMIT = 20;
const TOP_PATHS_LIMIT = 50;
const SAMPLE_MAX_CHARS = 200;
const SLOW_MS_PER_1000 = 5;
const MISS_COMMAND_RE = /\b(?:mv|cp|patch|ed)\b|\bgit\s+apply\b/;

/**
 * Parse argv into options. Returns an error message for an unknown argument.
 */
function parseArgs(args) {
  const opts = { transcripts: null, patterns: null, error: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--transcripts" || arg === "--patterns") {
      const value = args[i + 1];
      if (value === undefined) {
        opts.error = `missing value for ${arg}`;
        return opts;
      }
      opts[arg.slice(2)] = value;
      i += 1;
    } else {
      opts.error = `unknown argument: ${arg}`;
      return opts;
    }
  }
  return opts;
}

/**
 * Claude Code names a project's transcript directory after its root with every
 * non-alphanumeric character replaced by "-".
 */
function encodeProjectDir(projectRoot) {
  return projectRoot.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Recursively collect *.jsonl files, sorted by full path.
 */
function findTranscripts(dir) {
  const found = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...findTranscripts(full));
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      found.push(full);
    }
  }
  return found.sort();
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function truncate(command) {
  return command.length > SAMPLE_MAX_CHARS ? command.slice(0, SAMPLE_MAX_CHARS) : command;
}

/**
 * Wrap compiled patterns so each test() call is counted and timed.
 * The wrapper exposes the same `re.test` surface detectBashWrites expects.
 */
function instrumentPatterns(patterns, stats, currentCommand) {
  return patterns.map((p) => {
    const stat = { name: p.name, calls: 0, ns: 0n, hits: 0, samples: [] };
    stats.push(stat);
    return {
      name: p.name,
      re: {
        test: (text) => {
          const start = process.hrtime.bigint();
          const result = p.re.test(text);
          stat.ns += process.hrtime.bigint() - start;
          stat.calls += 1;
          if (result) {
            stat.hits += 1;
            if (stat.samples.length < PATTERN_SAMPLE_LIMIT) {
              stat.samples.push(truncate(currentCommand.value));
            }
          }
          return result;
        },
      },
    };
  });
}

function relativeInside(abs, projectRoot) {
  const rel = path.relative(projectRoot, abs);
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    return null;
  }
  return rel;
}

export async function run() {
  const opts = parseArgs(process.argv.slice(3));
  if (opts.error) {
    console.error(`scan-bash: ${opts.error}`);
    console.error("Usage: node checkmate.mjs scan-bash [--transcripts <dir>] [--patterns <file>]");
    process.exitCode = 2;
    return;
  }

  const projectRoot = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const { config } = loadConfig(projectRoot);

  let bashConfig = config ? config.bash : null;
  if (opts.patterns !== null) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(opts.patterns, "utf-8"));
    } catch (err) {
      console.error(`scan-bash: cannot read patterns file ${opts.patterns}: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    const errors = validateBash(parsed);
    if (errors.length > 0) {
      for (const error of errors) console.error(error);
      process.exitCode = 1;
      return;
    }
    bashConfig = parsed;
  }

  const transcriptsDir =
    opts.transcripts !== null
      ? opts.transcripts
      : path.join(os.homedir(), ".claude", "projects", encodeProjectDir(projectRoot));
  if (!isDirectory(transcriptsDir)) {
    console.error(`scan-bash: transcripts directory not found: ${transcriptsDir}`);
    process.exitCode = 2;
    return;
  }

  const extensions = getCheckedExtensions(config);
  const patternStats = [];
  const currentCommand = { value: "" };
  const patterns = instrumentPatterns(resolveWritePatterns(bashConfig), patternStats, currentCommand);
  const anyPattern = [{ name: "any", re: { test: () => true } }];

  const files = findTranscripts(transcriptsDir);
  const report = { commands: 0, unparsableLines: 0, gated: 0, withPaths: 0, noPath: 0, outsideOnly: 0 };
  const pathCounts = new Map();
  const misses = { count: 0, samples: [] };

  for (const file of files) {
    const rl = createInterface({ input: createReadStream(file, "utf-8"), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.includes('"Bash"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        report.unparsableLines += 1;
        continue;
      }
      const content = entry && entry.message && entry.message.content;
      if (!Array.isArray(content)) continue;
      const baseDir = typeof entry.cwd === "string" && entry.cwd !== "" ? entry.cwd : projectRoot;

      for (const item of content) {
        if (!item || item.type !== "tool_use" || item.name !== "Bash") continue;
        const command = item.input && item.input.command;
        if (typeof command !== "string") continue;

        report.commands += 1;
        currentCommand.value = command;
        const detected = detectBashWrites(command, { patterns, extensions, baseDirs: [baseDir] });

        if (detected.matched.length > 0) {
          report.gated += 1;
          if (detected.paths.length === 0) {
            report.noPath += 1;
            continue;
          }
          report.withPaths += 1;
          let inside = 0;
          for (const abs of detected.paths) {
            const rel = relativeInside(abs, projectRoot);
            if (rel === null) continue;
            inside += 1;
            pathCounts.set(rel, (pathCounts.get(rel) || 0) + 1);
          }
          if (inside === 0) report.outsideOnly += 1;
        } else if (MISS_COMMAND_RE.test(command)) {
          const named = detectBashWrites(command, { patterns: anyPattern, extensions, baseDirs: [baseDir] });
          const insideProject = named.paths.some((abs) => relativeInside(abs, projectRoot) !== null);
          if (insideProject) {
            misses.count += 1;
            if (misses.samples.length < MISS_SAMPLE_LIMIT) misses.samples.push(truncate(command));
          }
        }
      }
    }
  }

  const patternReport = patternStats.map((s) => {
    const totalMs = Number(s.ns) / 1e6;
    const msPer1000 = s.calls === 0 ? 0 : Math.round((totalMs / s.calls) * 1000 * 1000) / 1000;
    return {
      name: s.name,
      hits: s.hits,
      msPer1000,
      slow: msPer1000 > SLOW_MS_PER_1000,
      samples: s.samples,
    };
  });

  const paths = [...pathCounts.entries()]
    .map(([p, count]) => ({ path: p, count }))
    .sort((a, b) => b.count - a.count || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, TOP_PATHS_LIMIT);

  console.log(
    JSON.stringify({
      transcriptsDir,
      files: files.length,
      commands: report.commands,
      unparsableLines: report.unparsableLines,
      gated: report.gated,
      withPaths: report.withPaths,
      noPath: report.noPath,
      outsideOnly: report.outsideOnly,
      patterns: patternReport,
      paths,
      misses,
    }),
  );
}
