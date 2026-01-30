#!/usr/bin/env node
/**
 * checkmate.mjs
 * Unified entry point for checkmate scripts.
 *
 * Usage:
 *   node checkmate.mjs pre-tool    # Agent enforcement (stdin: hook JSON)
 *   node checkmate.mjs post-tool   # Quality checks (stdin: hook JSON)
 *   node checkmate.mjs post-task   # Task review (stdin: hook JSON)
 *   node checkmate.mjs validate    # Config validation (argv: file path)
 */

const subcommand = process.argv[2];

const handlers = {
  "pre-tool": () => import("./lib/pre-tool.mjs"),
  "post-tool": () => import("./lib/post-tool.mjs"),
  "post-task": () => import("./lib/post-task.mjs"),
  validate: () => import("./lib/validate.mjs"),
};

const loader = handlers[subcommand];

if (!loader) {
  console.error(`Usage: node checkmate.mjs <pre-tool|post-tool|post-task|validate>`);
  process.exit(1);
}

const mod = await loader();
await mod.run();
