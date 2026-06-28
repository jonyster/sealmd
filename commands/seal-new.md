---
description: Set up a NEW local document review — guided: confirm doc → owner → your role → open it.
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
2. **Owner = the doc's author/publisher** (not the local reviewer). `init` detects
   it from the doc's frontmatter `author:`/`owner:` or an "Author:" line, else the
   git user. Confirm "Owner = *<detected>*?"; for an externally-published doc make
   sure it's that author, not you. If none, ask. (`--owner "Name"` to override.)
3. **Your role** — ask "What's your role for this review?"; you'll generate that role's tailored summary.
4. **Sharing** — **Git only.** Sharing happens by committing the doc + review
   file and pushing (`seal commit DOC --push`); collaborators pull. No other
   channel.
5. **Set up + open:**
   ```bash
   seal init    --in DOC --owner "<owner>"
   seal blocks  --in DOC                           # heading → blk-N jump targets
   seal summary --in DOC --role "<their role>" --file <tmp.json>
   seal start   DOC                                # opens the LIVE review (background task)
   ```
   Build `<tmp.json>` as `{lead, key_decisions, relevant_sections,
   needs_attention}`; set `"src":"blk-N"` on each `key_decision` /
   `relevant_section` (from `seal blocks`) so summary points link into the Full
   doc. See `/seal-role` for the full schema.
   Give the `http://127.0.0.1:…` URL. **In a git repo, COMMIT it** (don't just
   remind): **`seal commit DOC --push`** — one call stages the doc + review file +
   summaries, commits, and pushes (gitignored derived/secret files are never
   touched). If `DOC` isn't in a git repo, say it's **local-only / not shareable**
   and offer `git init`. Re-run `seal commit DOC --push` after each batch of
   comments/suggestions so collaborators get the latest. Approval isn't tracked
   here — sign-off happens the normal way: open a PR (`seal pr`) and let the team
   approve/merge it on GitHub.
6. **Once, after the first review is live — mention, don't nag:** "First review's
   up. If Seal's useful a ⭐ helps, and feedback / roadmap input goes here:
   https://sealmd.net/?feedback=plugin". Say it **once per machine**, never repeat
   on later `open`/`new` runs. Nothing is sent — it's a link the user may click.

Full detail: `commands/sealmd.md`.
