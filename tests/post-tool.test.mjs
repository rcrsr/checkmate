import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveCommand, formatCommandsBlock } from "../scripts/lib/post-tool.mjs";
import { resolveFileRoot } from "../scripts/lib/lib.mjs";

const scriptPath = fileURLToPath(new URL("../scripts/checkmate.mjs", import.meta.url));

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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

test("resolveFileRoot(projectRoot, projectRoot) does not resolve to a directory above the project", () => {
  // A Write whose target IS the project root path (edge case, but the walk
  // starts at path.dirname(filePath), one level above the root). The
  // project's parent has its own .git, so an unfixed walk that escapes
  // above projectRoot would misclassify the parent as a nested repo.
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "checkmate-test-")));
  try {
    mkdirSync(path.join(workspace, ".git"), { recursive: true });
    const projectRoot = path.join(workspace, "project");
    mkdirSync(projectRoot, { recursive: true });

    const result = resolveFileRoot(projectRoot, projectRoot);
    assert.equal(result.kind, "project");
    assert.equal(result.root, projectRoot);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("resolveFileRoot resolves an in-project file to the project even with a trailing separator on projectRoot", () => {
  // CLAUDE_PROJECT_DIR="/proj/" (trailing separator): path.dirname() never
  // returns a trailing separator, so a raw string comparison against
  // projectRoot never matches. The project's parent has its own .git, so an
  // unfixed walk would climb past the project and misclassify the parent as
  // a nested repo instead of stopping at the (trailing-slash) root.
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "checkmate-test-")));
  try {
    mkdirSync(path.join(workspace, ".git"), { recursive: true });
    const projectRoot = path.join(workspace, "project");
    mkdirSync(projectRoot, { recursive: true });
    const filePath = path.join(projectRoot, "sample.txt");
    writeFileSync(filePath, "hello\n");

    const result = resolveFileRoot(filePath, projectRoot + path.sep);
    assert.equal(result.kind, "project");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
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

test("post-tool passes without running checks for a file in a sibling dir outside the project root", () => {
  // A root env with "paths": ["."] used to match any file on the filesystem
  // (issue #7): the "." -> "" normalization made fileMatchesPaths's first
  // disjunct unconditionally true. This must fail on main.
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "checkmate-test-")));
  try {
    const projectRoot = path.join(workspace, "project-a");
    const siblingRoot = path.join(workspace, "project-b");
    mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
    mkdirSync(siblingRoot, { recursive: true });

    const config = {
      environments: [
        {
          name: "root",
          paths: ["."],
          checks: {
            ".mjs": [
              {
                name: "shouldnotrun",
                command: "node",
                args: ["-e", "process.exit(1)", "$FILE"],
                parser: "generic",
              },
            ],
          },
        },
      ],
    };
    writeFileSync(path.join(projectRoot, ".claude", "checkmate.json"), JSON.stringify(config));

    const filePath = path.join(siblingRoot, "src", "foo.mjs");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const x = 1;\n");

    const result = spawnSync("node", [scriptPath, "post-tool"], {
      input: JSON.stringify({ tool_input: { file_path: filePath } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
      encoding: "utf-8",
    });

    const output = JSON.parse(result.stdout);
    assert.notEqual(output.decision, "block");
    assert.doesNotMatch(output.systemMessage, /<new-diagnostics>/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("post-tool passes without running checks for a /tmp-style scratchpad file outside the project root", () => {
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "checkmate-test-")));
  try {
    const projectRoot = path.join(workspace, "project");
    const scratchRoot = path.join(workspace, "claude-scratchpad");
    mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
    mkdirSync(scratchRoot, { recursive: true });

    const config = {
      environments: [
        {
          name: "root",
          paths: ["."],
          checks: {
            ".md": [
              {
                name: "shouldnotrun",
                command: "node",
                args: ["-e", "process.exit(1)", "$FILE"],
                parser: "generic",
              },
            ],
          },
        },
      ],
    };
    writeFileSync(path.join(projectRoot, ".claude", "checkmate.json"), JSON.stringify(config));

    const filePath = path.join(scratchRoot, "notes.md");
    writeFileSync(filePath, "# scratch\n");

    const result = spawnSync("node", [scriptPath, "post-tool"], {
      input: JSON.stringify({ tool_input: { file_path: filePath } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
      encoding: "utf-8",
    });

    const output = JSON.parse(result.stdout);
    assert.notEqual(output.decision, "block");
    assert.doesNotMatch(output.systemMessage, /<new-diagnostics>/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
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
    assert.match(output.reason, new RegExp(escapeRegex(worktreeRoot)));
    assert.match(output.reason, /node -e '.*' sample\.txt/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("post-tool falls back to the session config when the worktree has no config of its own", () => {
  const projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "checkmate-test-")));
  try {
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

    // Worktree exists but has no .claude/checkmate.json of its own (e.g.
    // gitignored or simply not yet created).
    const worktreeRoot = path.join(projectRoot, ".claude", "worktrees", "wt");
    mkdirSync(worktreeRoot, { recursive: true });
    writeFileSync(
      path.join(worktreeRoot, ".git"),
      `gitdir: ${path.join(projectRoot, ".git", "worktrees", "wt")}\n`
    );

    const filePath = path.join(worktreeRoot, "sample.txt");
    writeFileSync(filePath, "hello\n");

    const result = spawnSync("node", [scriptPath, "post-tool"], {
      input: JSON.stringify({ tool_input: { file_path: filePath } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
      encoding: "utf-8",
    });

    const output = JSON.parse(result.stdout);
    // Session config still applies, but checks are still rooted at the worktree.
    assert.equal(output.decision, "block");
    assert.match(output.reason, new RegExp(escapeRegex(worktreeRoot)));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("post-tool runs a submodule's own config from the submodule root", () => {
  const projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "checkmate-test-")));
  try {
    mkdirSync(path.join(projectRoot, ".git", "modules", "sub"), { recursive: true });
    mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });

    // Parent config uses a formatter the submodule doesn't have; if it were
    // applied to the submodule the check would fail differently than the
    // submodule's own config below.
    const parentConfig = {
      environments: [
        {
          name: "root",
          paths: ["."],
          checks: {
            ".txt": [
              { name: "parentcheck", command: "node", args: ["-e", "process.exit(1)", "$FILE"], parser: "generic" },
            ],
          },
        },
      ],
    };
    writeFileSync(path.join(projectRoot, ".claude", "checkmate.json"), JSON.stringify(parentConfig));

    const subRoot = path.join(projectRoot, "sub");
    mkdirSync(path.join(subRoot, ".claude"), { recursive: true });
    writeFileSync(path.join(subRoot, ".git"), `gitdir: ${path.join(projectRoot, ".git", "modules", "sub")}\n`);

    const subConfig = {
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
    writeFileSync(path.join(subRoot, ".claude", "checkmate.json"), JSON.stringify(subConfig));

    const filePath = path.join(subRoot, "sample.txt");
    writeFileSync(filePath, "hello\n");

    const result = spawnSync("node", [scriptPath, "post-tool"], {
      input: JSON.stringify({ tool_input: { file_path: filePath } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
      encoding: "utf-8",
    });

    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /cwdcheck/);
    assert.match(output.reason, new RegExp(escapeRegex(subRoot)));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("post-tool passes without running checks for a submodule that has no config of its own", () => {
  // Behavior change vs main: the parent must never impose its toolchain on
  // a submodule that doesn't own a checkmate.json.
  const projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "checkmate-test-")));
  try {
    mkdirSync(path.join(projectRoot, ".git", "modules", "sub"), { recursive: true });
    mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });

    const parentConfig = {
      environments: [
        {
          name: "root",
          paths: ["."],
          checks: {
            ".txt": [
              { name: "parentcheck", command: "node", args: ["-e", "process.exit(1)", "$FILE"], parser: "generic" },
            ],
          },
        },
      ],
    };
    writeFileSync(path.join(projectRoot, ".claude", "checkmate.json"), JSON.stringify(parentConfig));

    const subRoot = path.join(projectRoot, "sub");
    mkdirSync(subRoot, { recursive: true });
    writeFileSync(path.join(subRoot, ".git"), `gitdir: ${path.join(projectRoot, ".git", "modules", "sub")}\n`);

    const filePath = path.join(subRoot, "sample.txt");
    writeFileSync(filePath, "hello\n");

    const result = spawnSync("node", [scriptPath, "post-tool"], {
      input: JSON.stringify({ tool_input: { file_path: filePath } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
      encoding: "utf-8",
    });

    const output = JSON.parse(result.stdout);
    assert.notEqual(output.decision, "block");
    assert.doesNotMatch(output.systemMessage, /<new-diagnostics>/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("post-tool still runs the schema self-check on a nested repo's own invalid checkmate.json", () => {
  // loadConfig() swallows JSON parse errors and returns config: null, which
  // is indistinguishable from "no config file at all" unless isConfigFile
  // is checked before the nested-repo early pass.
  const projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "checkmate-test-")));
  try {
    mkdirSync(path.join(projectRoot, ".git", "modules", "sub"), { recursive: true });
    mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
    writeFileSync(path.join(projectRoot, ".claude", "checkmate.json"), JSON.stringify({ environments: [] }));

    const subRoot = path.join(projectRoot, "sub");
    mkdirSync(path.join(subRoot, ".claude"), { recursive: true });
    writeFileSync(path.join(subRoot, ".git"), `gitdir: ${path.join(projectRoot, ".git", "modules", "sub")}\n`);

    const configPath = path.join(subRoot, ".claude", "checkmate.json");
    writeFileSync(configPath, "{ not valid json");

    const result = spawnSync("node", [scriptPath, "post-tool"], {
      input: JSON.stringify({ tool_input: { file_path: configPath } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
      encoding: "utf-8",
    });

    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, "block");
    assert.match(output.reason, /schema/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("post-tool exclude patterns escape regex metacharacters so '.' isn't a wildcard", () => {
  const projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "checkmate-test-")));
  try {
    mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });

    const config = {
      environments: [
        {
          name: "root",
          paths: ["."],
          exclude: ["dist.old/**"],
          checks: {
            ".txt": [
              {
                name: "cwdcheck",
                command: "node",
                args: ["-e", "process.exit(1)", "$FILE"],
                parser: "generic",
              },
            ],
          },
        },
      ],
    };
    writeFileSync(path.join(projectRoot, ".claude", "checkmate.json"), JSON.stringify(config));

    // "distXold" must NOT match the "dist.old/**" exclude pattern; a broken
    // "." -> "any character" wildcard would falsely exclude it.
    const filePath = path.join(projectRoot, "distXold", "foo.txt");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "hello\n");

    const result = spawnSync("node", [scriptPath, "post-tool"], {
      input: JSON.stringify({ tool_input: { file_path: filePath } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
      encoding: "utf-8",
    });

    const output = JSON.parse(result.stdout);
    // Checks still ran (and failed), proving the file was not excluded.
    assert.equal(output.decision, "block");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
