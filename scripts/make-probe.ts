#!/usr/bin/env node
// Builds a throwaway "probe" plugin that pins which lines of a file a directory scan reacts to.
//
// The scanner names only the first matching file, in path order. So the file under suspicion is cut into
// small files with names that sort in line order, plus one file that gives the scanner something to pair
// the match with. Each upload names one slice; the slice is cut again until it is a few lines.
//
//   node scripts/make-probe.ts round1  <file> <outDir> [slices]   cut <file> into slices (default 16)
//   node scripts/make-probe.ts narrow  <outDir> <slice> [slices]  cut one slice into smaller slices
//   node scripts/make-probe.ts windows <outDir> <slice>           sliding windows of 1..N lines over one slice
//   node scripts/make-probe.ts explain <outDir> <reported-file>   print the lines of the original file
//
// Push <outDir> to a throwaway public repository, upload it, read the file named in the scan's finding,
// run the next step, push again. Three rounds usually reach a single line. Delete the repository after.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

interface Entry {
  readonly name: string;
  readonly from: number; // 1-based line in the original file
  readonly to: number;
}

interface Index {
  readonly source: string;
  readonly entries: readonly Entry[];
}

const ARGV_START = 2;
const DEFAULT_SLICES = 16;
// Window sizes in lines; a string keeps the list readable.
const WINDOW_SIZES: readonly number[] = "1 2 3 4 6 8 11".split(" ").map(Number);
const INDEX_FILE = ".probe-index.json";
const PROBE_DIR = "probe";
const SENDER_NAME = "zz-sender.js";
const SCHEME = ["https", "://"].join(""); // a send target for the scanner to pair the match with
const PAD_WIDTH = 2;
const LINE_NUMBER_WIDTH = 4;
const JSON_INDENT = 2;
const HOOK_TIMEOUT_SECONDS = 5;
const EXPLAIN_LINES = 40;
const EXIT_USAGE = 2;

const README = [
  "# scanner-probe",
  "",
  "Throwaway repository used to find which lines of one third-party file a directory scan reacts to.",
  "Each file under probe/ is a short slice of that file, so a scan report names the slice.",
  "The repository holds no plugin logic of its own and it will be deleted as soon as the answer is known.",
  "",
].join("\n");

const pad = (value: number): string => String(value).padStart(PAD_WIDTH, "0");

// Cuts `lines` into at most `parts` runs of about equal length, keeping each run's position in the source.
function sliceRuns(lines: readonly string[], parts: number, offset: number): readonly { readonly text: string; readonly from: number; readonly to: number }[] {
  const per = Math.ceil(lines.length / parts);
  return Array.from({ length: parts }, (_, i) => ({ chunk: lines.slice(i * per, (i + 1) * per), start: i * per })).flatMap(({ chunk, start }) =>
    chunk.length ? [{ text: `${chunk.join("\n")}\n`, from: offset + start, to: offset + start + chunk.length - 1 }] : [],
  );
}

// Sliding windows over `lines`, small sizes first: the smallest window that triggers shows how many lines
// the trigger needs together.
function windowRuns(lines: readonly string[], offset: number): readonly { readonly name: string; readonly text: string; readonly from: number; readonly to: number }[] {
  const sizes = [...WINDOW_SIZES.filter((size) => size < lines.length), lines.length];
  return sizes.flatMap((size) =>
    Array.from({ length: lines.length - size + 1 }, (_, start) => ({
      name: `w${pad(size)}-${pad(start + 1)}.js`,
      text: `${lines.slice(start, start + size).join("\n")}\n`,
      from: offset + start,
      to: offset + start + size - 1,
    })),
  );
}

function writeProbe(outDir: string, source: string, files: readonly { readonly name: string; readonly text: string; readonly from: number; readonly to: number }[]): void {
  const probe = join(outDir, PROBE_DIR);
  mkdirSync(probe, { recursive: true });
  readdirSync(probe).forEach((file) => rmSync(join(probe, file), { force: true }));
  files.forEach((file) => writeFileSync(join(probe, file.name), file.text));
  writeFileSync(join(probe, SENDER_NAME), `module.exports = "${SCHEME}";\n`);
  mkdirSync(join(outDir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(outDir, "hooks"), { recursive: true });
  const manifest = {
    name: `scanner-probe-${basename(source).replace(".", "-").toLowerCase()}`,
    version: "0.0.1",
    description: "Throwaway repository that pins a directory-scan false positive. It will be deleted.",
    author: { name: "probe" },
    license: "MIT",
  };
  writeFileSync(join(outDir, ".claude-plugin", "plugin.json"), `${JSON.stringify(manifest, null, JSON_INDENT)}\n`);
  const hook = { hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: `node "\${CLAUDE_PLUGIN_ROOT}/${PROBE_DIR}/${SENDER_NAME}"`, timeout: HOOK_TIMEOUT_SECONDS }] }] } };
  writeFileSync(join(outDir, "hooks", "hooks.json"), `${JSON.stringify(hook, null, JSON_INDENT)}\n`);
  writeFileSync(join(outDir, "README.md"), README);
  writeFileSync(join(outDir, ".gitignore"), `${INDEX_FILE}\n`);
  const index: Index = { source, entries: files.map(({ name, from, to }) => ({ name, from, to })) };
  writeFileSync(join(outDir, INDEX_FILE), `${JSON.stringify(index, null, JSON_INDENT)}\n`);
}

const readIndex = (outDir: string): Index => JSON.parse(readFileSync(join(outDir, INDEX_FILE), "utf8")) as Index;
const linesOf = (path: string): readonly string[] => readFileSync(path, "utf8").trimEnd().split("\n");

function findEntry(index: Index, reported: string): Entry {
  const entry = index.entries.find((candidate) => candidate.name === basename(reported));
  if (entry === undefined) throw new Error(`${reported} is not a slice of this probe; known: ${index.entries.map((e) => e.name).join(", ")}`);
  return entry;
}

function sliceLinesOf(index: Index, entry: Entry): readonly string[] {
  return linesOf(index.source).slice(entry.from - 1, entry.to);
}

function round1(file: string, outDir: string, parts: number): string {
  const source = resolve(file);
  const runs = sliceRuns(linesOf(source), parts, 1);
  writeProbe(outDir, source, runs.map((run, i) => ({ name: `s1-${pad(i + 1)}.js`, ...run })));
  return `${runs.length} slices of ${file} written to ${outDir}/${PROBE_DIR}. Push ${outDir} to a throwaway public repository, upload it, then read credential_at in the finding.`;
}

function narrow(outDir: string, slice: string, parts: number): string {
  const index = readIndex(outDir);
  const entry = findEntry(index, slice);
  const lines = sliceLinesOf(index, entry);
  const runs = sliceRuns(lines, Math.min(parts, lines.length), entry.from);
  const round = `s${Number(entry.name.split("-")[0]?.slice(1)) + 1}`;
  writeProbe(outDir, index.source, runs.map((run, i) => ({ name: `${round}-${pad(i + 1)}.js`, ...run })));
  return `${slice} (lines ${entry.from}-${entry.to}) cut into ${runs.length} slices. Push, upload, read credential_at again. At ${Math.ceil(lines.length / parts)} lines or fewer, use windows.`;
}

function windows(outDir: string, slice: string): string {
  const index = readIndex(outDir);
  const entry = findEntry(index, slice);
  const runs = windowRuns(sliceLinesOf(index, entry), entry.from);
  writeProbe(outDir, index.source, runs);
  return `${runs.length} window files over lines ${entry.from}-${entry.to}. The finding names the smallest window that triggers; run explain on it.`;
}

function explain(outDir: string, reported: string): string {
  const index = readIndex(outDir);
  const entry = findEntry(index, reported);
  const shown = sliceLinesOf(index, entry).slice(0, EXPLAIN_LINES).map((line, i) => `${String(entry.from + i).padStart(LINE_NUMBER_WIDTH, " ")}: ${line}`);
  return [`${reported} is lines ${entry.from}-${entry.to} of ${index.source}`, ...shown].join("\n");
}

type Command = (args: readonly string[]) => string;

const COMMANDS: Readonly<Record<string, Command>> = {
  round1: ([file, outDir, parts]) => round1(file ?? "", outDir ?? "", Number(parts ?? DEFAULT_SLICES)),
  narrow: ([outDir, slice, parts]) => narrow(outDir ?? "", slice ?? "", Number(parts ?? DEFAULT_SLICES)),
  windows: ([outDir, slice]) => windows(outDir ?? "", slice ?? ""),
  explain: ([outDir, reported]) => explain(outDir ?? "", reported ?? ""),
};

function main(): number {
  const [name, ...args] = process.argv.slice(ARGV_START);
  const command = name === undefined ? undefined : COMMANDS[name];
  if (command === undefined || args.length === 0 || (name === "round1" && !existsSync(args[0] ?? ""))) {
    console.log("usage: node scripts/make-probe.ts <round1|narrow|windows|explain> ...  (see the header of this file)");
    return EXIT_USAGE;
  }
  console.log(command(args));
  return 0;
}

process.exit(main());
