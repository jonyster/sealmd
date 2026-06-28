# sealmd — GitHub Copilot instructions

This repo is a **fully-local document review tool** (one zero-dependency Node
CLI). The canonical, tool-agnostic guide is `AGENTS.md` at the repo root — follow
it.

When the user wants to review, comment on, or suggest edits to a Markdown
document, drive the CLI:

```
node skills/seal-review/scripts/seal.mjs <command> --in <doc.md>
```

This is a Google-Docs-style local review: role-tailored summaries, anchored
comments, suggestions (propose old→new, `accept` applies the change to `doc.md`),
and resolve/reopen of comment threads. The plugin has no approval, sign-off,
quorum, or submit concept — when the document is ready, open a normal GitHub PR
(`node skills/seal-review/scripts/seal.mjs pr --in <doc.md>`) and let the team
approve, merge, or comment on it on GitHub. Seal does not track approval itself.

Key commands: `init`, `comment` (with `--anchor` / `--suggest` / `--mention`),
`accept` (applies a suggestion to `doc.md`), `resolve` / `reopen` (comment
threads), `pr` (open a GitHub PR for approval), `render --open`, and
`serve --open` for a live review server. The review state lives in a committed
`doc.seal.md` sidecar beside `doc.md`; `*.review.html` is generated and
gitignored. Local-first: the page makes no external requests; Slack/Teams/email
notifications are opt-in (off unless you set a webhook/key).

For a live interactive review, run `serve` as a background task and respond to the
`SEAL_EVENT` lines it prints (generate role summaries, share via your
integrations) — see the "live loop" section of `AGENTS.md`.
