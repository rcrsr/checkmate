/**
 * post-task.test.mjs
 * Tests for scripts/lib/post-task.mjs: background launch guard and
 * completion action dispatch (skip/message/review).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKMATE_ENTRY = path.join(__dirname, "..", "scripts", "checkmate.mjs");

const DEFAULT_CONFIG = {
  environments: [],
  tasks: [
    {
      name: "code-review",
      match: "*-engineer",
      action: "review",
      message: "Invoke *-code-reviewer to validate the implementation.",
    },
  ],
};

/**
 * Run `checkmate.mjs post-task` against a temp project root with the given
 * config and stdin payload, then clean up the temp directory.
 */
function runPostTask(input, config = DEFAULT_CONFIG) {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "checkmate-post-task-"));
  try {
    const claudeDir = path.join(projectRoot, ".claude");
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(path.join(claudeDir, "checkmate.json"), JSON.stringify(config));

    const result = spawnSync("node", [CHECKMATE_ENTRY, "post-task"], {
      input: JSON.stringify(input),
      encoding: "utf-8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
    });
    return result;
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

test("skips silently when run_in_background is true", () => {
  const result = runPostTask({
    tool_name: "Agent",
    tool_input: { subagent_type: "python-engineer", run_in_background: true },
    tool_response: { status: "async_launched", agentId: "abc123" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("skips silently when tool_response.status is async_launched and run_in_background is absent", () => {
  // Background is the harness default in Claude Code 2.1.205, so
  // run_in_background is often absent; the status field is load-bearing.
  const result = runPostTask({
    tool_name: "Agent",
    tool_input: { subagent_type: "python-engineer" },
    tool_response: { status: "async_launched", agentId: "abc123" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("skips silently when tool_response.status is remote_launched and run_in_background is absent", () => {
  // isolation:"remote" agents always launch in background.
  const result = runPostTask({
    tool_name: "Agent",
    tool_input: { subagent_type: "python-engineer" },
    tool_response: { status: "remote_launched", agentId: "abc123" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("skips silently when the async launch status arrives under tool_output", () => {
  const result = runPostTask({
    tool_name: "Agent",
    tool_input: { subagent_type: "python-engineer" },
    tool_output: { status: "async_launched", agentId: "abc123" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("foreground completion still blocks with the review action", () => {
  const result = runPostTask({
    tool_name: "Agent",
    tool_input: { subagent_type: "python-engineer", run_in_background: false },
    tool_response: { content: [{ type: "text", text: "done" }] },
  });

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, "block");
  assert.equal(
    output.reason,
    "Invoke python-code-reviewer to validate the implementation."
  );
});

test("message rules still pass through on completion", () => {
  const config = {
    environments: [],
    tasks: [
      {
        name: "code-review",
        match: "*-engineer",
        action: "message",
        message: "Consider a * follow-up.",
      },
    ],
  };

  const result = runPostTask(
    {
      tool_name: "Agent",
      tool_input: { subagent_type: "python-engineer", run_in_background: false },
      tool_response: { content: [{ type: "text", text: "done" }] },
    },
    config
  );

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, undefined);
  assert.match(output.systemMessage, /Consider a python follow-up\./);
});
