import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { run, tree } from "./helpers.ts";

const MANIFEST = JSON.stringify({ name: "demo", version: "1.0.0" });

test("install-gate: a repository with the plugin at the root gets the gate and a workflow", () => {
  const repo = tree({ ".claude-plugin/plugin.json": MANIFEST });
  assert.equal(run("install-gate.ts", [repo, "--check"]).status, 1);
  assert.equal(run("install-gate.ts", [repo]).status, 0);
  assert.equal(run("install-gate.ts", [repo, "--check"]).status, 0);
  assert.match(readFileSync(`${repo}/.github/workflows/plugin-safety.yml`, "utf8"), /claude plugin validate \. --strict/);
});

test("install-gate: a plugin in a subdirectory is validated at that path", () => {
  const repo = tree({ "plugin/.claude-plugin/plugin.json": MANIFEST, "plugin/skills/x/SKILL.md": "x" });
  run("install-gate.ts", [repo]);
  const workflow = readFileSync(`${repo}/.github/workflows/plugin-safety.yml`, "utf8");
  assert.match(workflow, /claude plugin validate plugin --strict/);
  assert.match(workflow, /claude plugin validate plugin\/skills --strict/);
});

test("install-gate: a workflow that differs is left alone unless forced", () => {
  const repo = tree({ ".claude-plugin/plugin.json": MANIFEST, ".github/workflows/plugin-safety.yml": "name: custom\n" });
  assert.match(run("install-gate.ts", [repo]).out, /left alone/);
  assert.equal(readFileSync(`${repo}/.github/workflows/plugin-safety.yml`, "utf8"), "name: custom\n");
  run("install-gate.ts", [repo, "--force"]);
  assert.notEqual(readFileSync(`${repo}/.github/workflows/plugin-safety.yml`, "utf8"), "name: custom\n");
});

test("install-gate: a directory with no plugin is refused", () => {
  const repo = tree({ "a.txt": "x" });
  assert.equal(run("install-gate.ts", [repo]).status, 2);
  assert.ok(!existsSync(`${repo}/scripts`));
});
