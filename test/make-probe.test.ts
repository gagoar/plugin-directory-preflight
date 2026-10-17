import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMAND_WORD, run, tree } from "./helpers.ts";

// The probe is never listed, so the gate stands in for the scan alone: no listing icon rule.
const NO_ICON = "--no-icon";
const LINES = 1200;
const TRIGGER_LINE = 777;

// Stands in for the directory scan: the gate's first failing file in path order.
const firstFailing = (dir: string): string => {
  const failing = run("check-plugin-safety.ts", [NO_ICON, dir]).out.split("\n").filter((line) => line.startsWith("FAIL "));
  return failing.map((line) => line.slice("FAIL ".length).split(":")[0] ?? "").sort()[0] ?? "";
};

const slice = (path: string): string => path.split("/").at(-1) ?? "";

test("make-probe: three rounds and a window reach the one line that triggers", () => {
  const source = Array.from({ length: LINES }, (_, i) => (i + 1 === TRIGGER_LINE ? `run("${COMMAND_WORD}");` : `const v${i} = ${i % 7};`));
  const dir = tree({ "src.js": `${source.join("\n")}\n` });
  const out = `${dir}/probe-repo`;
  run("make-probe.ts", ["round1", `${dir}/src.js`, out]);
  const first = firstFailing(out);
  assert.match(first, /s1-\d+\.js$/);
  run("make-probe.ts", ["narrow", out, slice(first)]);
  const second = firstFailing(out);
  assert.match(second, /s2-\d+\.js$/);
  run("make-probe.ts", ["narrow", out, slice(second), "4"]);
  const third = firstFailing(out);
  run("make-probe.ts", ["windows", out, slice(third)]);
  const window = firstFailing(out);
  assert.match(window, /w01-\d+\.js$/);
  const explained = run("make-probe.ts", ["explain", out, slice(window)]).out;
  assert.match(explained, new RegExp(`lines ${TRIGGER_LINE}-${TRIGGER_LINE} of`));
  assert.ok(explained.includes(COMMAND_WORD));
});

test("make-probe: the probe is a valid plugin skeleton with a send target and a long README", () => {
  const dir = tree({ "src.js": "a\nb\nc\n" });
  const out = `${dir}/p`;
  run("make-probe.ts", ["round1", `${dir}/src.js`, out, "3"]);
  const manifest = run("check-plugin-safety.ts", [NO_ICON, out]);
  assert.equal(manifest.status, 0, manifest.out);
});
