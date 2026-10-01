import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { validateConfig } from "../scripts/lib/validate.mjs";
import { DEFAULT_WRITE_PATTERNS, validateBash } from "../scripts/lib/lib.mjs";

function errorsFor(match) {
  return validateBash({ writePatterns: [{ name: "p", match }] });
}

const REJECT = ["(a+)+", "(.*)*", "(?:\\w+\\s?)*", "(a|b+){2,}", "((a+))+", "((a+)b)*", "(?:(?:a+)b)+", "(a|aa)+", "(a|a)*", "(?:x|xy){2,}"];
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

const CATALOG_PATH = new URL("../agents/configure-bash-patterns.md", import.meta.url);

const CASES = {
  install: { word: "install ", pos: ["install -m 644 a /dst/a"], neg: ["pip install requests", "install"] },
  rsync: { word: "rsync ", pos: ["rsync -a src/ dst/"], neg: ["echo rsync", "cat rsync.txt"] },
  "dd-of": { word: "dd ", pos: ["dd if=/dev/zero of=out.bin"], neg: ["dd if=a.bin", "add of=b"] },
  truncate: { word: "truncate ", pos: ["truncate -s 0 app.log"], neg: ["echo truncate", "git log"] },
  patch: { word: "patch ", pos: ["patch -p1 < fix.diff"], neg: ["echo patch", "cat patch.diff"] },
  "git-apply": { word: "git apply ", pos: ["git apply fix.diff"], neg: ["git diff", "git status"] },
  "ed-ex": { word: "ed ", pos: ["ed -s file.txt", "ex file.py"], neg: ["sed -n 1p a.txt", "echo ed"] },
  sponge: { word: "| sponge ", pos: ["sort a.txt | sponge a.txt"], neg: ["echo sponge", "sort a.txt"] },
  "awk-inplace": { word: "awk -i inplace ", pos: ["awk -i inplace '{print}' a.txt"], neg: ["awk '{print}' a.txt", "echo inplace"] },
  "ruby-inplace": { word: "ruby -i ", pos: ["ruby -i -pe 'x' a.rb"], neg: ["ruby script.rb", "echo ruby"] },
  "download-out": { word: "curl ", pos: ["curl -o a.js http://x", "wget -O a.js http://x"], neg: ["curl -o /dev/null http://x", "curl http://x"] },
  "python-bytes-write": { word: ".open(", pos: ["p.write_bytes(b)", "p.open('wb')"], neg: ["p.read_bytes()", "p.open('rb')"] },
  "clobber-redirect": { word: ">| ", pos: ["echo x >| a.txt"], neg: ["echo x > a.txt", "echo x | cat"] },
};

function loadCatalog() {
  const text = readFileSync(CATALOG_PATH, "utf8");
  const section = text.slice(text.indexOf("## Known Patterns"));
  const match = section.match(/```json\n([\s\S]*?)\n```/);
  return JSON.parse(match[1]);
}

function timeMatch(re, input) {
  const start = performance.now();
  re.test(input);
  return performance.now() - start;
}

test("known patterns catalog validates, has cases, and stays fast", () => {
  const block = loadCatalog();
  assert.deepEqual(validateBash(block), []);

  const names = block.writePatterns.map((p) => p.name).sort();
  assert.deepEqual(names, Object.keys(CASES).sort());

  for (const entry of block.writePatterns) {
    const re = new RegExp(entry.match);
    const spec = CASES[entry.name];
    assert.ok(spec.pos.length >= 1 && spec.neg.length >= 1, entry.name);
    for (const cmd of spec.pos) {
      assert.ok(re.test(cmd), `${entry.name} should match: ${cmd}`);
    }
    for (const cmd of spec.neg) {
      assert.ok(!re.test(cmd), `${entry.name} should not match: ${cmd}`);
    }

    const newlines = "\n".repeat(100000);
    const repeated = spec.word.repeat(Math.ceil(100000 / spec.word.length));
    timeMatch(re, "warm up");
    assert.ok(timeMatch(re, newlines) < 250, `${entry.name} slow on newlines`);
    assert.ok(timeMatch(re, repeated) < 250, `${entry.name} slow on repeated word`);
  }
});
