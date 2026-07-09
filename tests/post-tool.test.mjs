import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCommand, formatCommandsBlock } from "../scripts/lib/post-tool.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/checkmate.mjs", import.meta.url));

test("resolveCommand echoes the configured command with $FILE as a project-relative path", () => {
  const command = resolveCommand(
    "shfmt",
    ["-i", "2", "-d", "$FILE"],
    "/proj/sub/codanna-serve.sh",
    "/proj"
  );
  assert.equal(command, "shfmt -i 2 -d sub/codanna-serve.sh");
});

test("resolveCommand keeps configured flags for a root-level file", () => {
  const command = resolveCommand(
    "shfmt",
    ["-i", "2", "-d", "$FILE"],
    "/proj/codanna-serve.sh",
    "/proj"
  );
  assert.equal(command, "shfmt -i 2 -d codanna-serve.sh");
});

test("resolveCommand single-quotes an arg with spaces and shell metacharacters while leaving sibling flags unquoted", () => {
  const command = resolveCommand(
    "node",
    ["-e", "console.log('hi'); exit 1", "$FILE"],
    "/proj/sample.txt",
    "/proj"
  );
  assert.equal(
    command,
    "node -e 'console.log('\\''hi'\\''); exit 1' sample.txt"
  );
});

test("formatCommandsBlock wraps commands in a <reproduce-with> block", () => {
  const block = formatCommandsBlock(["shfmt -i 2 -d codanna-serve.sh"]);
  assert.equal(
    block,
    "<reproduce-with>\n  shfmt -i 2 -d codanna-serve.sh\n</reproduce-with>"
  );
});

test("formatCommandsBlock de-duplicates identical commands", () => {
  const block = formatCommandsBlock([
    "shfmt -i 2 -d a.sh",
    "shfmt -i 2 -d a.sh",
  ]);
  assert.equal(block, "<reproduce-with>\n  shfmt -i 2 -d a.sh\n</reproduce-with>");
});

test("post-tool surfaces the command checkmate ran when a check fails", () => {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "checkmate-test-"));
  try {
    mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
    const config = {
      environments: [
        {
          name: "root",
          paths: ["."],
          checks: {
            ".txt": [
              {
                name: "fakefmt",
                command: "node",
                args: ["-e", "console.log('formatting diff'); process.exit(1)", "$FILE"],
                parser: "prettier",
              },
            ],
          },
        },
      ],
    };
    writeFileSync(
      path.join(projectRoot, ".claude", "checkmate.json"),
      JSON.stringify(config)
    );
    const filePath = path.join(projectRoot, "sample.txt");
    writeFileSync(filePath, "hello\n");

    const result = spawnSync("node", [scriptPath, "post-tool"], {
      input: JSON.stringify({ tool_input: { file_path: filePath } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
      encoding: "utf-8",
    });

    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /<reproduce-with>/);
    assert.match(output.reason, /node -e '.*' sample\.txt/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("post-tool blocks when failing output contains 'not found'", () => {
  // Pins the 2.2.5 behavior: output quoting "not found" (e.g. a formatter
  // diff of source lines) is a real failure, not a missing command.
  const projectRoot = mkdtempSync(path.join(tmpdir(), "checkmate-test-"));
  try {
    mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
    const config = {
      environments: [
        {
          name: "root",
          paths: ["."],
          checks: {
            ".txt": [
              {
                name: "fakefmt",
                command: "node",
                args: [
                  "-e",
                  "console.log('- value not found in map'); process.exit(1)",
                  "$FILE",
                ],
                parser: "prettier",
              },
            ],
          },
        },
      ],
    };
    writeFileSync(
      path.join(projectRoot, ".claude", "checkmate.json"),
      JSON.stringify(config)
    );
    const filePath = path.join(projectRoot, "sample.txt");
    writeFileSync(filePath, "hello\n");

    const result = spawnSync("node", [scriptPath, "post-tool"], {
      input: JSON.stringify({ tool_input: { file_path: filePath } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
      encoding: "utf-8",
    });

    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /<reproduce-with>/);
    assert.match(output.reason, /node -e '.*' sample\.txt/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
