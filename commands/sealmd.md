---
description: The one command for local document review. `seal new <doc>` guides owner → your role → sharing (MCP if needed) → opens it. `seal open <doc>` opens an existing review. No sub-command = auto-detect.
---

You are running the **sealmd** review flow. `$ARGUMENTS` may contain a doc path.
Be conversational — ask one question at a time, use sensible defaults, never dump
the whole list at once.

**Plain language:** to the user, call `<doc>.seal.md` **"the review file"** (it
holds the comments + sign-offs, lives next to the doc, commit it). Never say
"sidecar" — it's jargon. Same for other internal terms below.

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

**Pick the doc — ALWAYS show an options menu (`AskUserQuestion`); never just
yes/no-confirm a single guessed doc.** (This applies to `/sealmd`, `/seal-new`,
and `/seal-open` alike.) If `$ARGUMENTS` already has a `.md` path or a git URL,
use it directly; otherwise glob the project's `.md` files and ask, with options:
- **Top local `.md` candidates** — a few, labelled by name + path, to pick/browse.
- **"Git link / URL"** — paste a git repo URL or a link to a `.md`. For a
  repo/remote, **`git clone <url>` locally first** and review the doc *inside the
  clone* (so the review file commits + pushes back = shareable); a bare raw-file URL is
  fetched but **local-only** (can't commit the review file back).
- **"Other"** → type/browse a path.

Only after they pick, call it `DOC`. Existing = `<DOC>.seal.md` exists
(`seal status --in DOC --json` succeeds).

## `open` — open an existing review

Run `seal start DOC` as a **background task**. Give the user the
`http://127.0.0.1:…` URL. Done — no questions. (If there's no sidecar yet, say so
and offer `/seal new DOC`.)

## `new` — set up a review (ask one at a time)

1. **Confirm the doc** — "Reviewing `DOC` — correct?"
2. **Owner** — default from git (`git config user.name`). Confirm: "Owner =
   *<name>*?" If git has no name, **ask who owns sign-off**.
3. **Your role** — **ask: "What's your role for this review?"** (Compliance, Eng,
   PM, Legal, a job title — anything). You'll generate that role's summary so
   their view is tailored from the first open.
4. **Sharing** — **ask how they want to share / be notified:**
   - **Git only** (commit the review file — the simple default) · **Slack** · **Teams**
     · **Email** · **none**.
   - If they pick Slack/Teams/Email and that **MCP isn't connected**, tell them to
     install it (e.g. the Slack MCP) and which `--mcp` you'll pass; if they can't,
     fall back to git. For a webhook, ask for the Incoming Webhook URL.
5. **Set up + start:**
   ```bash
   seal init   --in DOC --owner "<owner>" [--notify git,slack,…] [--slack-webhook <url>]
   seal summary --in DOC --role "<their role>" --file <tmp.json>   # generate their tailored view
   seal start  DOC --mcp <connected-mcps>                          # opens the LIVE review (background)
   ```
   **In a git repo, COMMIT the review so it's shareable — don't just remind.** Run
   **`seal commit DOC --push`** (one call: stages the doc + review file +
   summaries, commits, pushes; never touches the gitignored derived/secret files).
   If `DOC` isn't in a git repo, say the review is **local-only / not shareable**
   and offer to `git init` first.

## While people review

After a new batch of comments/approvals (or when the user's done), **commit
again** with **`seal commit DOC --push`**. Each commit is what collaborators pull
to see the latest review.

## While it's open

- It's a background server. When the user types a role on the page it emits a
  `summary_request` — generate it (`seal summary …`) or run `seal pending --in DOC`
  to drain any you missed. The page also gives them a **Copy `/seal-role`** button.
- Advanced (power users): `/seal-review`, `/seal-role`, and the CLI directly —
  `status`, `comment`, `accept`, `dismiss`, `submit`, `approve`, `share`.

That's it: **`/seal` is the only command most users need.**
