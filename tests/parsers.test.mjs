import { test } from "node:test";
import assert from "node:assert/strict";

import { parsers } from "../scripts/lib/post-tool.mjs";
import { validateConfig } from "../scripts/lib/validate.mjs";

// Output samples captured from oxlint 1.73.0 with `-f agent`.

test("oxlint parser is registered as a predefined parser", () => {
  assert.equal(typeof parsers.oxlint, "function");
});

test("oxlint parser parses agent-format diagnostics with plugin(rule) codes", () => {
  const output = [
    "bad.ts:1:7: warning eslint(no-unused-vars): Variable 'unused' is declared but never used. Unused variables should start with a '_'. help: Consider removing this declaration.",
    "bad.ts:3:5: warning eslint(no-debugger): `debugger` statement is not allowed help: Remove the debugger statement",
  ].join("\n");

  const results = parsers.oxlint(output);

  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    line: 1,
    column: 7,
    severity: "warning",
    rule: "eslint(no-unused-vars)",
    message:
      "Variable 'unused' is declared but never used. Unused variables should start with a '_'. help: Consider removing this declaration.",
  });
  assert.equal(results[1].line, 3);
  assert.equal(results[1].rule, "eslint(no-debugger)");
});

test("oxlint parser parses syntax errors that have no rule code", () => {
  const results = parsers.oxlint("broken.ts:1:12: error: Unexpected token");

  assert.equal(results.length, 1);
  assert.equal(results[0].line, 1);
  assert.equal(results[0].column, 12);
  assert.equal(results[0].severity, "error");
  assert.equal(results[0].rule, undefined);
  assert.equal(results[0].message, "Unexpected token");
});

test("oxlint parser ignores non-diagnostic lines", () => {
  const output = [
    "Found 0 errors and 2 warnings.",
    "Finished in 12ms on 1 file with 96 rules using 8 threads.",
    "",
  ].join("\n");

  assert.deepEqual(parsers.oxlint(output), []);
});

test("validateConfig accepts the oxlint predefined parser", () => {
  const config = {
    environments: [
      {
        name: "root",
        paths: ["."],
        checks: {
          ".ts": [
            {
              name: "oxlint",
              command: "node",
              args: ["node_modules/oxlint/bin/oxlint", "--deny-warnings", "-f", "agent", "$FILE"],
              parser: "oxlint",
            },
          ],
        },
      },
    ],
  };

  const { errors } = validateConfig(config);
  assert.deepEqual(errors, []);
});
