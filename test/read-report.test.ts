import assert from "node:assert/strict";
import { test } from "node:test";
import { run, tree } from "./helpers.ts";

const PAIRING = {
  ruleId: "MCP_FORWARDS_CREDENTIAL_ENV",
  hold: true,
  path: ".claude-plugin/plugin.json",
  message: "Across its surfaces this plugin reads the installer's environment (file engine/dist/b.js) and can send data off the machine.",
  params: { credential_at: "engine/dist/b.js", sender_at: "engine/dist/c.js", env: "environment" },
};
const WARNING = { ruleId: "UNKNOWN_KEY", severity: "SEVERITY_WARNING", path: ".claude-plugin/plugin.json", message: "No action needed." };
const FILES = ["README.md", "engine/a.mjs", "engine/dist/b.js", "docs/logo.png"].map((path) => ({ path, kind: "file" }));
const PHASES = [{ name: "lints", outcome: "CHECK_WARN" }];

const report = (diagnostics: readonly object[], extra: object = {}): string =>
  tree({ "r.json": JSON.stringify({ report: { phases: PHASES, inventory: { files: FILES }, diagnostics, ...extra } }) });

test("read-report: a hold fails, names the file and lists what sorts before it", () => {
  const result = run("read-report.ts", [`${report([PAIRING, WARNING])}/r.json`]);
  assert.equal(result.status, 1);
  assert.match(result.out, /credential_at: engine\/dist\/b\.js/);
  assert.match(result.out, /2 readable file\(s\) sort before engine\/dist\/b\.js/);
  assert.match(result.out, /engine\/a\.mjs/);
  assert.doesNotMatch(result.out, /logo\.png/);
  assert.match(result.out, /UNKNOWN_KEY x1/);
});

test("read-report: warnings alone are clean", () => {
  const result = run("read-report.ts", [`${report([WARNING])}/r.json`]);
  assert.equal(result.status, 0);
  assert.match(result.out, /clean: no holds and nothing blocking/);
});

test("read-report: a bare diagnostics array is accepted, with no masking list", () => {
  const dir = tree({ "d.json": JSON.stringify([PAIRING]) });
  const result = run("read-report.ts", [`${dir}/d.json`]);
  assert.equal(result.status, 1);
  assert.match(result.out, /file list is not in this paste/);
});
