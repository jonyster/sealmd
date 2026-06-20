# seal-local

Fully-local, file-based document review for Claude Code. Review a PRD / spec /
RFC where the state lives in **two committed files** beside each other and the
agent (your AI console) drives — no server, no network, no account.

> seal-local makes review **version-aware and human-reviewable offline**. It is
> tamper-**evident** (you can see the doc changed after a comment was filed),
> not tamper-**proof**. For identity-verified approvals and a non-repudiable
> audit trail, that is what hosted `seal publish` is for.

## The model

```
doc.md            the canonical document the agent reads & writes   (committed)
doc.seal.md       the sidecar: review state + comments              (committed)
doc.review.html   a self-contained, zero-network review page        (gitignored, regenerated)
```

`doc.seal.md` is a Markdown file whose every record is a compact
`json seal:<kind>` block inside a `<!-- seal:records:begin/end -->` guard, with a
one-line human summary above each block. You can read it in any Markdown viewer
(VS Code, GitHub's "Files changed" tab) — or open `doc.review.html` for the
polished view: a Summary / Full doc / Markdown toggle, each comment highlighted
on its quoted span, and a comments rail.

## Works with any AI coding agent

The engine is one zero-dependency Node CLI, so the same tool drives **Claude Code,
Cursor, OpenAI Codex, and GitHub Copilot** — each just reads its own instruction
file, all pointing at the same canonical guide:

- `AGENTS.md` — canonical, tool-agnostic (Codex / Cursor / Amp / others)
- `.cursor/rules/seal-review.mdc` — Cursor
- `.github/copilot-instructions.md` — GitHub Copilot
- `skills/seal-review/SKILL.md` + `.claude-plugin/` — Claude Code plugin

Any agent runs `node skills/seal-review/scripts/seal.mjs <command> --in doc.md`.

## Install

```
/plugin marketplace add jonyster/seal-local
/plugin install seal-local@seal-local
```

Or run the engine directly (Node ≥18, zero dependencies):

```bash
node skills/seal-review/scripts/seal.mjs <command> --in <doc.md>
```

## Quick start

```bash
ENG="node skills/seal-review/scripts/seal.mjs"
$ENG init    --in spec.md --title "My Spec"                 # create sidecar, gitignore the html
$ENG comment --in spec.md --author alice --body "tighten scope" --anchor "exact span from the doc"
$ENG comment --in spec.md --author bob   --body "overall LGTM"   # document-level (no anchor)
$ENG submit  --in spec.md                                   # pin the version up for review
$ENG approve --in spec.md --approver alice --note "LGTM"    # record a sign-off (quorum 1 -> approved)
$ENG status  --in spec.md                                   # state + approvals + anchor health
$ENG render  --in spec.md --open                            # open the review page
# edit spec.md, then:
$ENG status  --in spec.md                                   # flags drift, stale approvals, lost anchors
```

## Approval flow

`init → submit → approve / request`. Approvals bind to the **submitted** version
(`submit` pins it); editing the doc afterward makes them **stale** until you
`submit` again. State is **derived** from the records and re-checked against the
live hash on every read, so a hand-forged "approved" cache value does not hold.
`--quorum N` at init requires N distinct approvers; a current change-request
vetoes `approved`.

## Guarantees

- **Content binding** — every comment records the sha256 of the *normalized*
  doc at the moment it was filed.
- **Drift detection** — `status`/`render` recompute the live hash; a comment
  whose anchored text no longer exists is shown as "context changed".
- **Parity** — uses the frozen `normalize_version=1` + **bare-hex** sha256, so a
  hash computed here equals `@seal/anchor`'s / the hosted product's for the same
  bytes.
- **Self-contained review** — `render` emits one HTML file with zero network
  calls.

## Does NOT guarantee

- **Identity** — `--author` is free-text (defaults from git config but is
  self-asserted). Anyone can pass `--author "VP Eng"`.
- **Integrity of the sidecar itself** — it is editable plaintext; a hand-edit
  can forge or delete a record. The backstop is **git**: `git diff doc.seal.md`
  shows any tampering. Commit the sidecar with the doc.
- **Non-repudiation / append-only / signed records** — none of these. Hosted
  `seal publish` is the answer when you need them.

## Role-tailored summaries

The review page's summary is **role-aware**. Generate one digest per reviewer
role into `<doc>.seal.summary.json` (auto-loaded, committed) and the reader picks
or types their role to re-render the summary for them — client-side, zero network:

```json
{ "roles": [
  { "role": "Compliance", "lead": "the decision Compliance must make", "key_decisions": [{"label":"Sanctions","value":"..."}], "needs_attention": ["..."] }
] }
```

## Entering comments & suggestions

Two ways, both ending with the agent as writer-of-record:

1. **From the page** — in *Full doc*, select text → **💬 Comment / ✎ Suggest** →
   write → *Copy for agent* → paste into your AI console, which runs the command.
   (Static files can't POST; this copy-to-console step is the zero-server bridge.)
2. **Tell your agent directly** — "comment on the retry section: …" and it runs
   `seal-review comment …`. A suggestion (`--suggest`) records a proposed
   replacement, shown as a del→ins diff on the page.

## Notifying the owner

No push in a local file. **Commit `doc.md` + `doc.seal.md`** — the sidecar diff
is the change event; the owner sees it on `git pull` / in the PR. Optional local
nudge: install `template/hooks/post-merge`. Email/Slack push needs a server (the
hosted `seal publish`).

## Roadmap

Later: fuzzy anchor relocation, `seal watch` (auto-refresh), committed-HTML
mode, git provenance / signed-commit identity.

MIT.
