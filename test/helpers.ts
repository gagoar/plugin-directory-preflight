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

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const PNG_CHUNK_BYTES = 13; // the length of an IHDR chunk body
const PNG_HEAD_BYTES = 8; // the chunk length and the IHDR tag
const PNG_HEIGHT_AT = 4;
const PNG_TAG_AT = 4;
const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_FRAME_MARKER = 0xffc0;
const JPEG_FRAME_LENGTH = 11; // a frame header with one component
const JPEG_MARKER_BYTES = 2;
const JPEG_FRAME_BYTES = JPEG_FRAME_LENGTH + JPEG_MARKER_BYTES;
const JPEG_PRECISION_AT = 4;
const JPEG_HEIGHT_AT = 5;
const JPEG_WIDTH_AT = 7;
const BITS_PER_SAMPLE = 8;
const BYTES_PER_MIB = 1_048_576;
const ICON_LIMIT_MIB = 10;

// The smallest PNG header the gate can read: the signature, then an IHDR chunk that holds the size.
export function png(width: number, height: number, padding = 0): Buffer {
  const chunk = Buffer.alloc(PNG_CHUNK_BYTES + padding);
  chunk.writeUInt32BE(width, 0);
  chunk.writeUInt32BE(height, PNG_HEIGHT_AT);
  const head = Buffer.alloc(PNG_HEAD_BYTES);
  head.writeUInt32BE(PNG_CHUNK_BYTES, 0);
  head.write("IHDR", PNG_TAG_AT, "ascii");
  return Buffer.concat([PNG_SIGNATURE, head, chunk]);
}

// The smallest JPEG the gate can read: a start marker, then a baseline frame header that holds the size.
export function jpeg(width: number, height: number): Buffer {
  const frame = Buffer.alloc(JPEG_FRAME_BYTES);
  frame.writeUInt16BE(JPEG_FRAME_MARKER, 0);
  frame.writeUInt16BE(JPEG_FRAME_LENGTH, JPEG_MARKER_BYTES);
  frame.writeUInt8(BITS_PER_SAMPLE, JPEG_PRECISION_AT);
  frame.writeUInt16BE(height, JPEG_HEIGHT_AT);
  frame.writeUInt16BE(width, JPEG_WIDTH_AT);
  return Buffer.concat([JPEG_START, frame]);
}

// Bytes of padding that push a PNG one byte past the icon size limit.
export const OVER_ICON_LIMIT = ICON_LIMIT_MIB * BYTES_PER_MIB + 1;

// Writes `files` (relative path -> text or bytes) into a fresh temporary directory and returns it.
export function tree(files: Readonly<Record<string, string | Buffer>>): string {
  const root = mkdtempSync(join(tmpdir(), "preflight-"));
  Object.entries(files).forEach(([path, text]) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  });
  return root;
}
