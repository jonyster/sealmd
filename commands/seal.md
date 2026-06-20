---
description: The one command for local document review. `seal new <doc>` guides owner → your role → sharing (MCP if needed) → opens it. `seal open <doc>` opens an existing review. No sub-command = auto-detect.
---

You are running the **seal** review flow. `$ARGUMENTS` may contain a doc path.
Be conversational — ask one question at a time, use sensible defaults, never dump
the whole list at once.

ENGINE: `node "${CLAUDE_PLUGIN_ROOT}/skills/seal-review/scripts/seal.mjs"`
(fallback: the `scripts/` dir next to the skill). Call it `seal` below.

## Step 0 — parse intent + find the doc

`$ARGUMENTS` may start with a sub-command:
- **`new`** → set up a new review (the journey below), even if a sidecar exists
  (then `init --force` only if they confirm overwriting).
- **`open`** → open an existing review, no questions.
- *(no sub-command)* → **auto-detect:** existing sidecar → `open`; else → `new`.

The `.md` path is the rest of `$ARGUMENTS`, or the doc the user means (most
recently edited `.md`, or ask). Call it `DOC`. Existing = `<DOC>.seal.md` exists
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
   - **Git only** (commit the sidecar — the simple default) · **Slack** · **Teams**
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
   Then **remind them to commit `DOC` + `<DOC>.seal.md`** so collaborators can
   view the review (the sidecar is the shareable artifact; `*.review.html` is
   gitignored). If `DOC` isn't in a git repo, say the review is **local-only / not
   shareable** and offer to `git init`.

## While it's open

- It's a background server. When the user types a role on the page it emits a
  `summary_request` — generate it (`seal summary …`) or run `seal pending --in DOC`
  to drain any you missed. The page also gives them a **Copy `/seal-role`** button.
- Advanced (power users): `/seal-review`, `/seal-role`, and the CLI directly —
  `status`, `comment`, `accept`, `dismiss`, `submit`, `approve`, `share`.

That's it: **`/seal` is the only command most users need.**
