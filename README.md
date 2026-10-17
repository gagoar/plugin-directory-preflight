# Plugin Directory Preflight

Check a Claude Code plugin against what the plugin directory's upload scan holds plugins for, before you
upload it.

The scan cannot be run locally. It reports only the first match in path order, so each fix reveals the next
hold, and every try costs a release, an upload and a long report. This plugin front-loads what was learned
getting one plugin through that scan (17 releases), so the next one takes one or two uploads.

## Install

```
/plugin marketplace add gagoar/plugin-directory-preflight
/plugin install plugin-directory-preflight@plugin-directory-preflight
/reload-plugins
```

## Use

Ask Claude to run the preflight before you upload a plugin, or when a scan reports a hold:

> Run the plugin directory preflight on this repo.

The skill `/plugin-directory-preflight:check` then does five things:

1. Finds the plugin root, including a `plugin/` subdirectory, and checks that the repo has the current gate.
2. Runs the gate and `claude plugin validate --strict`, and fixes every hit in one pass.
3. Reminds you to bump the version, then stops for you to upload.
4. Reads the scan report compactly (only the findings, the file named, and the files that could be masking it).
5. When a hold cannot be explained, pins it with a throwaway probe repository in about three uploads.

## The scripts

All are plain Node (22.6 or later), no dependencies. Run them as `node scripts/<name>.ts`.

| Script | What it does |
|---|---|
| `check-plugin-safety.ts` | The gate. Run it in CI and before an upload. |
| `install-gate.ts` | Copies the gate and a CI workflow into a plugin repo; `--check` reports drift. |
| `read-report.ts` | Turns a scan report into a screenful: holds, the file named, what sorts before it. |
| `make-probe.ts` | Builds the throwaway probe repo and narrows a hit slice by slice to one line. |

## What the gate checks

The gate fails on things the upload scan holds plugins for review over:

- A skill, agent or command that pre-approves writing, editing or running commands with no path scope.
- Code, test files and comments that copy the whole environment.
- A committed native executable.
- A script or document of 256 KiB or more.
- A shell command that prints the environment, alone in a call or a condition (after a parenthesis, a brace or a
  pipe), in code, a comment or a document. The gate script has the word list.
- A template placeholder whose expression names a credential.
- A glob in a document that covers images or fonts.
- A script that names an image or a font that exists in the repository.
- A remote host and an environment reference in the same script. A Markdown file may hold the link.
- A manifest with no listing icon the directory can find: `icon` must name a square PNG or JPEG, 512 to 2048 px,
  up to 10 MiB, inside the plugin and outside `.claude-plugin/`. This is not a scan hold. The listing shows a letter
  instead. `--no-icon` skips the check for a throwaway plugin.

`skills/check/references/scanner-rules.md` explains each one and how the scan moves from file to file.

## Privacy

This plugin collects nothing and makes no network calls. Its scripts read files in the directory you point
them at and write only where you tell them to (the gate and workflow in `install-gate`, the probe folder in
`make-probe`). Claude Code handles your session under Anthropic's own terms and privacy policy.

## Terms

Provided under the MIT license, as is, without warranty. The gate is an approximation built from observed
behavior, not the directory's scan; a clean run does not guarantee a clean report. For help or to report a
problem, open an issue at github.com/gagoar/plugin-directory-preflight/issues.

## License

MIT. See [LICENSE](./LICENSE).
