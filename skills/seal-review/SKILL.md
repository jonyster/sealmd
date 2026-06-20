---
name: seal-review
description: Review a Markdown document fully locally — no server, no network. Maintains a doc.seal.md sidecar holding comments and review state next to doc.md, and renders a polished self-contained doc.review.html (Summary / Full doc / Markdown). Use when the user wants to review/comment on a PRD/spec/RFC locally, file or resolve comments, or open the local review page. Triggers: "review this locally", "add a comment", "open the review page", "comment on this spec", "/seal-review". NOT for the hosted/paid publish flow (that is the separate "seal" skill).
---

# seal-review — fully local document review (two files, zero network)

seal-review turns one canonical Markdown file into a reviewable surface using
**two committed files that live side by side**:

- `doc.md` — the canonical document the agent reads & writes.
- `doc.seal.md` — the sidecar: review state + comments, each a structured
  `json seal:<kind>` block inside a guarded records region.

Plus a derived viewer regenerated on every change and **gitignored**:

- `doc.review.html` — a single self-contained HTML page with **zero network
  calls** (no external fonts/CSS/JS/CDN). It has the seal Summary / Full doc /
  Markdown toggle, highlights each comment on its quoted span, and lists all
  comments in a side rail.

There is no server. Comments bind to the **sha256 content hash** of the
normalized doc, so an edit after a comment is filed shows up as drift
("context changed"). This is tamper-**evident**, not tamper-proof — anyone can
hand-edit the plaintext sidecar; **git history is the real audit trail.**

Sign-off is built in: `submit` pins the version under review, then `approve` /
`request` record decisions **bound to that submitted version**. Editing the doc
after sign-off makes approvals **stale** (you must `submit` again) — that drift
is the local tamper-evidence. Note: `--approver` is self-asserted, so this is
NOT identity-verified approval — that is the hosted, paid `seal publish` step
(the separate `seal` skill). A local file cannot verify identity.

## When to use

- The user wants to review a PRD/spec/RFC locally and leave comments.
- "review this locally", "add a comment on X", "resolve that comment",
  "open the review page", or `/seal-review`.
- Do NOT use for hosting a review or collecting identity-verified approvals —
  that is the hosted `seal publish` flow in the `seal` skill.

## The script

Run the engine with Node (≥18, zero dependencies, no `npm install`):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/seal-review/scripts/seal.mjs" <command> --in <doc.md> [opts]
```

If `${CLAUDE_PLUGIN_ROOT}` is unset (e.g. running from a clone, not an install),
use the `scripts/` dir next to this SKILL.md.

## The one simple command

When the user just wants to review a doc, run **`start`** with the path — it
creates the sidecar if needed (owner from git), then opens the **live** review:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/seal-review/scripts/seal.mjs" start <doc.md>
```

`start` prefers **serve** (live, writable) over a static render. It prints git
shareability + owner status to stderr — **act on it**:

- **Not a git repo** → the review is *local only, not shareable*. Tell the user;
  offer to `git init` so the sidecar can be committed and shared.
- **Owner unknown** (no `--owner`, no `git config user.name`) → **ask the user who
  owns sign-off**, then pass `--owner "Name"`.
- Always remind the user to **commit `doc.md` + `doc.seal.md`** so every
  collaborator sees the review. The sidecar is the shareable artifact — git is
  the transport. (The `*.review.html` is derived and gitignored.)

## Commands

| Command | Use |
|---|---|
| `init --in doc.md [--title T]` | Create `doc.seal.md` (state `in_review`); append `*.review.html` to `.gitignore`; render the page. Run once per doc. |
| `status --in doc.md [--json]` | Review state, open/resolved counts, and **anchor health** (which comments lost their quoted span). Start here. |
| `comment --in doc.md --body B [--author A] [--anchor "exact span"] [--suggest "replacement"]` | File a comment. `--anchor` must be an **exact, unique** substring of the doc (copy it verbatim, including any markdown like `**bold**`); omit it for a document-level comment. `--suggest` (requires `--anchor`) records a proposed replacement, rendered as a del→ins diff. |
| `reply --id ID --body B [--author A]` | Reply in a comment's thread. |
| `resolve --id ID` / `reopen --id ID` | Toggle a comment's status. |
| `submit --in doc.md` | Put the current version up for review (pins the version approvals bind to). Run before collecting approvals, and again after revising. |
| `approve --in doc.md --approver A [--note N]` | Record an approval of the submitted version. Reaches `approved` at quorum (default 1) with no outstanding change-request. |
| `request --in doc.md --approver A --note N` | Request changes on the submitted version (a current request vetoes `approved`). |
| `render --in doc.md [--out f.html] [--summary s.json] [--open]` | (Re)generate the static page. `--open` opens it. |
| `serve --in doc.md [--port N] [--open] [--notify-cmd CMD]` | **Live** review on `127.0.0.1` only. The page POSTs comments/suggestions and the engine writes the sidecar directly (no copy-paste). Each mutation streams as a `SEAL_EVENT` line on stdout — see the bridge below. |
| `hash --in doc.md` | Print the bare-hex content hash. |
| `doctor --in doc.md` | Validate the sidecar (read-only). |

`--author` defaults to `git config user.name`. Identity is **self-asserted** —
do not present `--author`/comment authorship as verified.

## How to drive it

1. **Read `doc.md`** so you understand what is being reviewed.
2. **`init`** if there is no `doc.seal.md` yet (check first). Otherwise run
   **`status`** to see where the review stands.
3. **File comments** the user dictates. For a comment about a specific passage,
   pass `--anchor` with the **exact** quoted text — if the engine says
   "not found verbatim" or "ambiguous", copy a longer exact span. Anchoring is
   deterministic: no fuzzy matching (so it never silently mis-points).
4. **`render`** (mutating commands auto-render). **Offer to open** the page —
   do not auto-open. Tell the user the absolute path and the open command.
5. **Report**: the review-page path, open comments, and any "context changed"
   comments (their quoted text no longer exists in the doc — surface these).

### Role-tailored summaries

The page's Summary is **role-aware**: a reader picks or types their role and the
digest re-renders for them (client-side, zero network). Generate one summary per
reviewer role and write them to `<doc>.seal.summary.json` (auto-loaded on every
render — commit it):

```json
{ "roles": [
  { "role": "General",     "lead": "...", "key_decisions": [{"label":"...","value":"..."}], "needs_attention": ["..."] },
  { "role": "Compliance",  "lead": "...", "key_decisions": [...], "needs_attention": [...] },
  { "role": "Engineering", "lead": "...", "key_decisions": [...], "needs_attention": [...] }
] }
```

Lead each role with the decision **that role** must make; `key_decisions` are the
choices affecting them; `needs_attention` is what they must judge before signing
off. The first role is the default. A single-summary file (`{lead, key_decisions,
needs_attention}`) still works (renders as "General"); if no file exists the
summary is auto-derived.

### Entering comments from the rendered page (no server)

The page itself lets a human reviewer compose: in **Full doc**, select text →
a **💬 Comment / ✎ Suggest** button appears → write → **Copy for agent**. That
copies a one-line instruction the reviewer pastes into their AI console, which
then runs `seal-review comment …` for them. (A static local file can't POST —
this copy-to-console step is the zero-server bridge. "Show CLI" reveals the raw
command for terminal users.) The agent is always the writer of record.

### ⭐ Catching live events (role generation) — the in-app loop

When the user wants a **live** review, YOU are the generator for any role that
isn't pre-baked. Do this:

1. **Launch `start` / `serve` as a BACKGROUND task** (never foreground — it runs
   until stopped). Claude Code surfaces the server's stdout back to you.
2. **Watch for `SEAL_EVENT` lines** in that task's output. The important one:
   ```
   SEAL_EVENT {"type":"summary_request","role":"Bodybuilder","doc":"…/PRD.md", "hint":"ACTION: …"}
   ```
   The moment you see one: **read the doc, write a tailored summary for that role,
   and run** —
   ```bash
   seal summary --in <doc> --role "<role>" --file <json>
   ```
   The page is polling and swaps it in automatically. Don't ask the user — just
   generate it (that's the whole point of "type any role").
3. **If you might have missed an event** (you weren't looking at the task output
   that turn), drain the durable queue any time:
   ```bash
   seal pending --in <doc>          # lists requested roles with no summary yet
   ```
   Generate each, then `seal summary`. The queue (`*.seal.requests.jsonl`) persists
   every request, so nothing is lost even if the live event scrolled past.

**Cadence:** after launching serve, each time you take a turn, glance at the
background task output (and/or `seal pending`) and fulfil any open
`summary_request`s before replying. Pre-baked roles and all other actions
(comment, accept, dismiss, edit, status) need no agent — only new typed roles.

### Agent-in-the-loop (how the plugin runs a live review)

This is the operating model when a human wants an interactive review. **You (the
agent) are the loop** — the plugin gives you the surface and the events:

1. **Launch the server as a BACKGROUND task** (so its output re-invokes you):
   `node "${CLAUDE_PLUGIN_ROOT}/skills/seal-review/scripts/seal.mjs" serve --in doc.md --open`
   Add `--mcp <list>` for the share channels you actually have connected (e.g.
   `--mcp github,slack,email`), and notification flags if configured.
2. **React to `SEAL_EVENT` lines** the server prints on stdout. Each human action
   emits one. Handle them:
   - `summary_request {role}` → read the doc, write a role-tailored digest, then
     run `seal summary --in doc.md --role "<role>" --file <json>` (or pipe JSON on
     stdin). The page is polling and swaps it in — no refresh.
   - `share_request {channels, to, file}` → use your **MCP tools** to share the
     exported file/link (GitHub gist or PR comment, Slack post, email) to `to`.
   - `comment` / `suggestion` / `summary_request` are also your cue to triage,
     reply, or revise the doc and re-render.
3. Keep the task running until the user is done; stop it when they say so.

Because the work (generate summary, share, revise) is just you with the plugin's
commands + your MCPs, the whole live loop is **self-contained in the plugin** — no
server of ours, no API keys required. Pre-baked roles and all non-generative
actions (comment, mention, status, render) work with **no agent in the loop**;
only a *new typed role* and *MCP share* need you.

### Live review + the AI-console bridge (`serve`)

For an interactive human reviewer who wants the page to write the sidecar on
submit (not copy a command), run `seal serve`. It binds to `127.0.0.1` ONLY and
serves the same review page in "serve mode"; the composer POSTs to `/api/comment`
(and `/api/reply`, `/api/resolve`) and the **same fail-loud cores** append to the
`.seal.md` atomically, then the page refreshes.

**The bridge:** launch `serve` as a **background task** from the AI console
(Claude Code). Every human action emits one line on stdout:

```
SEAL_EVENT {"type":"comment","id":"c_…","author":"…","anchor":"…","body":"…","doc":"…"}
```

Because a background task's output re-invokes the agent, the console is notified
of each comment with **no polling** — it can then triage, reply, or revise the
doc and re-render. `--notify-cmd CMD` additionally runs an external command per
event (with the event JSON in `$SEAL_EVENT`) — e.g. a headless `claude -p` triage.
This is how the local reviewer ↔ local AI loop closes without any hosted service.

> `serve` is a loopback process, not the shareable artifact. The static `render`
> output stays the zero-network file you commit/send. Use `serve` for a live
> session, `render` for a frozen, offline, shareable review page.

### Setup — ASK how they want to notify peers about comments/changes

When setting a doc up for review (before/at `init`), **ask the user how they want
their peers and the doc owner to be told about new comments and changes.** Offer:

1. **Git-native (default, zero infra)** — `@mention` people in comments; commit
   the sidecar; the `cc @handle` line in `doc.seal.md` shows in the PR diff so
   GitHub/GitLab sends their native notification. No secrets.
2. **Slack / Teams** — paste an Incoming Webhook URL; the live server posts on
   each comment/mention.
3. **Email** — a `--email-to` address (needs a `SEAL_RESEND_KEY` env for Resend).
4. **Owner digest** — batch updates to the doc owner every N seconds.
5. **None** — git diff only.

Pass the answers to `init`:

```bash
seal init --in doc.md --owner "alice" --notify git,slack \
  --slack-webhook "https://hooks.slack.com/…" [--teams-webhook URL] \
  [--email-to a@co.com] [--digest-interval 120]
```

`init` records the non-secret choice (`owner`, `notify` channels) in the document
record and writes secrets to `doc.seal.notify.json` (auto-**gitignored**). To
resolve `@names` to handles/emails/Slack IDs, create `doc.seal.people.json`:

```json
{ "alice": { "handle": "alice-gh", "email": "alice@co.com", "slack": "@alice" } }
```

### Tagging people

`comment --mention alice,bob` or just write `@alice` in the body. Mentions are
stored on the comment and rendered as `cc @handle` in the sidecar (git-native).
When the live server (`serve`) is running with a channel configured, each comment
also fires Slack/Teams/email to the mentioned people **and** the owner.

### Notifying the document owner

The owner (set at `init`) gets notified on the configured channel for every new
comment / change-request / approval — immediately, or batched if
`--digest-interval` is set. With no channel configured, the git path still works:
committing the sidecar surfaces everything in `git pull` / the PR, and
`template/hooks/post-merge` prints `status` after a pull. Identity-verified,
guaranteed delivery is the hosted `seal publish` step.

### Approval flow

`init` → file comments → `submit` (pins the version) → reviewers `approve` /
`request` → status derives `approved` / `changes_requested`. Approvals bind to
the **submitted** version: if the doc changes, `approve`/`request` refuse until
you `submit` again, and the page/status show prior sign-offs as **stale**. State
is always **derived** from the records, never trusted from the stored cache — a
forged "approved" cache value is re-checked against the live hash on every read.
Set `--quorum N` at `init` to require N distinct approvers.

## Non-goals (deferred / explicitly not supported)

- **Fuzzy anchor relocation** — anchors are exact-unique (+ surrounding-context
  disambiguation) only; a deleted span becomes honestly "unanchored", never
  guessed.
- **Live watch / auto-refresh, committed HTML, hash-chaining** — out of scope.
- **Identity verification** — hosted `seal publish` only.

## Notes

- Pure Node ESM, `node:` built-ins only. No dependencies.
- The sidecar is rewritten atomically (`tmp` + rename). A malformed record makes
  every command **refuse to write** rather than silently drop data — fix it or
  `git checkout doc.seal.md`.
- The content hash uses the FROZEN `normalize_version=1` and is **bare hex** —
  byte-parity with `@seal/anchor` and the hosted renderer.
