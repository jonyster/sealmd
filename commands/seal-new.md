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

1. **Pick the doc — show a TWO-option menu (`AskUserQuestion`).** If `$ARGUMENTS`
   already has a `.md` path or git URL, skip the menu and use it. Otherwise ask:
   - **"GitHub"** — paste a git repo URL or a `.md` link; `git clone <url>` locally
     and review *inside the clone* (review file commits back = shareable). A bare
     raw-file URL is **local-only**.
   - **"Local file"** — paste/type the path to a local `.md` (the "Other" free-text
     slot covers this; suggest a likely candidate as the placeholder if obvious).
   Call the chosen path `DOC`. If `<DOC>.seal.md` already exists, ask before
   overwriting (`init --force`).
2. **Owner = the doc's author/publisher** (not the local reviewer). `init` detects
   it from the doc's frontmatter `author:`/`owner:` or an "Author:" line, else the
   git user. Confirm "Owner = *<detected>*?"; for an externally-published doc make
   sure it's that author, not you. If none, ask. (`--owner "Name"` to override.)
3. **Your role** — ask "What's your role for this review?"; you'll generate that role's tailored summary.
4. **Sharing** — **don't ask; auto-detect.** Sharing is always git, so there's
   no choice to make. If the repo has a remote, the review shares by commit + push
   (step 5 does it). If there's no remote (or it isn't a git repo), tell the user
   it's **local-only / on disk** and offer `git init` + `git remote add`. Never
   show a sharing menu.
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
