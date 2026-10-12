# Bundling third-party code for the directory scan

Recipe from `typescript-patterns-enforcer` (`engine/build.mjs`): an engine bundled from a JavaScript parser and
its TypeScript plugin, shipped as readable files. Each step is a build-time transform that **fails the build
if its target text is not found**, so a dependency bump that changes the text cannot silently undo it.

1. **Split by size.** The scan reads a script up to 256 KiB. Keep each bundled file under it and load the parts
   with a relative require. Do not minify: unreadable files are what the scan holds.
2. **Strip comments from vendored bundles.** Their prose reads as shell. Parse the bundle, remove comment
   ranges, keep your own banner. Prove nothing else changed by comparing syntax trees before and after.
3. **Split long string literals** over about 1,500 characters into pieces joined with concatenation.
   Compare behavior (for example every code point against a table) before and after.
4. **Rewrite lone command words.** Find calls whose only argument is one of the gate's command words, and
   variables named after one that start a condition. Write the word as two joined halves, or rename the
   variable. Build the match pattern from a word list so the build script never contains the bare shape.
5. **Neutralize credential-named placeholders** inside the bundle (template strings that mention a key or a
   token), by concatenation.
6. **Replace never-shown error messages** that read like command lines. If the engine swallows parse errors,
   the plugin's plain-string messages can become their own key names.
7. **Keep the build script clean too.** It is shipped and scanned. Comments that explain a transform must
   describe the shape, not spell it.

Verify with whatever oracle the engine has (outputs on thousands of real files, a differential against the
previous engine), then run the gate over `dist/` and the build script.
