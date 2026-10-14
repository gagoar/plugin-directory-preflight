import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMAND_WORD, DEEP_GLOB, ENV_WORD, IMAGE_NAME, LONGER_NAME, PLACEHOLDER, SCHEME, SHORT_NAME, run, tree } from "./helpers.ts";

const KIB = 1024;
const BIG_FILE_KIB = 300;
const ELF_HEAD = "\x7fELF";

interface Case {
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly fails: boolean;
  readonly mentions?: string;
}

const CASES: readonly Case[] = [
  { name: "a command word alone in a call", files: { "a.js": `run("${COMMAND_WORD}");\n` }, fails: true, mentions: "command word on its own" },
  { name: "a command word alone in a condition", files: { "a.js": `if (${COMMAND_WORD} && ok) {}\n` }, fails: true, mentions: "command word on its own" },
  { name: "a command word given arguments", files: { "a.js": `run("${COMMAND_WORD}", 1);\nconst is${COMMAND_WORD} = 1;\n` }, fails: false },
  { name: "the same shape in a comment", files: { "a.js": `// run("${COMMAND_WORD}");\n` }, fails: true, mentions: "command word on its own" },
  { name: "the same shape in a document", files: { "README.md": `Call run(${COMMAND_WORD}) here.\n` }, fails: true },
  { name: "a placeholder naming a credential", files: { "a.js": `const a = \`${PLACEHOLDER}\`;\n` }, fails: true, mentions: "names a credential" },
  { name: "a placeholder with an ordinary name", files: { "a.js": "const a = `${name}`;\n" }, fails: false },
  {
    name: "a document glob that covers an image",
    files: { "README.md": `Write(./docs/${DEEP_GLOB})\n`, "docs/assets/a.png": "x" },
    fails: true,
    mentions: "covers 1 image",
  },
  { name: "a document glob with no image under it", files: { "README.md": `Write(./src/${DEEP_GLOB})\n`, "docs/assets/a.png": "x" }, fails: false },
  { name: "Markdown bold is not a glob", files: { "README.md": `Use ${DEEP_GLOB}care${DEEP_GLOB} here.\n`, "docs/assets/a.png": "x" }, fails: false },
  { name: "a bare broad glob names no directory", files: { "a.js": `grant("./${DEEP_GLOB}");\n`, "docs/assets/a.png": "x" }, fails: false },
  { name: "a host and an environment reference in one file", files: { "a.js": `${ENV_WORD};\n// ${SCHEME}example.com/a\n` }, fails: true, mentions: "remote host" },
  // Learned getting one plugin through the scan: a list of plain words joined with pipes read as a shell pipeline.
  { name: "a command word between pipes in a word list", files: { "a.js": `const words = "sent|${COMMAND_WORD}|run|read";\n` }, fails: true, mentions: "command word on its own" },
  { name: "a command word at the end of a pipe list", files: { "a.js": `const words = "given|taken|${COMMAND_WORD}";\n` }, fails: true, mentions: "command word on its own" },
  { name: "a pipe list with no command word", files: { "a.js": 'const words = "given|taken|made";\n' }, fails: false },
  // The scan reads test files and comments too.
  { name: "a whole-environment spread in a test file", files: { "a.test.js": `const e = { ...${ENV_WORD} };\n` }, fails: true, mentions: "spreads the whole environment" },
  { name: "a whole-environment spread in a comment", files: { "a.js": `// a copy such as { ...${ENV_WORD} } is held\n` }, fails: true, mentions: "spreads the whole environment" },
  { name: "a named environment read in a test file", files: { "a.test.js": `const e = ${ENV_WORD}["PATH"];\n` }, fails: false },
  // A script that names an image the repository holds is read as pointing at it; a document is not.
  {
    name: "a script that names an image in the repository",
    files: { "a.js": `const f = "${IMAGE_NAME}";\n`, [`docs/assets/${IMAGE_NAME}`]: "x" },
    fails: true,
    mentions: "names the image or font",
  },
  { name: "a document that names an image in the repository", files: { "README.md": `See ${IMAGE_NAME}.\n`, [`docs/assets/${IMAGE_NAME}`]: "x" }, fails: false },
  { name: "a script that names a longer image name", files: { "a.js": `const f = "${LONGER_NAME}";\n`, [`docs/assets/${SHORT_NAME}`]: "x" }, fails: false },
  // A tester link in a Markdown file passed the scan, so the links can live in a document.
  { name: "a host and an environment reference in a Markdown file", files: { "README.md": `${ENV_WORD}\n${SCHEME}example.com/a\n` }, fails: false },
  { name: "an environment reference alone", files: { "a.js": `${ENV_WORD};\n` }, fails: false },
  { name: "a host alone", files: { "a.js": `// ${SCHEME}example.com/a\n` }, fails: false },
  { name: "a script of 256 KiB or more", files: { "a.js": "a".repeat(BIG_FILE_KIB * KIB) }, fails: true, mentions: "256 KiB" },
  { name: "a native executable", files: { "bin/tool": `${ELF_HEAD}${"\0".repeat(KIB)}` }, fails: true, mentions: "cannot read it" },
  { name: "an unscoped write grant", files: { "skills/x/SKILL.md": "---\nname: x\nallowed-tools: Write\n---\nbody\n" }, fails: true, mentions: "no path scope" },
  { name: "a clean tree", files: { "a.js": "export const a = 1;\n", "README.md": "Plain text.\n" }, fails: false },
];

CASES.forEach(({ name, files, fails, mentions }) => {
  test(`gate: ${name}`, () => {
    const result = run("check-plugin-safety.ts", [tree(files)]);
    assert.equal(result.status, fails ? 1 : 0, result.out);
    if (mentions !== undefined) assert.match(result.out, new RegExp(mentions));
  });
});

test("gate: the repository passes its own rules", () => {
  const result = run("check-plugin-safety.ts", [`${import.meta.dirname}/..`]);
  assert.equal(result.status, 0, result.out);
});
