# The separate AI policy review

The community marketplace repository runs a second check on listed plugins: an AI reviewer with a short
rubric (the directory policy and the acceptable use policy), reading the **whole shipped payload**, not only
the files Claude Code loads. Hidden directories, scripts and examples are in scope, because installing from a
git source clones the entire repository.

What it flags is credential **exfiltration**, which differs from the text heuristics in `scanner-rules.md`:

- Code that reads the user's live secrets (an operating-system credential store, a cloud credentials file,
  private keys, browser stores, tokens in an environment file) **and** routes them to a different service
  than the one the credential belongs to, or to a third party.
- The test is whether the credential belongs to the same service it is sent to. A plugin using the user's
  own token for a service to call that service's own API is normal. A token named for one service sent to
  another service's endpoint is a violation, even if the plugin renames it.
- Dormant code in the payload counts.

It also reports whether the plugin may make external network calls or install additional software, and a
static check flags MCP servers launched through a package runner with a floating version (a tag, a range, or
no version), because the pinned source revision does not fix what the runner downloads.

So: pin package versions in server launch commands; do not ship code that reads credentials for one service
and sends them elsewhere; know that anything in the repository ships.
