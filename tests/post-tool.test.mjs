import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
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

test("post-tool roots checks at a nested linked worktree instead of CLAUDE_PROJECT_DIR", () => {
  // A session that enters a worktree under .claude/worktrees/ still has
  // CLAUDE_PROJECT_DIR pointing at the main checkout. Checks must run from
  // the worktree root: tools like oxlint resolve config hierarchically and
  // reject the worktree's config as an illegal nested config when invoked
  // from the main root, and $FILE in <reproduce-with> must be relative to
  // the worktree so pasting it from the worktree cwd doesn't double the path.
  const projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "checkmate-test-")));
  try {
    // Main checkout: a real repo with a registered linked worktree
    mkdirSync(path.join(projectRoot, ".git", "worktrees", "wt"), { recursive: true });
    mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });

    const config = {
      environments: [
        {
          name: "root",
          paths: ["."],
          checks: {
            ".txt": [
              {
                name: "cwdcheck",
                command: "node",
                args: ["-e", "console.log(process.cwd()); process.exit(1)", "$FILE"],
                parser: "generic",
              },
            ],
          },
        },
      ],
    };
    writeFileSync(path.join(projectRoot, ".claude", "checkmate.json"), JSON.stringify(config));

    // Nested linked worktree: .git is a pointer file into the main gitdir
    const worktreeRoot = path.join(projectRoot, ".claude", "worktrees", "wt");
    mkdirSync(path.join(worktreeRoot, ".claude"), { recursive: true });
    writeFileSync(
      path.join(worktreeRoot, ".git"),
      `gitdir: ${path.join(projectRoot, ".git", "worktrees", "wt")}\n`
    );
    writeFileSync(path.join(worktreeRoot, ".claude", "checkmate.json"), JSON.stringify(config));

    const filePath = path.join(worktreeRoot, "sample.txt");
    writeFileSync(filePath, "hello\n");

    const result = spawnSync("node", [scriptPath, "post-tool"], {
      input: JSON.stringify({ tool_input: { file_path: filePath } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
      encoding: "utf-8",
    });

    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    // The generic parser echoes the check's stdout (process.cwd()) into the
    // diagnostic message: checks must execute from the worktree root.
    assert.match(output.reason, new RegExp(worktreeRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    // $FILE must be worktree-relative, not .claude/worktrees/wt/sample.txt
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
