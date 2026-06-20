# AGENTS.md — driving seal-local from any AI coding agent

`seal-local` is a **fully-local document review tool**. The whole thing is one
zero-dependency Node CLI, so it works the same from **Claude Code, Cursor, OpenAI
Codex, GitHub Copilot**, or any agent that can run a shell command. This file is
the canonical, tool-agnostic guide; the per-tool files (`.cursor/rules/…`,
`.github/copilot-instructions.md`, the Claude `SKILL.md`) all point back here.

## The model

Two committed files per document, side by side — no server, no network, no keys:

- `doc.md` — the document under review (you read & write it).
- `doc.seal.md` — the sidecar: comments, suggestions, approvals, review state, as
  structured `json seal:<kind>` blocks. Commit both.
- `doc.review.html` — a self-contained review page, regenerated, **gitignored**.

## The CLI

```
node <repo>/skills/seal-review/scripts/seal.mjs <command> --in <doc.md> [opts]
```

Requires Node ≥ 18. No `npm install`. (In Claude Code the path is
`${CLAUDE_PLUGIN_ROOT}/skills/seal-review/scripts/seal.mjs`; elsewhere use the
path where this repo is checked out.)

| Command | What it does |
|---|---|
| `init --in doc.md [--owner N] [--notify git,slack,…] [--quorum N]` | Create the sidecar + notification setup. |
| `status --in doc.md [--json]` | Review state, comments, approvals, anchor health. |
| `comment --in doc.md --body B [--anchor "exact span"] [--suggest "replacement"] [--mention a,b]` | File a comment/suggestion; `@name` in the body tags people. |
| `accept --in doc.md --id ID` | **Apply a suggestion to `doc.md`** and resolve it. |
| `dismiss --in doc.md --id ID` | Resolve/close a comment. |
| `reply --in doc.md --id ID --body B` | Reply in a thread. |
| `submit --in doc.md` | Put the current version up for approval (pins the version). |
| `approve / request --in doc.md --approver A [--note N]` | Record a sign-off / change request. |
| `summary --in doc.md --role "Label" --file s.json` | Write a role-tailored summary (see live loop). |
| `render --in doc.md [--open]` | (Re)generate the static review page. |
| `serve --in doc.md [--port N] [--open] [--mcp github,slack,email] [--slack-webhook URL]` | **Live** loopback review server. |

## The live loop (agent-in-the-loop)

When a human wants an interactive review, **you are the loop**:

1. Launch the server **as a background process** so its output reaches you:
   `node <repo>/skills/seal-review/scripts/seal.mjs serve --in doc.md --open --mcp <your-connected-mcps>`
2. Each human action prints one `SEAL_EVENT {…}` line on stdout. React:
   - `summary_request {role}` → write a role-tailored digest, run `seal summary --in doc.md --role "<role>" --file <json>`. The page polls and swaps it in.
   - `share_request {channels,to,file}` → use your integrations (GitHub / Slack / email) to share the exported file to the recipients.
   - `comment` / `suggestion` / `accept` / `doc_edited` → triage, reply, or revise the doc and let it re-render.
3. Stop the background process when the user is done.

No agent is needed for the non-generative actions (comment, mention, accept,
dismiss, edit, status, render) — only a *new typed role* (generate) and *MCP
share* call back to you. Everything writes the local files; git is the transport.

## Guarantees / non-goals

Content-hash–bound, tamper-**evident** (not tamper-proof — the sidecar is editable
plaintext; git history is the real audit trail). Identity is self-asserted.
Verified-identity approvals + a hosted shared link are the paid `seal publish`
step, out of scope here.
