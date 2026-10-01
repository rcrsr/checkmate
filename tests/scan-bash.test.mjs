import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENTRY = resolve(import.meta.dirname, "../scripts/checkmate.mjs");

function bashLine(command, cwd) {
  return JSON.stringify({
    cwd,
    message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
  });
}

function withFixture(fn) {
  const ws = mkdtempSync(join(tmpdir(), "scan-bash-"));
  try {
    const project = join(ws, "project");
    mkdirSync(join(project, ".claude"), { recursive: true });
    writeFileSync(
      join(project, ".claude", "checkmate.json"),
      JSON.stringify({
        environments: {
          py: { paths: ["."], checks: { ".py": [{ name: "t", command: "true", parser: "raw" }] } },
        },
      }),
    );

    const transcripts = join(ws, "transcripts");
    mkdirSync(join(transcripts, "session-1", "subagents"), { recursive: true });
    writeFileSync(
      join(transcripts, "session-1.jsonl"),
      [
        bashLine("sed -i 's/a/b/' app.py", project),
        bashLine("echo hi > notes.py", project),
        bashLine("ls", project),
        bashLine("cp a.py b.py", project),
        '{"Bash" this is not json',
        JSON.stringify({ message: { content: [{ type: "text", text: "Bash" }] } }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(transcripts, "session-1", "subagents", "agent-1.jsonl"),
      bashLine("sed -i 's/x/y/' lib.py", project) + "\n",
    );

    fn({ ws, project, transcripts });
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

function scan(project, args) {
  return spawnSync("node", [ENTRY, "scan-bash", ...args], {
    encoding: "utf-8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: project },
  });
}

function hitsOf(report, name) {
  return report.patterns.find((p) => p.name === name).hits;
}

describe("scan-bash", () => {
  it("reports per-pattern hit counts for a known fixture", () => {
    withFixture(({ project, transcripts }) => {
      const r = scan(project, ["--transcripts", transcripts]);
      assert.equal(r.status, 0);
      const report = JSON.parse(r.stdout);
      assert.equal(report.files, 2);
      assert.equal(report.commands, 5);
      assert.equal(report.gated, 3);
      assert.equal(report.withPaths, 3);
      assert.equal(report.noPath, 0);
      assert.equal(hitsOf(report, "sed-inplace"), 2);
      assert.equal(hitsOf(report, "redirect"), 1);
      assert.equal(hitsOf(report, "tee"), 0);
      assert.deepEqual(
        report.paths.map((p) => p.path),
        ["app.py", "lib.py", "notes.py"],
      );
    });
  });

  it("counts a command found only in a subagents transcript", () => {
    withFixture(({ project, transcripts }) => {
      const report = JSON.parse(scan(project, ["--transcripts", transcripts]).stdout);
      assert.ok(report.paths.some((p) => p.path === "lib.py"));
    });
  });

  it("increments unparsableLines for a malformed line", () => {
    withFixture(({ project, transcripts }) => {
      const report = JSON.parse(scan(project, ["--transcripts", transcripts]).stdout);
      assert.equal(report.unparsableLines, 1);
    });
  });

  it("lists a cp onto a checked extension in misses", () => {
    withFixture(({ project, transcripts }) => {
      const report = JSON.parse(scan(project, ["--transcripts", transcripts]).stdout);
      assert.equal(report.misses.count, 1);
      assert.deepEqual(report.misses.samples, ["cp a.py b.py"]);
    });
  });

  it("changes hits when a patterns file overrides a default", () => {
    withFixture(({ ws, project, transcripts }) => {
      const patterns = join(ws, "patterns.json");
      writeFileSync(
        patterns,
        JSON.stringify({ writePatterns: [{ name: "sed-inplace", match: "NEVER_MATCHES_ANYTHING" }] }),
      );
      const report = JSON.parse(scan(project, ["--transcripts", transcripts, "--patterns", patterns]).stdout);
      assert.equal(hitsOf(report, "sed-inplace"), 0);
      assert.equal(hitsOf(report, "redirect"), 1);
    });
  });

  it("exits 1 for an invalid patterns file", () => {
    withFixture(({ ws, project, transcripts }) => {
      const patterns = join(ws, "bad-patterns.json");
      writeFileSync(patterns, JSON.stringify({ bogusKey: true }));
      const r = scan(project, ["--transcripts", transcripts, "--patterns", patterns]);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /bogusKey/);
    });
  });

  it("exits 2 for a missing transcripts directory", () => {
    withFixture(({ ws, project }) => {
      const r = scan(project, ["--transcripts", join(ws, "nope")]);
      assert.equal(r.status, 2);
    });
  });

  it("exits 2 for an unknown argument", () => {
    withFixture(({ project, transcripts }) => {
      const r = scan(project, ["--transcripts", transcripts, "--bogus"]);
      assert.equal(r.status, 2);
    });
  });

  it("sets slow to exactly msPer1000 > 5 for every pattern", () => {
    withFixture(({ project, transcripts }) => {
      const report = JSON.parse(scan(project, ["--transcripts", transcripts]).stdout);
      assert.ok(report.patterns.length > 0);
      for (const p of report.patterns) {
        assert.equal(p.slow, p.msPer1000 > 5);
      }
    });
  });
});
