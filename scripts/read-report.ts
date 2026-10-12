#!/usr/bin/env node
// Reads a plugin-directory scan report and prints only what matters: which phases warned, each hold or
// blocking finding, the file the scanner named, and the files that sort before it and could be masking
// the next match. The full report is ~40k tokens; this is a screenful.
// Usage: node scripts/read-report.ts <report.json | ->   (the whole report, or just its diagnostics array)
// Exit status: 1 when a hold or a blocking finding is present, 0 otherwise.
import { readFileSync } from "node:fs";

interface Diagnostic {
  readonly ruleId?: string;
  readonly severity?: string;
  readonly path?: string;
  readonly message?: string;
  readonly params?: Readonly<Record<string, string>>;
  readonly hold?: boolean;
  readonly blocking?: boolean;
  readonly field?: string;
}

interface Phase {
  readonly name?: string;
  readonly outcome?: string;
}

interface InventoryFile {
  readonly path?: string;
  readonly kind?: string;
}

interface Parsed {
  readonly diagnostics: readonly Diagnostic[];
  readonly phases: readonly Phase[];
  readonly files: readonly string[];
}

const STDIN_FD = 0;
const ARGV_START = 2;
const EXIT_USAGE = 2;
const MESSAGE_CHARS = 170;
const MASK_LIST_LIMIT = 12;
const PAIRING_RULE = "MCP_FORWARDS_CREDENTIAL_ENV";
// Files the scanner reads as text; images are let through unread, so they cannot mask anything.
const READ_EXTENSIONS: readonly string[] = [".js", ".mjs", ".cjs", ".ts", ".tsx", ".sh", ".py", ".md", ".json", ".yml", ".yaml", ".html", ".txt"];

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => typeof value === "object" && value !== null && !Array.isArray(value);

// The array under `key` of a report object; a report that is itself an array is its own diagnostics.
function listIn(root: unknown, key: string): readonly unknown[] {
  if (Array.isArray(root)) return key === "diagnostics" ? root : [];
  const value = isRecord(root) ? root[key] : undefined;
  return Array.isArray(value) ? value : [];
}

function parseReport(text: string): Parsed {
  const raw: unknown = JSON.parse(text);
  const root = isRecord(raw) && isRecord(raw["report"]) ? raw["report"] : raw;
  const diagnostics = listIn(root, "diagnostics");
  const phases = listIn(root, "phases");
  const inventory = isRecord(root) && isRecord(root["inventory"]) ? root["inventory"] : {};
  const listed: readonly InventoryFile[] = Array.isArray(inventory["files"]) ? inventory["files"] : [];
  const files = listed.flatMap((file) => (file.kind === "file" && typeof file.path === "string" ? [file.path] : []));
  return { diagnostics: diagnostics as readonly Diagnostic[], phases: phases as readonly Phase[], files };
}

const isReadable = (path: string): boolean => READ_EXTENSIONS.some((extension) => path.toLowerCase().endsWith(extension));
const short = (text: string | undefined): string => (text ?? "").split("\n").map((line) => line.trim()).join(" ").slice(0, MESSAGE_CHARS);

function phaseLine(phases: readonly Phase[]): string {
  const cells = phases.map((phase) => `${phase.name ?? "?"}=${(phase.outcome ?? "?").replace("CHECK_", "")}`);
  return cells.length ? `phases: ${cells.join("  ")}` : "phases: (not in this paste)";
}

function describe(diagnostic: Diagnostic): readonly string[] {
  const kind = diagnostic.blocking ? "BLOCK" : "HOLD ";
  const head = `${kind} ${diagnostic.ruleId ?? "?"}  ${diagnostic.path ?? ""}`;
  const params = diagnostic.params ?? {};
  const pairing =
    diagnostic.ruleId === PAIRING_RULE && params["credential_at"] !== undefined
      ? [`       credential_at: ${params["credential_at"]}   sender_at: ${params["sender_at"] ?? "?"}   env: ${params["env"] ?? "?"}`]
      : [];
  return [head, `       ${short(diagnostic.message)}`, ...pairing];
}

// The scanner names only the first match in path order. Files that sort before it were clean at that point,
// but a file that sorts before it and was fixed since could have been hiding it, and the named file may be
// hiding later ones. List what sorts before so the fix covers every instance, not just the one named.
function maskingNotes(diagnostics: readonly Diagnostic[], files: readonly string[]): readonly string[] {
  const named = diagnostics.flatMap((d) => (d.params?.["credential_at"] !== undefined ? [d.params["credential_at"]] : []));
  if (named.length === 0) return [];
  if (files.length === 0) return ["masking: the file list is not in this paste, so earlier-sorting files cannot be listed"];
  const target = named[0] ?? "";
  const before = files.filter((file) => file < target && isReadable(file)).sort();
  return [
    `masking: the scanner names the first match in path order. ${before.length} readable file(s) sort before ${target}:`,
    ...before.slice(0, MASK_LIST_LIMIT).map((file) => `         ${file}`),
    before.length > MASK_LIST_LIMIT ? `         ... and ${before.length - MASK_LIST_LIMIT} more` : "",
    "         Fix every instance of the shape in every file in one pass; a match later in the order appears only once this one is gone.",
  ].filter((line) => line !== "");
}

function otherNotes(diagnostics: readonly Diagnostic[]): readonly string[] {
  const rest = diagnostics.filter((d) => !d.hold && !d.blocking);
  const counts = rest.reduce<Readonly<Record<string, number>>>((sum, d) => ({ ...sum, [d.ruleId ?? "?"]: (sum[d.ruleId ?? "?"] ?? 0) + 1 }), {});
  return Object.entries(counts).map(([rule, count]) => `note: ${rule} x${count} (warning or info, not a hold)`);
}

function report(text: string): { readonly lines: readonly string[]; readonly failed: boolean } {
  const { diagnostics, phases, files } = parseReport(text);
  const serious = diagnostics.filter((d) => d.hold || d.blocking);
  const summary = `${serious.filter((d) => d.blocking).length} blocking, ${serious.filter((d) => d.hold).length} hold(s), ${diagnostics.length - serious.length} other finding(s)`;
  const lines = [phaseLine(phases), summary, ...serious.flatMap(describe), ...maskingNotes(diagnostics, files), ...otherNotes(diagnostics)];
  return { lines: serious.length ? lines : [...lines, "clean: no holds and nothing blocking"], failed: serious.length > 0 };
}

function main(): number {
  const source = process.argv[ARGV_START];
  if (source === undefined) {
    console.log("usage: node scripts/read-report.ts <report.json | ->");
    return EXIT_USAGE;
  }
  const result = report(readFileSync(source === "-" ? STDIN_FD : source, "utf8"));
  result.lines.forEach((line) => console.log(line));
  return result.failed ? 1 : 0;
}

process.exit(main());
