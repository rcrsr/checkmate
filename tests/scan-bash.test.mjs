import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { validateConfig } from "../scripts/lib/validate.mjs";

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
        environments: [
          {
            name: "py",
            paths: ["."],
            checks: { ".py": [{ name: "t", command: "true", args: ["$FILE"], parser: "generic" }] },
          },
        ],
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
        bashLine("patch a.py fix.diff", project),
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

  it("lists a patch onto a checked extension in misses", () => {
    withFixture(({ project, transcripts }) => {
      const report = JSON.parse(scan(project, ["--transcripts", transcripts]).stdout);
      assert.equal(report.misses.count, 1);
      assert.deepEqual(report.misses.samples, ["patch a.py fix.diff"]);
    });
  });

  it("counts only commands whose command word writes a checked path", () => {
    withFixture(({ ws, project, transcripts }) => {
      const dir = join(ws, "anchored");
      mkdirSync(dir);
      writeFileSync(
        join(dir, "s.jsonl"),
        [
          "cd sub && patch a.py fix.diff",
          "git apply fix.diff a.py",
          "echo patched a.py",
          "grep -n patch a.py",
          "echo ed a.py",
          "ls | grep cp a.py",
        ]
          .map((c) => bashLine(c, project))
          .join("\n") + "\n",
      );
      const report = JSON.parse(scan(project, ["--transcripts", dir]).stdout);
      assert.deepEqual(report.misses.samples, ["cd sub && patch a.py fix.diff", "git apply fix.diff a.py"]);
      assert.equal(report.misses.count, 2);
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

  it("uses a fixture config that passes validation", () => {
    withFixture(({ project }) => {
      const config = JSON.parse(readFileSync(join(project, ".claude", "checkmate.json"), "utf-8"));
      assert.deepEqual(validateConfig(config).errors, []);
    });
  });

  it("redacts secret values in samples before truncation", () => {
    withFixture(({ ws, project }) => {
      const dir = join(ws, "secrets");
      mkdirSync(dir);
      writeFileSync(join(dir, "s.jsonl"), bashLine("API_KEY=supersecret sed -i 's/a/b/' app.py", project) + "\n");
      const r = scan(project, ["--transcripts", dir]);
      const report = JSON.parse(r.stdout);
      const samples = report.patterns.flatMap((p) => p.samples);
      assert.ok(samples.length > 0);
      assert.ok(samples.every((x) => x.includes("<redacted>") && !x.includes("supersecret")));
    });
  });

  it("redacts Authorization, URL userinfo, token prefixes, AKIA and private keys", () => {
    withFixture(({ ws, project }) => {
      const dir = join(ws, "secrets2");
      mkdirSync(dir);
      const commands = [
        "sed -i 's/a/b/' app.py; curl -H 'Authorization: Bearer abc.def'",
        "sed -i 's/a/b/' app.py; curl -H 'Authorization: Basic dXNlcjpwYXNz'",
        "sed -i 's/a/b/' app.py; git clone https://bob:hunter2@example.com/r.git",
        "sed -i 's/a/b/' app.py; echo ghp_abcdefghijklmnopqrstuvwxyz0123",
        "sed -i 's/a/b/' app.py; echo AKIAABCDEFGHIJKLMNOP",
        "sed -i 's/a/b/' app.py; echo -----BEGIN RSA PRIVATE KEY-----MIIEvQIBADANBg",
      ];
      writeFileSync(join(dir, "s.jsonl"), commands.map((c) => bashLine(c, project)).join("\n") + "\n");
      const r = scan(project, ["--transcripts", dir]);
      const text = JSON.stringify(JSON.parse(r.stdout));
      assert.ok(text.includes("Authorization: <redacted>"));
      assert.ok(!text.includes("Authorization:<redacted>"));
      assert.ok(text.includes("https://<redacted>@example.com"));
      for (const leaked of ["abc.def", "dXNlcjpwYXNz", "hunter2", "ghp_abcdef", "AKIAABCDEFGHIJKLMNOP", "MIIEvQIBADANBg"]) {
        assert.ok(!text.includes(leaked), leaked);
      }
    });
  });

  it("redacts misses samples", () => {
    withFixture(({ ws, project }) => {
      const dir = join(ws, "secrets3");
      mkdirSync(dir);
      writeFileSync(join(dir, "s.jsonl"), bashLine("patch --password=hunter2 app.py", project) + "\n");
      const r = scan(project, ["--transcripts", dir]);
      const report = JSON.parse(r.stdout);
      assert.ok(report.misses.count > 0);
      assert.ok(report.misses.samples.some((sample) => sample.includes("<redacted>")));
      assert.ok(!r.stdout.includes("hunter2"));
    });
  });

  it("redacts a 100KB command in linear time", () => {
    withFixture(({ ws, project }) => {
      const dir = join(ws, "big");
      mkdirSync(dir);
      const blobs = ["a".repeat(100000), "token".repeat(20000), "auth".repeat(25000)];
      writeFileSync(
        join(dir, "s.jsonl"),
        blobs.map((b) => bashLine("sed -i 's/a/b/' app.py; echo " + b, project)).join("\n") + "\n",
      );
      const start = Date.now();
      const r = scan(project, ["--transcripts", dir]);
      assert.equal(r.status, 0);
      assert.ok(Date.now() - start < 2000);
    });
  });

  it("exits 2 without echoing content for an invalid-JSON patterns file", () => {
    withFixture(({ ws, project, transcripts }) => {
      const patterns = join(ws, "broken.json");
      writeFileSync(patterns, "{ hunter2 ");
      const r = scan(project, ["--transcripts", transcripts, "--patterns", patterns]);
      assert.equal(r.status, 2);
      assert.ok(!r.stderr.includes("hunter2"));
      assert.match(r.stderr, /is not valid JSON/);
    });
  });

  it("warns on stderr and still prints JSON when no config exists", () => {
    withFixture(({ ws, transcripts }) => {
      const empty = join(ws, "empty-project");
      mkdirSync(empty);
      const r = scan(empty, ["--transcripts", transcripts]);
      assert.equal(r.status, 0);
      assert.match(r.stderr, /scan-bash: no checked extensions in .*checkmate\.json/);
      assert.doesNotThrow(() => JSON.parse(r.stdout));
    });
  });
});
