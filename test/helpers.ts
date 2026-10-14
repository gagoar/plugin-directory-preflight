import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const SCRIPTS = join(import.meta.dirname, "..", "scripts");

// Trigger text is assembled from parts so these test files do not contain the shapes they check:
// the repository is scanned too.
export const COMMAND_WORD = ["dec", "lare"].join("");
export const ENV_WORD = ["pro", "cess.", "env"].join("");
export const PLACEHOLDER = ["$", "{key}"].join("");
export const SCHEME = ["ht", "tps://"].join("");
export const DEEP_GLOB = ["*", "*"].join("");
export const IMAGE_NAME = ["ic", "on.png"].join("");
export const LONGER_NAME = ["lo", "go.png"].join("");
export const SHORT_NAME = ["o", ".png"].join("");

export interface Result {
  readonly status: number | null;
  readonly out: string;
}

export function run(script: string, args: readonly string[]): Result {
  const done = spawnSync("node", [join(SCRIPTS, script), ...args], { encoding: "utf8" });
  return { status: done.status, out: `${done.stdout}${done.stderr}` };
}

// Writes `files` (relative path -> text) into a fresh temporary directory and returns it.
export function tree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "preflight-"));
  Object.entries(files).forEach(([path, text]) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  });
  return root;
}
