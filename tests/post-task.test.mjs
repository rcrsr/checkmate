import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(new URL("../scripts/checkmate.mjs", import.meta.url));

const reviewConfig = {
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

function runPostTask(hookInput, config = reviewConfig) {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "checkmate-test-"));
  try {
    mkdirSync(path.join(projectRoot, ".claude"), { recursive: true });
    writeFileSync(
      path.join(projectRoot, ".claude", "checkmate.json"),
      JSON.stringify(config)
    );
    return spawnSync("node", [scriptPath, "post-task"], {
      input: JSON.stringify(hookInput),
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
      encoding: "utf-8",
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

test("post-task skips silently when the agent was launched with run_in_background", () => {
  const result = runPostTask({
    tool_name: "Agent",
    tool_input: {
      subagent_type: "python-engineer",
      prompt: "Apply policy edits",
      run_in_background: true,
    },
    tool_response: { status: "async_launched", agentId: "abc123" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("post-task skips silently when tool_response reports an async launch", () => {
  // run_in_background may be absent when background is the harness default,
  // so the response status is the load-bearing signal.
  const result = runPostTask({
    tool_name: "Agent",
    tool_input: {
      subagent_type: "python-engineer",
      prompt: "Apply policy edits",
    },
    tool_response: { status: "async_launched", agentId: "abc123" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("post-task skips silently when the async launch arrives under tool_output", () => {
  const result = runPostTask({
    tool_name: "Agent",
    tool_input: {
      subagent_type: "python-engineer",
      prompt: "Apply policy edits",
    },
    tool_output: { status: "async_launched", agentId: "abc123" },
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
});

test("post-task still blocks on a foreground agent completion", () => {
  const result = runPostTask({
    tool_name: "Agent",
    tool_input: {
      subagent_type: "python-engineer",
      prompt: "Apply policy edits",
      run_in_background: false,
    },
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

test("post-task still emits a non-blocking message for message rules on completion", () => {
  const config = {
    environments: [],
    tasks: [
      {
        name: "note",
        match: "*-engineer",
        action: "message",
        message: "Consider a * follow-up.",
      },
    ],
  };
  const result = runPostTask(
    {
      tool_name: "Agent",
      tool_input: { subagent_type: "python-engineer", prompt: "x" },
      tool_response: { content: [{ type: "text", text: "done" }] },
    },
    config
  );

  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, undefined);
  assert.match(output.systemMessage, /Consider a python follow-up\./);
});
