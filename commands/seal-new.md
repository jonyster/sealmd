---
description: Set up a NEW local document review — guided: confirm doc → owner → your role → sharing (install MCP if needed) → open it.
---

Run the **new-doc** seal flow on the `.md` in `$ARGUMENTS` (or ask which doc).
Engine: `node "${CLAUDE_PLUGIN_ROOT}/skills/seal-review/scripts/seal.mjs"` (call it `seal`).
Be conversational — one question at a time, sensible defaults.

1. **Confirm the doc** (`DOC`). If `<DOC>.seal.md` already exists, ask before
   overwriting (`init --force`).
2. **Owner** — default `git config user.name`; confirm, or ask who owns sign-off if git has none.
3. **Your role** — ask "What's your role for this review?"; you'll generate that role's tailored summary.
4. **Sharing** — ask: git only (default) / Slack / Teams / Email / none. If they
   pick a channel whose **MCP isn't connected, tell them to install it** (and which
   `--mcp` you'll pass); ask for a webhook URL if needed; else fall back to git.
5. **Set up + open:**
   ```bash
   seal init    --in DOC --owner "<owner>" [--notify git,slack,…] [--slack-webhook <url>]
   seal summary --in DOC --role "<their role>" --file <tmp.json>
   seal start   DOC --mcp <connected-mcps>          # opens the LIVE review (background task)
   ```
   Give the `http://127.0.0.1:…` URL. **Remind them to commit `DOC` +
   `<DOC>.seal.md`** so collaborators can view it. If `DOC` isn't in a git repo,
   say the review is **local-only / not shareable** and offer `git init`.

Full detail: `commands/seal.md`.
