---
description: The one command for local document review. `seal new <doc>` guides owner → your role → opens it. `seal open <doc>` opens an existing review. No sub-command = auto-detect.
---

You are running the **sealmd** review flow. `$ARGUMENTS` may contain a doc path.
Be conversational — ask one question at a time, use sensible defaults, never dump
the whole list at once.

**Plain language:** to the user, call `<doc>.seal.md` **"the review file"** (it
holds the comments + suggestions, lives next to the doc, commit it). Never say
"sidecar" — it's jargon. Same for other internal terms below.

**What this is:** a Google-Docs-style **local** Markdown review — role-tailored
summaries, anchored **comments**, **suggestions** (propose old→new; Accept applies
the edit to the doc), and resolve/reopen. That's the whole review surface. There's
**no approval / sign-off / quorum / submit** here. **Approval = a normal GitHub
PR:** open one (`seal pr`) and your team reviews/approves/merges it on GitHub. Seal
doesn't track approval state itself. (The hosted tier — `seal publish` /
sealmd.net — is what has the in-app, identity-verified approval workflow.)

ENGINE (use ONLY this — the sealmd plugin's CLI):
`node "${CLAUDE_PLUGIN_ROOT}/skills/seal-review/scripts/seal.mjs"` (fallback: the
`scripts/` dir next to this command's skill). Call it `seal` below.

**CRITICAL:**
- Always open the **LIVE local server** (`seal start` / `seal serve`, run as a
  **background task**) and give the user the `http://127.0.0.1:…` URL. **Never**
  produce a static `*.review.html` as the result, and never run `render` as the
  primary action.
- This is **not** the hosted "seal" skill. Do **not** use any other `seal`
  command/skill that renders a static page or mentions `seal publish` /
  `SEAL_API_TOKEN`. If you can't resolve `${CLAUDE_PLUGIN_ROOT}`, find this
  plugin's `seal.mjs` on disk — don't fall back to a different tool.

## Step 0 — parse intent + find the doc

`$ARGUMENTS` may start with a sub-command:
- **`new`** → set up a new review (the journey below), even if a sidecar exists
  (then `init --force` only if they confirm overwriting).
- **`open`** → open an existing review, no questions.
- *(no sub-command)* → **auto-detect:** existing sidecar → `open`; else → `new`.

**Pick the doc — show a TWO-option menu (`AskUserQuestion`).** (Applies to
`/sealmd`, `/seal-new`, and `/seal-open` alike.) If `$ARGUMENTS` already has a
`.md` path or a git URL, skip the menu and use it. Otherwise ask:
- **"GitHub"** — the user pastes a git repo URL or a link to a `.md`. For a
  repo/remote, **`git clone <url>` locally first** and review the doc *inside the
  clone* (so the review file commits + pushes back = shareable); a bare raw-file
  URL is fetched but **local-only**.
- **"Local file"** — paste/type the path to a local `.md` (the automatic "Other"
  free-text slot). Suggest the likeliest `.md` as the placeholder if one is obvious.

Only after they pick, call it `DOC`. Existing = `<DOC>.seal.md` exists
(`seal status --in DOC --json` succeeds).

## `open` — open an existing review

Run `seal start DOC` as a **background task**. Give the user the
`http://127.0.0.1:…` URL. Done — no questions. (If there's no sidecar yet, say so
and offer `/seal new DOC`.)

## `new` — set up a review (ask one at a time)

1. **Confirm the doc** — "Reviewing `DOC` — correct?"
2. **Owner = the doc's author/publisher**, not the local reviewer. `init` detects
   it from the doc (frontmatter `author:`/`owner:` or an "Author:" line); if the
   doc has none, it falls back to the git user. **Confirm: "Owner = *<detected>*?"**
   — and if the doc was published by someone else (e.g. an external repo) make sure
   the owner is *that* author, not you. If nothing's detected, **ask who the doc's
   author is**. (Override with `--owner "Name"`.)
3. **Your role** — **ask: "What's your role for this review?"** (Compliance, Eng,
   PM, Legal, a job title — anything). You'll generate that role's summary so
   their view is tailored from the first open.
4. **Sharing — don't ask; auto-detect.** Sharing is always git, so there's no
   choice to present. Repo has a remote → step 5 shares it by commit + push. No
   remote (or not a repo) → tell the user it's **local-only / saved on disk** and
   offer to add one (`git remote add origin <url>`, or open from a cloned repo).
   Never show a sharing menu.
5. **Set up + start:**
   ```bash
   seal init   --in DOC --owner "<owner>"
   seal summary --in DOC --role "<their role>" --file <tmp.json>   # generate their tailored view
   seal start  DOC                                                 # opens the LIVE review (background)
   ```
   **In a git repo, COMMIT the review so it's shareable — don't just remind.** Run
   **`seal commit DOC --push`** (one call: stages the doc + review file +
   summaries, commits, pushes; never touches the gitignored derived/secret files).
   If `DOC` isn't in a git repo, say the review is **local-only / not shareable**
   and offer to `git init` first.
6. **Once, after the first review is live — mention, don't nag:** "First review's
   up. If Seal's useful a ⭐ helps, and feedback / roadmap input goes here:
   https://sealmd.net/?feedback=plugin". Say it **once per machine**, never repeat
   on later runs. Nothing is sent — it's a link the user may click.

## While people review

After a new batch of comments/suggestions (or when the user's done), **commit
again** with **`seal commit DOC --push`**. Each commit is what collaborators pull
to see the latest review. When the doc is ready to ship, open a PR with **`seal
pr`** — approval happens there, on GitHub.

## While it's open

- It's a background server. When the user types a role on the page it emits a
  `summary_request` — generate it (`seal summary …`) or run `seal pending --in DOC`
  to drain any you missed. The page also gives them a **Copy `/seal-role`** button.
- Advanced (power users): `/seal-review`, `/seal-role`, and the CLI directly —
  `status`, `comment`, `accept`, `dismiss`, `share`, `pr`.

That's it: **`/seal` is the only command most users need.**

**Updating the plugin:** if the user asks how to update (or hits a bug fixed
upstream), tell them a plain app restart does **not** fetch new versions — they
must refresh the marketplace cache first: `/plugin marketplace update sealmd`,
then `/plugin` → **sealmd → Update**, then restart.
