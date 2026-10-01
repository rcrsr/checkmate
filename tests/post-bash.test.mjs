import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import {
  DEFAULT_WRITE_PATTERNS,
  resolveWritePatterns,
  getCheckedExtensions,
  detectBashWrites,
} from "../scripts/lib/lib.mjs";

const BASE = "/proj";
const EXTS = ["py", "ts", "tsx", "md"];

function detect(command, extensions) {
  return detectBashWrites(command, {
    patterns: resolveWritePatterns(null),
    extensions: extensions || EXTS,
    baseDir: BASE,
  });
}

describe("DEFAULT_WRITE_PATTERNS", () => {
  it("lists patterns in the documented order", () => {
    assert.deepEqual(
      DEFAULT_WRITE_PATTERNS.map((p) => p.name),
      ["sed-inplace", "perl-inplace", "python-write", "node-write", "redirect", "tee", "cp-mv-into-repo"],
    );
  });
});

describe("detectBashWrites patterns", () => {
  it("matches sed in-place", () => {
    const r = detect("sed -i 's/a/b/' 'src/routes/users.$id.tsx'");
    assert.ok(r.matched.includes("sed-inplace"));
    assert.deepEqual(r.paths, ["/proj/src/routes/users.$id.tsx"]);
  });

  it("does not match sed without in-place", () => {
    assert.deepEqual(detect("sed -n '1p' x.py").matched, []);
  });

  it("matches sed in-place with the flag among other options", () => {
    assert.ok(detect("sed -E -i s/a/b/ x.py").matched.includes("sed-inplace"));
    assert.ok(detect("sed -e s/a/b/ -i x.py").matched.includes("sed-inplace"));
    assert.ok(detect("sed --in-place=.bak s/a/b/ x.py").matched.includes("sed-inplace"));
    assert.deepEqual(detect("sed -n p x.py").matched, []);
  });

  it("matches perl -p -i -e", () => {
    assert.ok(detect("perl -p -i -e 's/a/b/' x.py").matched.includes("perl-inplace"));
  });

  it("matches redirect operators with a descriptor or ampersand", () => {
    assert.ok(detect("cmd 2> err.py").matched.includes("redirect"));
    assert.ok(detect("cmd &> o.py").matched.includes("redirect"));
    assert.ok(detect("cmd &>> o.py").matched.includes("redirect"));
    assert.deepEqual(detect("cmd 2>&1").matched, []);
    assert.deepEqual(detect("cmd &> /dev/null").matched, []);
  });

  it("matches tee only for a non-scratch first target", () => {
    assert.ok(!detect("echo a | tee /tmp/x.log").matched.includes("tee"));
    assert.ok(!detect("echo a | tee /dev/null").matched.includes("tee"));
    assert.ok(detect("echo a | tee -a src/x.py").matched.includes("tee"));
  });

  it("matches python and node write forms", () => {
    assert.ok(detect("node -e \"fs.promises.writeFile('x.ts','a')\"").matched.includes("node-write"));
    assert.ok(detect("python3 -c \"open(p, mode='w')\"").matched.includes("python-write"));
    assert.ok(detect("python3 -c \"open(p,'r+')\"").matched.includes("python-write"));
    assert.deepEqual(detect("python3 -c \"open(p,'r')\"").matched, []);
    assert.deepEqual(detect("python3 -c \"open(p,'rb')\"").matched, []);
  });

  it("matches perl in-place", () => {
    assert.ok(detect("perl -pi -e 's/a/b/' x.py").matched.includes("perl-inplace"));
  });

  it("does not match perl without in-place", () => {
    assert.deepEqual(detect("perl -e 'print 1' x.py").matched, []);
  });

  it("matches python heredoc write after a cd", () => {
    const cmd =
      "cd /repo/pkg/tests && python3 - <<'EOF'\np='services/test_x.py'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF";
    const r = detect(cmd);
    assert.ok(r.matched.includes("python-write"));
    assert.deepEqual(r.paths, ["/repo/pkg/tests/services/test_x.py"]);
  });

  it("does not match python read-only open", () => {
    assert.deepEqual(detect("python3 -c \"open('x.py').read()\"").matched, []);
  });

  it("matches node writeFileSync", () => {
    assert.ok(detect("node -e \"fs.writeFileSync('x.ts','a')\"").matched.includes("node-write"));
  });

  it("does not match node readFileSync", () => {
    assert.deepEqual(detect("node -e \"fs.readFileSync('x.ts')\"").matched, []);
  });

  it("matches redirect onto a file", () => {
    const r = detect("cat > lib/models/x.py <<'EOF'");
    assert.ok(r.matched.includes("redirect"));
    assert.deepEqual(r.paths, ["/proj/lib/models/x.py"]);
  });

  it("matches redirect onto an extension outside any fixed list", () => {
    assert.ok(detect("echo a > notes.xyz").matched.includes("redirect"));
  });

  it("does not treat 2>/dev/null as a redirect", () => {
    assert.deepEqual(detect("ls x.py 2>/dev/null").matched, []);
  });

  it("does not treat an arrow function inside a script body as a redirect", () => {
    assert.deepEqual(detect("node -e 'xs.map(x => x.name)'").matched, []);
    assert.deepEqual(detect("node -e 'run(x=>y.py)'").matched, []);
  });

  it("still matches a redirect glued to the target", () => {
    assert.ok(detect("echo a >x.py").matched.includes("redirect"));
    assert.ok(detect("echo a >>x.py").matched.includes("redirect"));
  });

  it("does not match a redirect onto a scratch or system target", () => {
    const commands = [
      "echo a > /tmp/x.log",
      "echo a >>/tmp/x.log",
      "echo a > /dev/null",
      "echo a > $TMPDIR/x.log",
      'echo a > "${TMPDIR}/x.log"',
      "echo a > ~/.claude/x.json",
      "echo a > $HOME/.claude/x.json",
    ];
    for (const command of commands) {
      assert.ok(!detect(command).matched.includes("redirect"), command);
    }
  });

  it("matches a repo redirect that follows a scratch redirect", () => {
    const r = detect("cmd > /tmp/a.log && echo x > src/b.py");
    assert.ok(r.matched.includes("redirect"));
    assert.deepEqual(r.paths, ["/proj/src/b.py"]);
  });

  it("matches cp and mv into the repo", () => {
    assert.ok(detect("cp /tmp/bak.py src/app.py").matched.includes("cp-mv-into-repo"));
    assert.ok(detect("mv a.py b.py").matched.includes("cp-mv-into-repo"));
    assert.ok(detect("cp -r a b/").matched.includes("cp-mv-into-repo"));
    assert.ok(detect("cd x && cp a.py b.py; echo done").matched.includes("cp-mv-into-repo"));
  });

  it("does not match cp or mv out to a scratch or system target", () => {
    assert.ok(!detect("cp src/app.py /tmp/app.py.bak").matched.includes("cp-mv-into-repo"));
    assert.ok(!detect('cp a "$TMPDIR/b"').matched.includes("cp-mv-into-repo"));
    assert.ok(!detect("mv a ~/.claude/b").matched.includes("cp-mv-into-repo"));
  });

  it("ignores a trailing redirection when finding the cp or mv destination", () => {
    assert.ok(!detect("cp src/a.py /tmp/b.py 2>&1").matched.includes("cp-mv-into-repo"));
    assert.ok(!detect("cp a.py /tmp/x 2>/dev/null").matched.includes("cp-mv-into-repo"));
    assert.ok(!detect('mv a "$TMPDIR/b" 2>&1').matched.includes("cp-mv-into-repo"));
    assert.ok(detect("cp a.py b.py 2>&1").matched.includes("cp-mv-into-repo"));
    assert.ok(detect("cp a.py b.py 2>/dev/null").matched.includes("cp-mv-into-repo"));
    assert.ok(detect("cp /tmp/x.py src/a.py 2>&1").matched.includes("cp-mv-into-repo"));
  });

  it("matches cp with a 60-90 character source path", () => {
    const cmd = "cp apps/pkg/src/some/deep/dir/file_name.py apps/pkg/src/other/dir/file_name.py";
    assert.ok(detect(cmd).matched.includes("cp-mv-into-repo"));
  });

  it("does not match cp with parentheses in an argument but still matches subshell cp", () => {
    assert.ok(!detect('cp "a (1).py" src/').matched.includes("cp-mv-into-repo"));
    assert.ok(detect("(cp a b)").matched.includes("cp-mv-into-repo"));
    assert.ok(detect("cd x && (cp a b)").matched.includes("cp-mv-into-repo"));
  });

  it("anchors cp and mv to the command word", () => {
    assert.ok(!detect("git mv a b").matched.includes("cp-mv-into-repo"));
    assert.ok(!detect("echo cp x y").matched.includes("cp-mv-into-repo"));
  });

  it("matches tee", () => {
    assert.ok(detect("echo a | tee x.py").matched.includes("tee"));
  });

  it("does not match tee as a word fragment", () => {
    assert.deepEqual(detect("cat committee.py").matched, []);
  });
});

describe("detectBashWrites paths", () => {
  it("chains cd commands", () => {
    assert.deepEqual(detect("cd a && cd b && sed -i s/a/b/ x.py").paths, ["/proj/a/b/x.py"]);
  });

  it("ignores a cd that comes after the path", () => {
    assert.deepEqual(detect("sed -i s/a/b/ x.py && cd other").paths, ["/proj/x.py"]);
  });

  it("returns to the previous base for cd -", () => {
    assert.deepEqual(detect("cd a && cd - && sed -i s/a/b/ x.py").paths, ["/proj/x.py"]);
  });

  it("leaves the base unchanged for cd - with no previous base", () => {
    assert.deepEqual(detect("cd - && sed -i s/a/b/ x.py").paths, ["/proj/x.py"]);
  });

  it("expands ~ in cd to the home directory", () => {
    const r = detect("cd ~/w && sed -i s/a/b/ x.py");
    assert.deepEqual(r.paths, [`${os.homedir()}/w/x.py`]);
  });

  it("resolves against the single base dir and de-duplicates", () => {
    const r = detectBashWrites("sed -i s/a/b/ x.py /abs/y.py x.py", {
      patterns: resolveWritePatterns(null),
      extensions: EXTS,
      baseDir: "/p1",
    });
    assert.deepEqual(r.paths, ["/p1/x.py", "/abs/y.py"]);
  });

  it("extracts a quoted path containing spaces whole", () => {
    assert.deepEqual(detect("sed -i s/a/b/ 'my dir/x.py'").paths, ["/proj/my dir/x.py"]);
    assert.deepEqual(detect('sed -i s/a/b/ "my dir/x.py"').paths, ["/proj/my dir/x.py"]);
  });

  it("follows a quoted cd argument with spaces", () => {
    assert.deepEqual(detect('cd "my dir" && sed -i s/a/b/ x.py').paths, ["/proj/my dir/x.py"]);
  });

  it("extracts a bracketed route path", () => {
    assert.deepEqual(detect("sed -i s/a/b/ app/[id]/page.tsx").paths, ["/proj/app/[id]/page.tsx"]);
  });

  it("expands ~/ for unquoted tokens only", () => {
    assert.deepEqual(detect("sed -i s/a/b/ ~/w/x.py").paths, [`${os.homedir()}/w/x.py`]);
    assert.deepEqual(detect("sed -i s/a/b/ '~/w/x.py'").paths, ["/proj/~/w/x.py"]);
  });

  it("ignores a cd with $, backtick or glob in its argument", () => {
    for (const arg of ["$HOME", "`pwd`", "d*", "d?", "d[1]"]) {
      assert.deepEqual(detect(`cd ${arg} && sed -i s/a/b/ x.py`).paths, ["/proj/x.py"], arg);
    }
  });

  it("counts cd only as a command word", () => {
    assert.deepEqual(detect("echo cd a; sed -i s/a/b/ x.py").paths, ["/proj/x.py"]);
  });

  it("collects at most 500 unique paths in first-appearance order", () => {
    const names = [];
    for (let n = 0; n < 510; n++) names.push(`f${n}.py`);
    const r = detect(`sed -i s/a/b/ ${names.join(" ")}`);
    assert.equal(r.paths.length, 500);
    assert.equal(r.paths[0], "/proj/f0.py");
    assert.equal(r.paths[499], "/proj/f499.py");
  });

  it("extracts any letter-led extension when extensions is null", () => {
    const cmd = "echo a > notes.xyz";
    const r = detectBashWrites(cmd, { patterns: resolveWritePatterns(null), extensions: null, baseDir: BASE });
    assert.deepEqual(r.paths, ["/proj/notes.xyz"]);
  });

  it("returns an empty result when extensions is empty", () => {
    const r = detectBashWrites("echo a > x.py", { patterns: resolveWritePatterns(null), extensions: [], baseDir: BASE });
    assert.deepEqual(r, { matched: [], paths: [] });
  });

  it("detects a write after 20000 chars of padding", () => {
    const r = detect(" ".repeat(20000) + "sed -i s/a/b/ x.py");
    assert.deepEqual(r.matched, ["sed-inplace"]);
    assert.deepEqual(r.paths, ["/proj/x.py"]);
  });

  it("ignores a write after 100000 chars of padding", () => {
    const r = detect(" ".repeat(100000) + "sed -i s/a/b/ x.py");
    assert.deepEqual(r, { matched: [], paths: [] });
  });

  it("scans a 100000-char line quickly with the default patterns", () => {
    const inputs = [
      "\n".repeat(100000),
      "sed ".repeat(25000),
      "perl ".repeat(20000),
      "tee ".repeat(25000),
      "cd ".repeat(33000),
      '"'.repeat(100000),
      '"a '.repeat(33000),
      "sed -i s/a/b/ x.py" + "\n".repeat(99000),
      "cd x;".repeat(20000) + " sed -i s/a/b/ y.py",
      "sed -i s/a/b/ x.py;" + "cd x;".repeat(10000) + " y.py".repeat(10000),
      " ".repeat(100000),
      "a ".repeat(50000),
      "cp" + " ".repeat(99998),
      "mv" + "\t".repeat(99998),
      "cp" + " ".repeat(99997) + ";",
      (";cp" + " ".repeat(1000)).repeat(99),
      "cp a" + " 2>&1".repeat(25000),
      "cp a b" + " 2>/dev/null".repeat(10000),
      "(cp ".repeat(25000),
      "cp a b ".repeat(14000),
      "(mv ".repeat(25000),
    ];
    for (const cmd of inputs) detect(cmd);
    for (const cmd of inputs) {
      const start = Date.now();
      detect(cmd);
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 250, `slow (${elapsed} ms) on ${JSON.stringify(cmd.slice(0, 30))}`);
    }
  });

  it("detects the write target inside a quoted wrapper command", () => {
    const r = detect('bash -c "sed -i s/a/b/ x.py"');
    assert.ok(r.paths.includes("/proj/x.py"));
  });

  it("gives no path for an extension outside the configured set", () => {
    assert.deepEqual(detect("sed -i s/a/b/ x.rb").paths, []);
  });
});

describe("resolveWritePatterns", () => {
  it("overrides a default in place", () => {
    const r = resolveWritePatterns({ writePatterns: [{ name: "tee", match: "TEE" }] });
    assert.equal(r.length, DEFAULT_WRITE_PATTERNS.length);
    assert.equal(r[5].name, "tee");
    assert.equal(r[5].match, "TEE");
    assert.ok(r[5].re.test("TEE"));
  });

  it("appends a new name", () => {
    const r = resolveWritePatterns({ writePatterns: [{ name: "dd", match: "\\bdd\\s" }] });
    assert.equal(r.length, DEFAULT_WRITE_PATTERNS.length + 1);
    assert.equal(r[r.length - 1].name, "dd");
  });

  it("drops an invalid regex without throwing", () => {
    const r = resolveWritePatterns({ writePatterns: [{ name: "bad", match: "(" }] });
    assert.equal(r.length, DEFAULT_WRITE_PATTERNS.length);
    assert.ok(!r.some((p) => p.name === "bad"));
  });

  it("drops a nested-quantifier config entry at runtime", () => {
    const r = resolveWritePatterns({ writePatterns: [{ name: "evil", match: "(a+)+" }] });
    assert.equal(r.length, DEFAULT_WRITE_PATTERNS.length);
    assert.ok(!r.some((p) => p.name === "evil"));
  });

  it("keeps the default when an override risks repeated alternation", () => {
    const r = resolveWritePatterns({ writePatterns: [{ name: "tee", match: "(a|aa)+" }] });
    const tee = r.find((p) => p.name === "tee");
    assert.equal(tee.match, DEFAULT_WRITE_PATTERNS.find((p) => p.name === "tee").match);
  });

  it("compiles without global or sticky flags", () => {
    for (const p of resolveWritePatterns(null)) {
      assert.ok(!p.re.global && !p.re.sticky);
    }
  });
});

describe("getCheckedExtensions", () => {
  it("splits, strips dots, and de-duplicates across environments", () => {
    const config = {
      environments: {
        a: { checks: { "py,.pyi": [], ts: [] } },
        b: { checks: { ".ts": [], md: [] } },
      },
    };
    assert.deepEqual(getCheckedExtensions(config), ["py", "pyi", "ts", "md"]);
  });

  it("returns empty for missing config", () => {
    assert.deepEqual(getCheckedExtensions(null), []);
  });
});

// =============================================================================
// End-to-end: checkmate.mjs post-bash
// =============================================================================

const SCRIPT = path.resolve(import.meta.dirname, "../scripts/checkmate.mjs");

// Fails (stderr output, exit 1) when the file contains BAD.
const CHECK_SCRIPT =
  "const t=require('fs').readFileSync(process.argv[1],'utf8');if(t.includes('BAD')){console.error('found BAD');process.exit(1)}";

function baseConfig(extra) {
  return {
    environments: [
      {
        name: "root",
        paths: ["."],
        checks: {
          ".py": [
            { name: "badcheck", command: "node", args: ["-e", CHECK_SCRIPT, "$FILE"], parser: "generic" },
          ],
        },
      },
    ],
    ...extra,
  };
}

function git(cwd, ...args) {
  const r = spawnSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    encoding: "utf-8",
  });
  assert.equal(r.status, 0, r.stderr);
}

function makeWorkspace() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "checkmate-bash-")));
}

/** Create <workspace>/project with config; optionally a git repo with an initial commit. */
function makeProject(workspace, config, files, useGit) {
  const root = path.join(workspace, "project");
  fs.mkdirSync(path.join(root, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".claude", "checkmate.json"), JSON.stringify(config));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  if (useGit) {
    git(root, "init", "-q");
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
  }
  return root;
}

function postBash(root, toolInput, extraInput) {
  return spawnSync("node", [SCRIPT, "post-bash"], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: toolInput, cwd: root, ...extraInput }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
    encoding: "utf-8",
  });
}

function withWorkspace(fn) {
  const workspace = makeWorkspace();
  try {
    fn(workspace);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

function dirty(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

describe("post-bash end-to-end", () => {
  it("blocks on a dirty failing file and names its relative path", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "bad.py": "ok\n" }, true);
      dirty(root, "bad.py", "BAD\n");
      const r = postBash(root, { command: "sed -i 's/a/b/' bad.py" });
      const out = JSON.parse(r.stdout);
      assert.equal(r.status, 0);
      assert.equal(out.decision, "block");
      assert.match(out.reason, /<new-diagnostics>\nbad\.py:/);
      assert.match(out.reason, /<reproduce-with>/);
    });
  });

  it("stays silent for a clean committed failing file named in a matching command", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "bad.py": "BAD\n" }, true);
      const r = postBash(root, { command: "sed -i 's/a/b/' bad.py" });
      assert.equal(r.stdout, "");
      assert.equal(r.status, 0);
    });
  });

  it("stays silent for a read-only command on a dirty failing file", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "bad.py": "ok\n" }, true);
      dirty(root, "bad.py", "BAD\n");
      const r = postBash(root, { command: "cat bad.py" });
      assert.equal(r.stdout, "");
    });
  });

  it("checks an untracked new file in a new directory", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "keep.py": "ok\n" }, true);
      dirty(root, "newdir/deep/new.py", "BAD\n");
      const r = postBash(root, { command: "echo BAD > newdir/deep/new.py" });
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, "block");
      assert.match(out.reason, /newdir\/deep\/new\.py:/);
    });
  });

  it("follows a chained cd into a subdirectory where the file exists", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "keep.py": "ok\n" }, true);
      dirty(root, "sub/only.py", "BAD\n");
      const r = postBash(root, { command: "cd sub && sed -i 's/a/b/' only.py" });
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, "block");
      assert.match(out.reason, /sub\/only\.py:/);
    });
  });

  it("resolves relative paths against the hook cwd as well as the project root", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "keep.py": "ok\n" }, true);
      dirty(root, "sub/only.py", "BAD\n");
      const r = postBash(root, { command: "sed -i 's/a/b/' only.py" }, { cwd: path.join(root, "sub") });
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, "block");
      assert.match(out.reason, /sub\/only\.py:/);
    });
  });

  it("ignores a sibling directory outside the project", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "keep.py": "ok\n" }, true);
      const sibling = path.join(ws, "sibling", "bad.py");
      fs.mkdirSync(path.dirname(sibling), { recursive: true });
      fs.writeFileSync(sibling, "BAD\n");
      const r = postBash(root, { command: `sed -i 's/a/b/' ${sibling}` });
      assert.equal(r.stdout, "");
    });
  });

  it("checks 10 of 12 dirty files by default and reports the 2 skipped", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "keep.py": "ok\n" }, true);
      const names = [];
      for (let i = 1; i <= 12; i++) {
        names.push(`f${i}.py`);
        dirty(root, `f${i}.py`, "ok\n");
      }
      const r = postBash(root, { command: `sed -i 's/a/b/' ${names.join(" ")}` });
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, undefined);
      assert.equal(out.systemMessage.match(/f\d+\.py: /g).length, 10);
      assert.match(out.systemMessage, /2 file\(s\) over maxFiles skipped: f11\.py,f12\.py/);
    });
  });

  it("honors a configured maxFiles", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig({ bash: { maxFiles: 2 } }), { "keep.py": "ok\n" }, true);
      const names = ["a.py", "b.py", "c.py", "d.py"];
      for (const n of names) dirty(root, n, "ok\n");
      const r = postBash(root, { command: `sed -i 's/a/b/' ${names.join(" ")}` });
      const out = JSON.parse(r.stdout);
      assert.equal(out.systemMessage.match(/[a-d]\.py: /g).length, 2);
      assert.match(out.systemMessage, /2 file\(s\) over maxFiles skipped: c\.py,d\.py/);
    });
  });

  it("stays silent when sed-inplace is overridden with a never-matching pattern", () => {
    withWorkspace((ws) => {
      const config = baseConfig({ bash: { writePatterns: [{ name: "sed-inplace", match: "(?!)" }] } });
      const root = makeProject(ws, config, { "bad.py": "ok\n" }, true);
      dirty(root, "bad.py", "BAD\n");
      const r = postBash(root, { command: "sed -i 's/a/b/' bad.py" });
      assert.equal(r.stdout, "");
    });
  });

  it("triggers checks for a new custom pattern name, and not without it", () => {
    withWorkspace((ws) => {
      const config = baseConfig({ bash: { writePatterns: [{ name: "sponge-write", match: "\\bsponge\\s" }] } });
      const root = makeProject(ws, config, { "bad.py": "ok\n" }, true);
      dirty(root, "bad.py", "BAD\n");
      const out = JSON.parse(postBash(root, { command: "sort in.txt | sponge bad.py" }).stdout);
      assert.equal(out.decision, "block");

      const plain = makeProject(path.join(ws, "plain"), baseConfig(), { "bad.py": "ok\n" }, true);
      dirty(plain, "bad.py", "BAD\n");
      assert.equal(postBash(plain, { command: "sort in.txt | sponge bad.py" }).stdout, "");
    });
  });

  it("checks a dirty file restored by cp, and ignores a copy out to /tmp", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "src/app.py": "ok\n" }, true);
      dirty(root, "src/app.py", "BAD\n");
      const restored = postBash(root, { command: "cp /tmp/restored.py src/app.py" });
      const out = JSON.parse(restored.stdout);
      assert.equal(out.decision, "block");
      assert.match(out.reason, /src\/app\.py:/);

      const copyOut = postBash(root, { command: "cp src/app.py /tmp/app.py.bak" });
      assert.equal(copyOut.stdout, "");
    });
  });

  it("emits the git-skip message during a rebase", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "bad.py": "ok\n" }, true);
      dirty(root, "bad.py", "BAD\n");
      fs.mkdirSync(path.join(root, ".git", "rebase-merge"));
      const out = JSON.parse(postBash(root, { command: "sed -i 's/a/b/' bad.py" }).stdout);
      assert.equal(out.decision, undefined);
      assert.match(out.systemMessage, /skipped \(git rebase in progress\)/);
    });
  });

  it("stays silent during a rebase when the command names no checked file", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "bad.py": "ok\n" }, true);
      dirty(root, "bad.py", "BAD\n");
      fs.mkdirSync(path.join(root, ".git", "rebase-merge"));
      const r = postBash(root, { command: "sed -i 's/a/b/' notes.txt" });
      assert.equal(r.stdout, "");
    });
  });

  it("emits one diagnostics block per failing file and a single reproduce-with", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "a.py": "ok\n", "b.py": "ok\n" }, true);
      dirty(root, "a.py", "BAD\n");
      dirty(root, "b.py", "BAD\n");
      const out = JSON.parse(postBash(root, { command: "sed -i 's/x/y/' a.py b.py" }).stdout);
      assert.equal(out.decision, "block");
      assert.equal(out.reason.match(/<new-diagnostics>/g).length, 2);
      assert.match(out.reason, /<new-diagnostics>\na\.py:/);
      assert.match(out.reason, /<new-diagnostics>\nb\.py:/);
      assert.equal(out.reason.match(/<reproduce-with>/g).length, 1);
      assert.equal(out.reason.match(/<\/reproduce-with>/g).length, 1);
      const repro = out.reason.split("<reproduce-with>")[1];
      const lines = repro.split("</reproduce-with>")[0].trim().split("\n");
      assert.equal(new Set(lines.map((l) => l.trim())).size, lines.length);
    });
  });

  it("stays silent for a deleted tracked file named in a matching command", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "bad.py": "BAD\n" }, true);
      git(root, "rm", "-q", "bad.py");
      const r = postBash(root, { command: "sed -i 's/a/b/' bad.py" });
      assert.equal(r.stdout, "");
    });
  });

  it("checks the new path of a rename and ignores the old path", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "old.py": "BAD\n" }, true);
      git(root, "mv", "old.py", "new.py");
      const out = JSON.parse(postBash(root, { command: "sed -i 's/a/b/' new.py" }).stdout);
      assert.equal(out.decision, "block");
      assert.match(out.reason, /<new-diagnostics>\nnew\.py:/);
      assert.ok(!out.reason.includes("old.py"));
      // Naming only the old path (now gone) must not produce a check.
      assert.equal(postBash(root, { command: "sed -i 's/a/b/' old.py" }).stdout, "");
    });
  });

  it("stays silent for a background command", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "bad.py": "ok\n" }, true);
      dirty(root, "bad.py", "BAD\n");
      const r = postBash(root, { command: "sed -i 's/a/b/' bad.py", run_in_background: true });
      assert.equal(r.stdout, "");
    });
  });

  it("stays silent when bash.enabled is false", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig({ bash: { enabled: false } }), { "bad.py": "ok\n" }, true);
      dirty(root, "bad.py", "BAD\n");
      assert.equal(postBash(root, { command: "sed -i 's/a/b/' bad.py" }).stdout, "");
    });
  });

  it("stays silent for a tool other than Bash", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "bad.py": "ok\n" }, true);
      dirty(root, "bad.py", "BAD\n");
      const r = postBash(root, { command: "sed -i 's/a/b/' bad.py" }, { tool_name: "Read" });
      assert.equal(r.stdout, "");
    });
  });

  it("falls back to file existence in a non-git project", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "bad.py": "BAD\n" }, false);
      const out = JSON.parse(postBash(root, { command: "sed -i 's/a/b/' bad.py" }).stdout);
      assert.equal(out.decision, "block");
      assert.match(out.reason, /bad\.py:/);
    });
  });

  it("drops a nonexistent path in a non-git project", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "keep.py": "ok\n" }, false);
      assert.equal(postBash(root, { command: "sed -i 's/a/b/' missing.py" }).stdout, "");
    });
  });

  it("uses the hook cwd as the only base for relative paths", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "keep.py": "ok\n" }, true);
      dirty(root, "only.py", "BAD\n");
      dirty(root, "sub/only.py", "BAD\n");
      const r = postBash(root, { command: "sed -i 's/a/b/' only.py" }, { cwd: path.join(root, "sub") });
      const out = JSON.parse(r.stdout);
      assert.equal(out.decision, "block");
      assert.match(out.reason, /sub\/only\.py:/);
      assert.ok(!/(^|\n)only\.py:/.test(out.reason));
    });
  });

  it("lets a nested repo own its extensions", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "keep.py": "ok\n" }, true);
      const nestedConfig = {
        environments: [
          {
            name: "nested",
            paths: ["."],
            checks: {
              ".md": [{ name: "badmd", command: "node", args: ["-e", CHECK_SCRIPT, "$FILE"], parser: "generic" }],
            },
          },
        ],
      };
      const nested = path.join(root, "nested");
      fs.mkdirSync(path.join(nested, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(nested, ".claude", "checkmate.json"), JSON.stringify(nestedConfig));
      fs.writeFileSync(path.join(nested, "x.md"), "ok\n");
      git(nested, "init", "-q");
      git(nested, "add", "-A");
      git(nested, "commit", "-q", "-m", "init");
      dirty(nested, "x.md", "BAD\n");
      const out = JSON.parse(postBash(root, { command: "sed -i 's/a/b/' nested/x.md" }).stdout);
      assert.equal(out.decision, "block");
      assert.match(out.reason, /nested\/x\.md:/);
    });
  });

  it("blocks on invalid JSON written to checkmate.json", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "keep.py": "ok\n" }, true);
      dirty(root, ".claude/checkmate.json", "{\n");
      const out = JSON.parse(postBash(root, { command: "echo '{' > .claude/checkmate.json" }).stdout);
      assert.equal(out.decision, "block");
      assert.match(out.reason, /Invalid JSON/);
    });
  });

  it("reports 2 files over maxFiles when 12 failing files are written", () => {
    withWorkspace((ws) => {
      const root = makeProject(ws, baseConfig(), { "keep.py": "ok\n" }, true);
      const names = [];
      for (let i = 1; i <= 12; i++) {
        names.push(`f${i}.py`);
        dirty(root, `f${i}.py`, "BAD\n");
      }
      const out = JSON.parse(postBash(root, { command: `sed -i 's/a/b/' ${names.join(" ")}` }).stdout);
      assert.equal(out.decision, "block");
      assert.match(out.reason, /2 file\(s\) over maxFiles skipped/);
    });
  });

  it("passes with a not-found message when the check command is missing", () => {
    withWorkspace((ws) => {
      const config = {
        environments: [
          {
            name: "root",
            paths: ["."],
            checks: {
              ".py": [{ name: "ghost", command: "checkmate-no-such-command", args: ["$FILE"], parser: "generic" }],
            },
          },
        ],
      };
      const root = makeProject(ws, config, { "bad.py": "ok\n" }, true);
      dirty(root, "bad.py", "BAD\n");
      const out = JSON.parse(postBash(root, { command: "sed -i 's/a/b/' bad.py" }).stdout);
      assert.equal(out.decision, undefined);
      assert.match(out.systemMessage, /not found - skipping/);
    });
  });

  it("stays silent for an excluded path", () => {
    withWorkspace((ws) => {
      const config = baseConfig();
      config.environments[0].exclude = ["vendor/**"];
      const root = makeProject(ws, config, { "keep.py": "ok\n" }, true);
      dirty(root, "vendor/bad.py", "BAD\n");
      assert.equal(postBash(root, { command: "sed -i 's/a/b/' vendor/bad.py" }).stdout, "");
    });
  });

  it("stops checking when the time budget is spent but always checks the first file", () => {
    withWorkspace((ws) => {
      const sleepScript = "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2300)";
      const config = {
        environments: [
          {
            name: "root",
            paths: ["."],
            checks: {
              ".py": [{ name: "slow", command: "node", args: ["-e", sleepScript, "$FILE"], parser: "generic" }],
            },
          },
        ],
      };
      const root = makeProject(ws, config, { "keep.py": "ok\n" }, true);
      for (const n of ["a.py", "b.py", "c.py"]) dirty(root, n, "ok\n");
      const out = JSON.parse(postBash(root, { command: "sed -i 's/a/b/' a.py b.py c.py" }).stdout);
      assert.match(out.systemMessage, /a\.py: /);
      assert.match(out.systemMessage, /skipped \(time budget\)/);
      assert.match(out.systemMessage, /2 file\(s\) skipped \(time budget\).*b\.py.*c\.py/);
    });
  });
});
