import { test } from "node:test";
import assert from "node:assert/strict";
import { validateBash, validateConfig } from "../scripts/lib/validate.mjs";
import { DEFAULT_WRITE_PATTERNS } from "../scripts/lib/lib.mjs";

function errorsFor(match) {
  return validateBash({ writePatterns: [{ name: "p", match }] });
}

const REJECT = ["(a+)+", "(.*)*", "(?:\\w+\\s?)*", "(a|b+){2,}", "((a+))+", "((a+)b)*", "(?:(?:a+)b)+"];
const ACCEPT = ["(?:[\\w.-]+\\/)?", "(?:ab)+", "[+*]+"];

for (const match of REJECT) {
  test(`rejects nested quantifier ${match}`, () => {
    const errors = errorsFor(match);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^bash\.writePatterns\[0\]\.match: /);
  });
}

for (const match of ACCEPT) {
  test(`accepts ${match}`, () => {
    assert.deepEqual(errorsFor(match), []);
  });
}

test("accepts all default write patterns", () => {
  for (const p of DEFAULT_WRITE_PATTERNS) {
    assert.deepEqual(errorsFor(p.match), [], p.name);
  }
});

test("rejects duplicate names", () => {
  const errors = validateBash({
    writePatterns: [
      { name: "a", match: "x" },
      { name: "a", match: "y" },
    ],
  });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^bash\.writePatterns\[1\]\.name: duplicate/);
});

test("rejects non-boolean enabled", () => {
  const errors = validateBash({ enabled: "yes" });
  assert.deepEqual(errors, ["bash.enabled: must be a boolean"]);
});

test("rejects maxFiles 0 and 1.5, accepts 1", () => {
  assert.equal(validateBash({ maxFiles: 0 }).length, 1);
  assert.equal(validateBash({ maxFiles: 1.5 }).length, 1);
  assert.deepEqual(validateBash({ maxFiles: 1 }), []);
});

test("rejects unknown key", () => {
  const errors = validateBash({ bogus: true });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^bash\.bogus: unknown key/);
});

test("rejects invalid regex", () => {
  const errors = errorsFor("(");
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^bash\.writePatterns\[0\]\.match: invalid regex/);
});

test("config without bash is valid", () => {
  const { errors } = validateConfig({
    environments: [{ paths: ["."], checks: {} }],
  });
  assert.deepEqual(errors, []);
});

test("config with invalid bash reports bash-prefixed errors", () => {
  const { errors } = validateConfig({
    environments: [{ paths: ["."], checks: {} }],
    bash: { enabled: 1 },
  });
  assert.deepEqual(errors, ["bash.enabled: must be a boolean"]);
});
