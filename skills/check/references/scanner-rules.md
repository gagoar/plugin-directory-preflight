# What the directory scan held, and why

Learned by getting `typescript-patterns-enforcer` through the scan (17 releases). Every item below was a false
positive on that plugin: the plugin reads no environment and sends nothing. The scan is a text heuristic.
The gate script (`scripts/check-plugin-safety.ts`) encodes the items marked *gate*.

A **hold** routes the version to a human reviewer; it is not a rejection. It recurs on every new version,
so removing the trigger saves a review each release.

## How the scan behaves

- It names only the **first** match in path order (byte order: dot-directories, then upper case, then lower case).
  A match in an earlier-sorting file hides every later one. Twice a hold looked "fixed" because an earlier
  file started matching instead.
- Two levels of finding. **File level**: one file holds a remote host and a credential-looking reference.
  **Plugin level**: any credential-looking reference in one script plus any `https://` string in any script
  (a "sender" such as a regex tester link, or a bare scheme in a constant). The sender cannot be removed
  from most plugins, so remove the reference.
- Comments, documents and generated bundles are read like code. Prose is read as if it were shell.
- The portal's Validate step runs these checks; `claude plugin validate` only checks structure.

## Triggers

| What matches | Why it matters to the scan | Fix | |
|---|---|---|---|
| A plugin `name` within two edits of a directory name, or the same words reordered (displayName does not count) | name confusion | choose a long, descriptive name; compare it with the public catalog names | |
| A script or document of 256 KiB or more | read only that far, then held | split vendored code into readable files under the limit | gate |
| One word longer than ~4 KiB (a Unicode table in a parser) | cannot be checked | split the string literal with concatenation | |
| A shell command word that prints the environment, alone in a call or a condition, after a parenthesis, a brace or a statement start, in code, comments or documents | read as a subshell running that command with no arguments | rewrite the call or the variable; write the word as two joined halves; never spell it in prose | gate |
| A template placeholder whose expression names a credential, however harmless the expression | read as a lookup of the installer's credentials | rename, or build the string by concatenation | gate |
| Prose that reads as a shell line: a comment starting with a command-like word, or ending with one; the word for a password-manager command followed by another word in a skill body | prose parsed as commands | reword; strip comments from vendored bundles | |
| A glob in a document that covers images or fonts | the document is read as naming files the scan cannot read | use a path with no images under it | gate |
| A remote host (a badge, a tester link) and an environment-looking reference in one file | file-level pairing | move one of them | gate |
| A native executable in the repo | cannot be read | ship source, fetch a pinned build | gate |
| An unscoped write, edit or shell grant in a skill, agent or command | grants too much | scope it to a path | gate |

Not holds, expect them: warnings that the directory reads listing fields the older CLI does not know
(documentation, support, privacy, terms), and an info note that images were let through unread.

## Habits that avoid extra rounds

- Search every tracked file, comments and documents included, for a shape before the first upload.
- Fix all instances in one pass.
- Do not exempt the checker from its own rules.
- Keep PR text, commit messages and comments free of the shapes: describe them.
- Bump the version for every upload; paste only `diagnostics`.
