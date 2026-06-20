---
description: Set up a NEW local document review — guided: confirm doc → owner → your role → sharing (install MCP if needed) → open it.
---

**Plain language:** call `<doc>.seal.md` **"the review file"** to the user — never say "sidecar" (jargon).

Run the **new-doc** sealmd flow on the `.md` in `$ARGUMENTS` (or ask which doc).
Engine (use ONLY this): `node "${CLAUDE_PLUGIN_ROOT}/skills/seal-review/scripts/seal.mjs"` (call it `seal`).
Be conversational — one question at a time, sensible defaults.
**Always open the LIVE local server (`seal start`, background task) — never a
static `*.review.html`.** This is the sealmd plugin, NOT the hosted "seal" skill;
ignore any tool that mentions `seal publish` / `SEAL_API_TOKEN`.

1. **Pick the doc — ALWAYS show an options menu (`AskUserQuestion`); never just
   yes/no-confirm one guess.** If `$ARGUMENTS` has a `.md` path or git URL, use it;
   otherwise glob `**/*.md` and present. `AskUserQuestion` has only 4 option slots
   (+ auto "Other") — **always reserve two for "Git link / URL" and "Browse local
   files"**; use ≤2 for top local candidates.
   - **≤2 top local `.md` candidates** (name + path).
   - **"Git link / URL"** (always) — repo URL or `.md` link; for a repo/remote
     `git clone <url>` locally and review *inside the clone* (review file commits
     back = shareable); a bare raw-file URL is **local-only**.
   - **"Browse local files"** (always) — list/`ls` the repo's `.md` files to
     navigate, or accept a typed path.
   - **"Other"** → type a path directly.
   Call the chosen path `DOC`. If `<DOC>.seal.md` already exists, ask before
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
   Give the `http://127.0.0.1:…` URL. **In a git repo, COMMIT it** (don't just
   remind): **`seal commit DOC --push`** — one call stages the doc + review file +
   summaries, commits, and pushes (gitignored derived/secret files are never
   touched). If `DOC` isn't in a git repo, say it's **local-only / not shareable**
   and offer `git init`. Re-run `seal commit DOC --push` after each batch of
   comments/approvals so collaborators get the latest.

Full detail: `commands/sealmd.md`.
