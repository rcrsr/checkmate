import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/checkmate.mjs", import.meta.url));

function writeAgentConfig(projectRoot) {
  mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
  const config = {
    environments: [
      {
        name: "root",
        paths: ["."],
        agents: {
          ".mjs": "javascript-engineer",
        },
      },
    ],
  };
  writeFileSync(path.join(projectRoot, ".claude", "checkmate.json"), JSON.stringify(config));
}

function runPreTool(filePath, projectRoot) {
  const result = spawnSync("node", [scriptPath, "pre-tool"], {
    input: JSON.stringify({
      tool_name: "Edit",
      tool_input: { file_path: filePath },
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
    encoding: "utf-8",
  });
  return JSON.parse(result.stdout);
}

test("pre-tool allows a main-thread edit of a file outside the project root, even with an agent mapping for that extension", () => {
  // Mirrors issue #7 for the delegation hook: a file outside the project
  // root must never be judged by this project's agent-delegation config.
  // This must fail on main.
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "checkmate-test-")));
  try {
    const projectRoot = path.join(workspace, "project-a");
    const siblingRoot = path.join(workspace, "project-b");
    writeAgentConfig(projectRoot);
    mkdirSync(siblingRoot, { recursive: true });

    const filePath = path.join(siblingRoot, "foo.mjs");
    writeFileSync(filePath, "export const x = 1;\n");

    const output = runPreTool(filePath, projectRoot);
    assert.notEqual(output.hookSpecificOutput?.permissionDecision, "deny");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("pre-tool still denies a main-thread edit of a file inside the project root with an agent mapping", () => {
  // Proves the containment fix didn't weaken delegation enforcement for
  // files that genuinely belong to the project.
  const projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "checkmate-test-")));
  try {
    writeAgentConfig(projectRoot);

    const filePath = path.join(projectRoot, "foo.mjs");
    writeFileSync(filePath, "export const x = 1;\n");

    const output = runPreTool(filePath, projectRoot);
    assert.equal(output.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /javascript-engineer/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("pre-tool still denies delegation when CLAUDE_PROJECT_DIR is reached through a symlinked alias", () => {
  // Item 1 / issue: pre-tool.mjs relativized against the raw tool_input
  // filePath instead of resolveFileRoot's realpath'd filePath. When
  // CLAUDE_PROJECT_DIR is a symlinked alias, root (real, from the nested
  // repo's own directory) and the raw filePath (through the alias) land in
  // 2 different coordinate spaces, so path.relative() produces a
  // "../"-prefixed path that never matches a non-"." paths entry, silently
  // degrading to "no agent mapping". This test MUST fail on the pre-fix
  // code (edit allowed through) and pass after the fix (edit denied).
  const workspace = realpathSync(mkdtempSync(path.join(tmpdir(), "checkmate-test-")));
  try {
    const projectRoot = path.join(workspace, "project");
    mkdirSync(path.join(projectRoot, ".git", "modules", "sub"), { recursive: true });

    const subRoot = path.join(projectRoot, "sub");
    mkdirSync(path.join(subRoot, ".claude"), { recursive: true });
    writeFileSync(
      path.join(subRoot, ".git"),
      `gitdir: ${path.join(projectRoot, ".git", "modules", "sub")}\n`
    );

    // paths: ["nested"] requires a correctly-computed root-relative path;
    // unlike paths: ["."], it can't short-circuit to "always matches".
    const subConfig = {
      environments: [
        {
          name: "root",
          paths: ["nested"],
          agents: {
            ".mjs": "javascript-engineer",
          },
        },
      ],
    };
    writeFileSync(path.join(subRoot, ".claude", "checkmate.json"), JSON.stringify(subConfig));

    const alias = path.join(workspace, "alias");
    symlinkSync(projectRoot, alias);

    const filePath = path.join(alias, "sub", "nested", "foo.mjs");
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export const x = 1;\n");

    const output = runPreTool(filePath, alias);
    assert.equal(output.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /javascript-engineer/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("pre-tool still denies delegation for a Write target that doesn't exist yet, across several non-existent ancestor segments", () => {
  // pre-tool.mjs has no existsSync guard (PreToolUse for Write fires before
  // the file is created), so realpathPossiblyMissing()'s "walk up to the
  // first existing ancestor" branch was previously untested here.
  const projectRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "checkmate-test-")));
  try {
    writeAgentConfig(projectRoot);

    // deep/nested/dir do not exist on disk yet.
    const filePath = path.join(projectRoot, "deep", "nested", "dir", "new-file.mjs");

    const output = runPreTool(filePath, projectRoot);
    assert.equal(output.hookSpecificOutput?.permissionDecision, "deny");
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /javascript-engineer/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
