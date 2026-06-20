# sealmd — GitHub Copilot instructions

This repo is a **fully-local document review tool** (one zero-dependency Node
CLI). The canonical, tool-agnostic guide is `AGENTS.md` at the repo root — follow
it.

When the user wants to review, comment on, suggest edits to, or approve a Markdown
document, drive the CLI:

```
node skills/seal-review/scripts/seal.mjs <command> --in <doc.md>
```

Key commands: `init`, `comment` (with `--anchor` / `--suggest` / `--mention`),
`accept` (applies a suggestion to `doc.md`), `dismiss`, `submit`, `approve`,
`render --open`, and `serve --open` for a live review server. The review state
lives in a committed `doc.seal.md` sidecar beside `doc.md`; `*.review.html` is
generated and gitignored. Local-first: the page makes no external requests; Slack/Teams/email notifications are opt-in (off unless you set a webhook/key).

For a live interactive review, run `serve` as a background task and respond to the
`SEAL_EVENT` lines it prints (generate role summaries, share via your
integrations) — see the "live loop" section of `AGENTS.md`.
