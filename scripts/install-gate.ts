#!/usr/bin/env node
// Puts the canonical upload gate into a plugin repository, or reports how the repository's copy has drifted.
//
//   node scripts/install-gate.ts <repo>            install or update the gate; add the CI workflow if missing
//   node scripts/install-gate.ts <repo> --check    report only; exit 1 if anything is missing or out of date
//   node scripts/install-gate.ts <repo> --force    also overwrite a CI workflow that differs from the template
//
// The plugin may sit at the repository root or in a plugin/ subdirectory (the marketplace then installs
// from that subdirectory). The gate itself always scans the whole repository.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

type Status = "missing" | "outdated" | "current" | "differs";

interface Target {
  readonly label: string;
  readonly path: string;
  readonly wanted: string;
  readonly overwrite: boolean; // false: leave an existing file alone unless --force
}

const ARGV_START = 2;
const EXIT_USAGE = 2;
const GATE_RELATIVE = join("scripts", "check-plugin-safety.ts");
const WORKFLOW_RELATIVE = join(".github", "workflows", "plugin-safety.yml");
const SUBDIRECTORY = "plugin";
const MANIFEST = join(".claude-plugin", "plugin.json");

const canonicalGate = (): string => readFileSync(join(import.meta.dirname, "check-plugin-safety.ts"), "utf8");

// The directory holding .claude-plugin/plugin.json: the repository root, or its plugin/ subdirectory.
function pluginRoot(repo: string): string | undefined {
  if (existsSync(join(repo, MANIFEST))) return ".";
  return existsSync(join(repo, SUBDIRECTORY, MANIFEST)) ? SUBDIRECTORY : undefined;
}

function workflowFor(repo: string, root: string): string {
  const validates = [`claude plugin validate ${root} --strict`, `claude plugin validate ${join(root, MANIFEST)} --strict`];
  const skills = existsSync(join(repo, root, "skills")) ? [`claude plugin validate ${join(root, "skills")} --strict`] : [];
  return [
    "name: plugin-safety",
    "",
    "on:",
    "  pull_request:",
    "  push:",
    "    branches: [main]",
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    "  plugin-safety:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - uses: actions/setup-node@v4",
    "        with:",
    "          node-version: 24",
    "      - name: Gate what the directory scan holds plugins for",
    "        run: node scripts/check-plugin-safety.ts .",
    "      - name: Install Claude Code CLI",
    "        run: npm install -g @anthropic-ai/claude-code",
    "      - name: Validate plugin",
    "        run: |",
    ...[...validates, ...skills].map((command) => `          ${command}`),
    "",
  ].join("\n");
}

function statusOf(target: Target): Status {
  if (!existsSync(target.path)) return "missing";
  if (readFileSync(target.path, "utf8") === target.wanted) return "current";
  return target.overwrite ? "outdated" : "differs";
}

function targetsFor(repo: string, root: string): readonly Target[] {
  return [
    { label: GATE_RELATIVE, path: join(repo, GATE_RELATIVE), wanted: canonicalGate(), overwrite: true },
    { label: WORKFLOW_RELATIVE, path: join(repo, WORKFLOW_RELATIVE), wanted: workflowFor(repo, root), overwrite: false },
  ];
}

function write(target: Target, force: boolean): string {
  const status = statusOf(target);
  if (status === "current") return `${target.label}: already current`;
  if (status === "differs" && !force) return `${target.label}: differs from the template and was left alone (review it, or pass --force)`;
  mkdirSync(dirname(target.path), { recursive: true });
  writeFileSync(target.path, target.wanted);
  return `${target.label}: ${status === "missing" ? "installed" : "updated"}`;
}

function main(): number {
  const [repoArg, ...flags] = process.argv.slice(ARGV_START);
  if (repoArg === undefined) {
    console.log("usage: node scripts/install-gate.ts <repo> [--check] [--force]");
    return EXIT_USAGE;
  }
  const repo = resolve(repoArg);
  const root = pluginRoot(repo);
  if (root === undefined) {
    console.log(`${repo}: no .claude-plugin/plugin.json at the root or in ${SUBDIRECTORY}/`);
    return EXIT_USAGE;
  }
  console.log(`${repo}: plugin at ${root === "." ? "the repository root" : `${root}/`}`);
  const targets = targetsFor(repo, root);
  if (flags.includes("--check")) {
    const statuses = targets.map((target) => ({ target, status: statusOf(target) }));
    statuses.forEach(({ target, status }) => console.log(`${target.label}: ${status}`));
    return statuses.every(({ status }) => status === "current") ? 0 : 1;
  }
  targets.forEach((target) => console.log(write(target, flags.includes("--force"))));
  return 0;
}

process.exit(main());
