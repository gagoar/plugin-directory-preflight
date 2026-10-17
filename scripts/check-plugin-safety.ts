#!/usr/bin/env node
// Plugin-directory upload gate. Fails when a plugin ships something the upload
// scanner holds for review:
//   1. a skill/agent/command pre-approves a write- or exec-capable tool with no path scope
//   2. shipped code copies the whole environment (every secret in it) instead of named variables
//   3. a native executable is committed (the scanner cannot read it)
//   4. any file is over 5 MiB (the plugin directory rejects it)
//   5. a script or document is over 256 KiB (the scanner reads only that much, then holds the plugin)
//   6. a shell command word that prints the environment sits on its own in a call or condition
//   7. a template placeholder names a credential (key, token, secret, ...)
//   8. a glob in a document covers an image or a font (the scanner reads the document as naming it)
//   9. a remote host and an environment reference sit in the same script (the scanner pairs them)
//  10. a script names an image or a font that exists in the repository (the scanner reads that as pointing at it)
//  11. the manifest does not declare a listing icon the directory can find: a PNG or JPEG, square, 512 to 2048 px,
//      up to 10 MiB, inside the plugin but outside .claude-plugin/
// Usage: node scripts/check-plugin-safety.ts [--no-icon] [plugin-root ...]   (default: .)
// --no-icon skips rule 11, for a throwaway plugin that is never listed (the probe from make-probe.ts).
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";

const SELF = "check-plugin-safety.ts";
const SKIP_DIRS: ReadonlySet<string> = new Set([".git", "node_modules"]);
const MAX_SCAN_BYTES = 67_108_864;
const MAX_FILE_BYTES = 5_242_880; // the directory's per-file limit: 5 MiB
const MAX_TEXT_BYTES = 262_144; // the scanner reads scripts and documents only up to 256 KiB
const BYTES_PER_MIB = 1_048_576;
const BYTES_PER_KIB = 1024;
// Images and fonts are let through unread, so the 256 KiB reading limit does not apply to them.
const MEDIA_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".otf"]);
const HEAD_CHARS = 200;
const SNIPPET_CHARS = 100;
const ARGV_ROOTS_START = 2; // argv[0] is node, argv[1] is this script
const NO_ICON_FLAG = "--no-icon";

// ---- rule 1: unscoped grants -------------------------------------------------

// Tools that change files or run commands. They must carry a scope: Tool(pattern).
const SCOPED_ONLY: ReadonlySet<string> = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]);
// Scopes that match everything are the same as no scope.
const BROAD: ReadonlySet<string> = new Set(["*", "**", "/**", "./**", "//**", "~/**", "**/*"]);
const FRONTMATTER_FIELDS: readonly string[] = ["allowed-tools", "allowed_tools", "tools"];
const FIELD_RE = new RegExp(`^(?:${FRONTMATTER_FIELDS.join("|")})\\s*:\\s*(.*)$`);
const LIST_ITEM_RE = /^\s+-\s+(.*)$/;

function frontmatter(text: string): readonly string[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  return match?.[1] === undefined ? [] : match[1].split(/\r?\n/);
}

const unquote = (s: string): string => s.trim().replace(/^['"]|['"]$/g, "");

interface SplitState {
  readonly parts: readonly string[];
  readonly current: string;
  readonly depth: number;
}

function splitStep(state: SplitState, ch: string): SplitState {
  if (ch === "(") return { ...state, current: state.current + ch, depth: state.depth + 1 };
  if (ch === ")") return { ...state, current: state.current + ch, depth: state.depth - 1 };
  if (ch === "," && state.depth === 0) return { parts: [...state.parts, state.current], current: "", depth: 0 };
  return { ...state, current: state.current + ch };
}

// Split on commas outside parentheses.
function splitTools(value: string): readonly string[] {
  const end = Array.from(value).reduce(splitStep, { parts: [], current: "", depth: 0 });
  return [...end.parts, end.current].map(unquote).filter((t) => t !== "");
}

function blockList(rest: readonly string[]): readonly string[] {
  const stop = rest.findIndex((l) => !LIST_ITEM_RE.test(l));
  const items = stop === -1 ? rest : rest.slice(0, stop);
  return items.map((l) => unquote(LIST_ITEM_RE.exec(l)?.[1] ?? ""));
}

function toolsOnLine(lines: readonly string[], index: number): readonly string[] {
  const m = FIELD_RE.exec(lines[index] ?? "");
  if (!m) return [];
  const value = (m[1] ?? "").trim().replace(/^\[|\]$/g, "");
  return value === "" ? blockList(lines.slice(index + 1)) : splitTools(value);
}

const toolsIn = (lines: readonly string[]): readonly string[] => lines.flatMap((_, i) => toolsOnLine(lines, i));

function grantProblem(tool: string): string | undefined {
  const m = /^([A-Za-z_*]+)(?:\((.*)\))?$/.exec(tool);
  if (!m) return undefined;
  const name = m[1] ?? "";
  const scope = m[2];
  if (name === "*") return "wildcard grants every tool";
  if (!SCOPED_ONLY.has(name)) return undefined;
  if (scope === undefined || scope.trim() === "") return `${name} has no path scope; use ${name}(./path/**)`;
  return BROAD.has(scope.trim()) ? `${name}(${scope}) matches everything; narrow the scope` : undefined;
}

// ---- rule 2: whole-environment forwarding -----------------------------------

// Reading one named variable (process.env.COLUMNS) is fine. Copying or listing
// the whole environment hands every secret in it to the code. Test files and comments are read too:
// the scanner held a plugin for a spread written in a test comment.
const ENV_PATTERNS: readonly { readonly re: RegExp; readonly why: string }[] = [
  { re: /\.\.\.\s*process\.env\b(?!\s*\.|\s*\[)/, why: "spreads the whole environment" },
  { re: /Object\.(?:keys|entries|values)\(\s*process\.env\s*\)/, why: "enumerates the whole environment" },
  { re: /Object\.assign\([^)]*\bprocess\.env\s*[,)]/, why: "copies the whole environment" },
  { re: /\benv\s*:\s*process\.env\s*[,}\n]/, why: "passes the whole environment to a child process" },
];
const CODE_EXTS: ReadonlySet<string> = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".mts", ".cts"]);
const NODE_SHEBANG = /^#!.*\bnode\b/;

function isShippedCode(path: string, head: string): boolean {
  if (basename(path) === SELF) return false;
  const ext = extname(path).toLowerCase();
  return CODE_EXTS.has(ext) || (ext === "" && NODE_SHEBANG.test(head));
}

function envProblems(path: string): readonly string[] {
  const text = statSync(path).size > MAX_SCAN_BYTES ? "" : readFileSync(path, "utf8");
  if (!isShippedCode(path, text.slice(0, HEAD_CHARS))) return [];
  return text.split(/\r?\n/).flatMap((line, i) =>
    ENV_PATTERNS.filter(({ re }) => re.test(line)).map(
      ({ why }) => `line ${i + 1} ${why}: ${line.trim().slice(0, SNIPPET_CHARS)}`,
    ),
  );
}

// ---- rules 6 and 7: shapes the scanner reads as a credential lookup ----------

// The scanner splits a line on parentheses, braces and the shell's separators (a single pipe included), and
// reads a segment that is one command word as that command run with no arguments. A list of plain English
// words joined with pipes can trip it, because one of the words is a command word. A bare declare, set or export prints
// the whole environment, so a call or a condition holding just such a word is held as a read of the
// installer's environment, whether it sits in code, in a comment or in a document.
// The two names that only dump the environment are joined from halves, so this file does not list them.
const ENV_DUMPERS: readonly string[] = [["en", "v"].join(""), ["print", "env"].join("")];
const COMMAND_WORDS: readonly string[] = ["declare", "export", "set", "typeset", "unset", ...ENV_DUMPERS];
// Matches a segment that is one command word, right after "(", "{", "|" or at a statement start; rejects a word given arguments or part of a longer name.
const LONE_COMMAND_RE = new RegExp(
  `(?:[({|]|^|;|&&|\\|\\|)\\s*["'\`]?(?:${COMMAND_WORDS.join("|")})["'\`]?\\s*(?:[)}|]|&&|\\|\\||;|$)`,
);

// A template placeholder whose expression names a credential reads as a credential lookup, however
// harmless the expression around the name is.
const LOOKUP_WORDS: readonly string[] = [
  "key",
  "keys",
  "token",
  "tokens",
  "secret",
  "secrets",
  "password",
  "passwd",
  "pass",
  "auth",
  "apikey",
  "credential",
  "credentials",
  "cookie",
  "session",
];
// Matches a placeholder with a credential word inside it; rejects one with an ordinary name such as "name" or "githubToken" (one word, no boundary).
const LOOKUP_PLACEHOLDER_RE = new RegExp(`\\$\\{[^}]*\\b(?:${LOOKUP_WORDS.join("|")})\\b[^}]*\\}`, "i");

const WORKFLOW_DIR = ".github"; // not part of what the scanner reads
const LOCKFILE = "package-lock.json"; // hashes, not code

const isOutsideRules = (root: string, path: string): boolean =>
  basename(path) === LOCKFILE || relative(root, path).startsWith(WORKFLOW_DIR);

// Images and fonts are let through unread, so they have no text to match.
function readableText(path: string): string {
  if (MEDIA_EXTENSIONS.has(extname(path).toLowerCase())) return "";
  return statSync(path).size > MAX_SCAN_BYTES ? "" : readFileSync(path, "utf8");
}

function lineProblems(path: string, re: RegExp, why: string): readonly string[] {
  return readableText(path)
    .split("\n")
    .flatMap((line, i) => (re.test(line) ? [`line ${i + 1} ${why}: ${line.trim().slice(0, SNIPPET_CHARS)}`] : []));
}

// Rule 8. A glob in a document that covers an image or a font reads as the document naming that file.
// The scanner lets images through unread, then holds a document that names one.
const DEEP_GLOB = "**";
const CURRENT_DIR_PREFIX = "./";
// Matches the characters that end a path in prose; "a/** b" splits at the space and "(a/**)" at the parentheses.
const GLOB_SEPARATORS = /[\s"'`()[\],;]+/;

// Only a glob with a directory before a whole "**" segment ("dir/**", "dir/**/*.png") is checked: the part
// before it must be a prefix of the image's path, and the part after it must be its ending. A bare "**"
// (Markdown bold, or a broad grant) names no directory and is left alone.
const DEEP_SEGMENT = "/**";

function deepGlobCovers(glob: string, mediaPath: string): boolean {
  const bare = glob.startsWith(CURRENT_DIR_PREFIX) ? glob.slice(CURRENT_DIR_PREFIX.length) : glob;
  const at = bare.indexOf(DEEP_SEGMENT);
  const after = at === -1 ? "" : bare.slice(at + DEEP_SEGMENT.length);
  if (at <= 0 || (after !== "" && !after.startsWith("/"))) return false;
  return mediaPath.startsWith(bare.slice(0, at + 1)) && mediaPath.endsWith(after.split("*").at(-1) ?? "");
}

function imageGlobProblems(path: string, mediaPaths: readonly string[]): readonly string[] {
  if (mediaPaths.length === 0) return [];
  return readableText(path)
    .split("\n")
    .flatMap((line, i) =>
      line
        .split(GLOB_SEPARATORS)
        .filter((piece) => piece.includes(DEEP_GLOB))
        .flatMap((piece) => {
          const covered = mediaPaths.filter((media) => deepGlobCovers(piece, media));
          return covered.length
            ? [`line ${i + 1} has the glob ${piece}, which covers ${covered.length} image or font file(s), such as ${covered[0]}; the scanner reads that as this file naming them`]
            : [];
        }),
    );
}

// Rule 10. A script that names an image or a font that exists in the repository is read as pointing at it.
// The scanner lets the image through unread, then holds the script. Documents and pages naming an image are
// not held, so only scripts are checked.
const SCRIPT_EXTS: ReadonlySet<string> = new Set([...CODE_EXTS, ".sh", ".py"]);
// A character that has a meaning inside a regex. Matches the dot in "logo.png"; rejects the letter "l".
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;
// A file name that stands on its own. Matches "logo.png" in "see logo.png"; rejects "o.png" inside "logo.png".
const nameRe = (name: string): RegExp => new RegExp(`(?<![\\w.-])${name.replace(REGEX_SPECIALS, "\\$&")}`);

function mediaNameProblems(path: string, mediaPaths: readonly string[]): readonly string[] {
  if (!SCRIPT_EXTS.has(extname(path).toLowerCase())) return [];
  const text = readableText(path);
  const names = [...new Set(mediaPaths.map((media) => basename(media)))].filter((name) => nameRe(name).test(text));
  return names.length
    ? [`names the image or font ${names.join(", ")}; the scanner reads a script that names one as pointing at a file it let through unread. Use a name that no file in the repository has`]
    : [];
}

// Rule 9. A remote host and an environment reference in one script are held as a credential that can leave
// the machine, however unrelated they are.
const ENV_REFERENCES: readonly string[] = ["process.env", "os.environ", "getenv(", "Deno.env"];
// Matches a URL with a host; rejects a bare scheme such as "https://" and the escaped text of this pattern.
const HOST_RE = /https?:\/\/[A-Za-z0-9.-]+\.[a-z]{2,}/;

// Only scripts pair: a Markdown file with a tester link and an environment word passed the scan, so the
// links can live in a document.
function hostPairingProblems(path: string, text: string): readonly string[] {
  if (!SCRIPT_EXTS.has(extname(path).toLowerCase())) return [];
  const host = HOST_RE.exec(text)?.[0];
  const reference = ENV_REFERENCES.find((candidate) => text.includes(candidate));
  return host !== undefined && reference !== undefined
    ? [`has the remote host ${host} and the environment reference ${reference} in the same script; the scanner pairs them as a credential that can leave the machine. Move the link into a Markdown document`]
    : [];
}

function scannerShapeProblems(root: string, path: string, mediaPaths: readonly string[]): readonly string[] {
  if (isOutsideRules(root, path)) return [];
  return [
    ...lineProblems(path, LONE_COMMAND_RE, "has a command word on its own, which the scanner reads as a command that prints the environment"),
    ...lineProblems(path, LOOKUP_PLACEHOLDER_RE, "has a template placeholder that names a credential, which the scanner reads as a credential lookup"),
    ...imageGlobProblems(path, mediaPaths),
    ...mediaNameProblems(path, mediaPaths),
    ...hostPairingProblems(path, readableText(path)),
  ];
}

// ---- rule 3: native executables ---------------------------------------------

const HEADER_BYTES = 0x40;
const MAGIC_BYTES = 4;
const ELF_MAGIC = 0x7f454c46;
const MACHO_32 = 0xfeedface;
const MACHO_64 = 0xfeedfacf;
const MACHO_32_SWAPPED = 0xcefaedfe;
const MACHO_64_SWAPPED = 0xcffaedfe;
const MACHO_MAGICS: ReadonlySet<number> = new Set([MACHO_32, MACHO_64, MACHO_32_SWAPPED, MACHO_64_SWAPPED]);
const FAT_MACHO_MAGIC = 0xcafebabe; // also the magic of a Java .class, which is small
const JAVA_CLASS_MAX_BYTES = 4096;
const DOS_MAGIC = 0x4d5a;
const PE_OFFSET_FIELD = 0x3c;
const PE_SIGNATURE = "PE\0\0";

function readBytes(path: string, length: number, position: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    return buf.subarray(0, readSync(fd, buf, 0, length, position));
  } finally {
    closeSync(fd);
  }
}

function isPortableExecutable(path: string, head: Buffer): boolean {
  if (head.length < HEADER_BYTES || head.readUInt16BE(0) !== DOS_MAGIC) return false;
  const sig = readBytes(path, MAGIC_BYTES, head.readUInt32LE(PE_OFFSET_FIELD));
  return sig.toString("latin1") === PE_SIGNATURE;
}

function nativeKind(path: string): string | undefined {
  const head = readBytes(path, HEADER_BYTES, 0);
  if (head.length < MAGIC_BYTES) return undefined;
  const magic = head.readUInt32BE(0);
  if (magic === ELF_MAGIC) return "ELF executable";
  if (MACHO_MAGICS.has(magic)) return "Mach-O executable";
  if (magic === FAT_MACHO_MAGIC && statSync(path).size > JAVA_CLASS_MAX_BYTES) return "Mach-O universal binary";
  return isPortableExecutable(path, head) ? "Windows PE executable" : undefined;
}

// ---- rule 11: the listing icon ----------------------------------------------

// The directory reads the icon field of the manifest for the listing. The image must sit inside the plugin, and
// .claude-plugin/ holds manifests only: an image kept there is not found and the listing shows a letter.
const MANIFEST_DIR = ".claude-plugin";
const MANIFEST_FILE = "plugin.json";
const PLUGIN_SUBDIRECTORY = "plugin"; // the marketplace may install from a plugin/ subdirectory
const ICON_EXTENSIONS: ReadonlySet<string> = new Set([".png", ".jpg", ".jpeg"]);
// Spelled in parts: a script that names an image file the repository holds is held.
const ICON_EXAMPLE = ["./ic", "on.png"].join("");
const ICON_MIN_PX = 512;
const ICON_MAX_PX = 2048;
const ICON_MAX_MIB = 10;
const ICON_MAX_BYTES = ICON_MAX_MIB * BYTES_PER_MIB;
const PNG_SIGNATURE = "89504e470d0a1a0a";
const PNG_SIGNATURE_BYTES = 8;
const PNG_WIDTH_OFFSET = 16; // after the signature, the chunk length and the IHDR tag
const PNG_HEIGHT_OFFSET = 20;
const PNG_MIN_BYTES = 24;
const JPEG_START = 0xffd8;
const JPEG_MARKER_PREFIX = 0xff;
const JPEG_FIRST_FRAME = 0xc0;
const JPEG_LAST_FRAME = 0xcf;
const JPEG_HUFFMAN_TABLE = 0xc4;
const JPEG_RESERVED = 0xc8;
const JPEG_ARITHMETIC_TABLE = 0xcc;
const JPEG_NOT_FRAME: ReadonlySet<number> = new Set([JPEG_HUFFMAN_TABLE, JPEG_RESERVED, JPEG_ARITHMETIC_TABLE]); // these share the range but hold no size
// Splits a path into its parts. Splits "docs/a.png" and "docs\a.png" at the slash; leaves "a.png" whole.
const PATH_SEPARATOR = /[\\/]/;
const JPEG_START_BYTES = 2;
const JPEG_FRAME_BYTES = 9; // marker, length, precision, height, width
const JPEG_HEIGHT_OFFSET = 5;
const JPEG_WIDTH_OFFSET = 7;

interface Dimensions {
  readonly width: number;
  readonly height: number;
}

function pngSize(bytes: Buffer): Dimensions | undefined {
  if (bytes.length < PNG_MIN_BYTES || bytes.subarray(0, PNG_SIGNATURE_BYTES).toString("hex") !== PNG_SIGNATURE) return undefined;
  return { width: bytes.readUInt32BE(PNG_WIDTH_OFFSET), height: bytes.readUInt32BE(PNG_HEIGHT_OFFSET) };
}

const isFrameMarker = (marker: number): boolean => marker >= JPEG_FIRST_FRAME && marker <= JPEG_LAST_FRAME && !JPEG_NOT_FRAME.has(marker);

// Walks the segments from `at` until the frame header, which holds the size.
function jpegFrame(bytes: Buffer, at: number): Dimensions | undefined {
  if (at + JPEG_FRAME_BYTES > bytes.length || bytes[at] !== JPEG_MARKER_PREFIX) return undefined;
  if (isFrameMarker(bytes[at + 1] ?? 0)) {
    return { width: bytes.readUInt16BE(at + JPEG_WIDTH_OFFSET), height: bytes.readUInt16BE(at + JPEG_HEIGHT_OFFSET) };
  }
  return jpegFrame(bytes, at + JPEG_START_BYTES + bytes.readUInt16BE(at + JPEG_START_BYTES));
}

function jpegSize(bytes: Buffer): Dimensions | undefined {
  return bytes.length > JPEG_START_BYTES && bytes.readUInt16BE(0) === JPEG_START ? jpegFrame(bytes, JPEG_START_BYTES) : undefined;
}

function iconFileProblems(file: string, ext: string): readonly string[] {
  const size = statSync(file).size;
  if (size > ICON_MAX_BYTES) return [`the icon is ${(size / BYTES_PER_MIB).toFixed(1)} MiB; the directory takes up to ${ICON_MAX_MIB} MiB`];
  const bytes = readFileSync(file);
  const dimensions = ext === ".png" ? pngSize(bytes) : jpegSize(bytes);
  if (dimensions === undefined) return [`the icon is not a readable ${ext === ".png" ? "PNG" : "JPEG"} image`];
  if (dimensions.width !== dimensions.height) return [`the icon is ${dimensions.width}x${dimensions.height} px; it must be square`];
  const side = dimensions.width;
  return side < ICON_MIN_PX || side > ICON_MAX_PX ? [`the icon is ${side} px on each side; use ${ICON_MIN_PX} to ${ICON_MAX_PX} px`] : [];
}

function iconPathProblems(base: string, icon: unknown): readonly string[] {
  if (typeof icon !== "string" || icon === "") {
    return [`has no icon field; the directory reads it for the listing icon. Add "icon": "${ICON_EXAMPLE}" and keep the image at the plugin root`];
  }
  const target = resolve(base, icon);
  const inside = relative(base, target);
  if (!icon.startsWith(CURRENT_DIR_PREFIX) || inside.startsWith("..")) return [`icon "${icon}" must be a path inside the plugin that starts with ${CURRENT_DIR_PREFIX}`];
  if (inside.split(PATH_SEPARATOR)[0] === MANIFEST_DIR) {
    return [`icon "${icon}" is inside ${MANIFEST_DIR}/, which holds manifests only; the listing does not find it there. Move it to the plugin root`];
  }
  if (!existsSync(target) || !statSync(target).isFile()) return [`icon "${icon}" does not exist`];
  const ext = extname(target).toLowerCase();
  return ICON_EXTENSIONS.has(ext) ? iconFileProblems(target, ext) : [`icon "${icon}" must be a PNG or JPEG file`];
}

function readManifest(path: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined; // a manifest that does not parse is reported by claude plugin validate
  }
}

function iconLines(root: string): readonly string[] {
  return [root, join(root, PLUGIN_SUBDIRECTORY)]
    .map((base) => ({ base, manifest: join(base, MANIFEST_DIR, MANIFEST_FILE) }))
    .filter(({ manifest }) => existsSync(manifest))
    .flatMap(({ base, manifest }) => {
      const data = readManifest(manifest);
      return data === undefined ? [] : iconPathProblems(base, data["icon"]).map((p) => `FAIL ${relative(root, manifest)}: ${p}`);
    });
}

// ---- walk and report --------------------------------------------------------

function expand(dir: string, entry: Dirent): readonly string[] {
  const p = join(dir, entry.name);
  if (entry.isDirectory()) return walk(p);
  return entry.isFile() ? [p] : [];
}

function walk(dir: string): readonly string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => !SKIP_DIRS.has(e.name))
    .flatMap((e) => expand(dir, e));
}

function isGrantFile(root: string, path: string): boolean {
  if (!path.endsWith(".md")) return false;
  const dirs = relative(root, path).split(/[\\/]/);
  return basename(path) === "SKILL.md" || dirs.includes("agents") || dirs.includes("commands");
}

function grantProblems(root: string, path: string): readonly string[] {
  if (!isGrantFile(root, path)) return [];
  return toolsIn(frontmatter(readFileSync(path, "utf8"))).flatMap((tool) => {
    const why = grantProblem(tool);
    return why === undefined ? [] : [`${tool}: ${why}`];
  });
}

function sizeProblems(path: string): readonly string[] {
  const size = statSync(path).size;
  if (size > MAX_FILE_BYTES) {
    return [`${(size / BYTES_PER_MIB).toFixed(1)} MiB; the plugin directory rejects any file over 5 MiB. Shrink it, or fetch it at run time`];
  }
  if (size >= MAX_TEXT_BYTES && !MEDIA_EXTENSIONS.has(extname(path).toLowerCase())) {
    return [`${Math.round(size / BYTES_PER_KIB)} KiB; the scanner reads scripts and documents only up to 256 KiB and holds the plugin for review beyond that. Split it into smaller files`];
  }
  return [];
}

function fileProblems(root: string, path: string, mediaPaths: readonly string[]): readonly string[] {
  const grants = [...grantProblems(root, path), ...sizeProblems(path)];
  const kind = nativeKind(path);
  if (kind !== undefined) {
    return [...grants, `${kind} committed; the scanner cannot read it. Ship source and fetch a pinned build instead`];
  }
  return [...grants, ...envProblems(path), ...scannerShapeProblems(root, path, mediaPaths)];
}

function checkRoot(root: string, listed: boolean): number {
  const files = walk(root);
  const mediaPaths = files.filter((f) => MEDIA_EXTENSIONS.has(extname(f).toLowerCase())).map((f) => relative(root, f));
  const lines = [...files.flatMap((f) => fileProblems(root, f, mediaPaths).map((p) => `FAIL ${relative(root, f)}: ${p}`)), ...(listed ? iconLines(root) : [])];
  lines.forEach((l) => console.log(l));
  console.log(`${root}: checked ${files.length} files, ${lines.length} problem(s)`);
  return lines.length;
}

function checkTarget(root: string, listed: boolean): number {
  if (existsSync(root)) return checkRoot(root, listed);
  console.log(`FAIL ${root}: no such directory`);
  return 1;
}

function main(): number {
  const args = process.argv.slice(ARGV_ROOTS_START);
  const listed = !args.includes(NO_ICON_FLAG);
  const roots = args.filter((arg) => arg !== NO_ICON_FLAG).map((r) => resolve(r));
  const targets = roots.length > 0 ? roots : [resolve(".")];
  const failures = targets.map((root) => checkTarget(root, listed)).reduce((a, b) => a + b, 0);
  return failures > 0 ? 1 : 0;
}

process.exit(main());
