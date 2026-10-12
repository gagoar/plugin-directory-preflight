---
name: check
description: "/plugin-directory-preflight:check — Run before uploading a Claude Code plugin to the plugin directory, and again when the upload scan reports a hold. Runs the local gate and validator, reads a scan report compactly, and pins a stubborn hold with a throwaway probe repository instead of guessing. Trigger when the user mentions uploading or submitting a plugin, the directory scan, a hold, a scan report, a policy review, or the MCP_FORWARDS_CREDENTIAL_ENV finding."
---

# Plugin directory preflight

The directory's upload scan cannot be run locally, and it reports only the first match in path order. Without
this routine, every fix reveals the next hold and each try costs a release, an upload and a long report.
The goal: reach a clean report in one or two uploads.

Scripts live in `${CLAUDE_PLUGIN_ROOT}/scripts/`. Run them with `node` (Node 22.6+ strips the types).

## 1. Before any upload

1. Find the plugin root: the directory holding `.claude-plugin/plugin.json` (the repo root, or a `plugin/`
   subdirectory). Note the plugin's `name` and `version`.
2. Check whether the repo has the current gate:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/install-gate.ts" <repo> --check`
   If it is missing or outdated, run it without `--check` (it never overwrites a CI workflow that differs,
   unless `--force`). Commit the gate as its own change.
3. Run the gate over the whole repo, comments, documents and generated files included:
   `node scripts/check-plugin-safety.ts .`
4. Run `claude plugin validate <plugin-root> --strict` (also on the manifest files).
5. Fix **every** hit in one pass, then run steps 3 and 4 again. Do not stop at the first hit: the scan reveals
   them one at a time, and each extra round is an upload.
6. Bump the plugin version (the directory follows the default branch and compares versions). If the plugin
   ships release assets, tag and wait for them. Then stop and ask the user to upload.

What the gate checks, and why each rule exists, is in `references/scanner-rules.md`. For plugins that bundle
third-party code, read `references/vendored-bundles.md` before the first upload.

## 2. Writing rules while you fix

These cost the most rounds last time. Each was a fix that created the next hold:

- Never write a flagged shape into a comment, a document, a commit or a PR description. Describe it
  ("a command word on its own in a call") and point to the gate script's word list.
- Run the gate on the gate. Do not exempt the checker from its own rules.
- Do not put a remote URL (a badge, a tester link) in a file that also mentions the environment or a
  credential. Move one of them.
- After adding a document or script, run the gate again before committing.

## 3. After the upload

Ask the user for **only the `diagnostics` array** of the report (browser developer tools, or save the whole
JSON to a file). Never ask for the whole report: it is ~40k tokens of file listings.

`node "${CLAUDE_PLUGIN_ROOT}/scripts/read-report.ts" <report.json>`

It prints the phases, each hold or blocking finding, the file the scanner named, and the files that sort
before it. Then:

- **Clean** (no holds, nothing blocking): done. Warnings about listing fields and the note about images are
  not holds.
- **A hold the gate explains**: fix that shape everywhere (step 1.5), bump the version, upload again.
- **A hold the gate cannot explain**: do not guess a third time. Use the probe below.
- **Only false positives remain** and there is nothing left to rewrite: a hold goes to a human reviewer and is
  not a rejection. Draft a short note for the portal's "Get help" action: what the plugin does, that the
  match is a keyword or a parser word, and which file.

## 4. Pinning a hold the gate cannot explain

The finding names a file (`credential_at`). If it is a large file, cut it up:

1. `node "${CLAUDE_PLUGIN_ROOT}/scripts/make-probe.ts" round1 <file> <outDir>` writes a small plugin whose
   `probe/` holds the file in 16 slices that sort in line order, plus a send target for the scanner to pair
   with.
2. **Ask the user first**, then create a throwaway public repository, push `<outDir>`, and have them upload it.
3. Read the report with `read-report.ts`; the named slice (`probe/s1-NN.js`) is the first match.
4. `... narrow <outDir> <slice>` cuts that slice into smaller ones; push; upload; read.
5. At a few lines, `... windows <outDir> <slice>`; the smallest window that triggers shows how many lines
   the trigger needs. `... explain <outDir> <window>` prints the original lines.
6. Fix every instance of that shape in the real plugin, upload the real plugin, then delete the probe repo
   (the token needs the `delete_repo` scope: `gh auth refresh -h github.com -s delete_repo`).

Three rounds usually reach one line. The probe is the reliable way to find a trigger; reading the file and
guessing was wrong several times.

## 5. Reference

- `references/scanner-rules.md`: what held `typescript-patterns-enforcer`, the rule behind each hold, and
  why the scan appears to move from file to file.
- `references/vendored-bundles.md`: build-time transforms for bundled third-party code.
- `references/policy-review.md`: the separate AI policy review (credential routing across services).
