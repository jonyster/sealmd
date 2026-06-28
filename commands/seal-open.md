---
description: Open an EXISTING local document review — no setup questions, just opens the live page.
---

**Plain language:** call `<doc>.seal.md` **"the review file"** to the user — never say "sidecar" (jargon).

Open the existing review for a doc. Engine:
`node "${CLAUDE_PLUGIN_ROOT}/skills/seal-review/scripts/seal.mjs"` (call it `seal`).

**Pick the doc — ALWAYS show an options menu (`AskUserQuestion`); never just
yes/no-confirm one guess.** If `$ARGUMENTS` has a `.md` path or git URL, use it;
otherwise present (4 slots + auto "Other"; **always reserve "Git link / URL" and
"Browse local files"**):
- **Docs that already have a review** (≤2) — glob `*.seal.md` and list the matching
  `.md` docs (the openable ones).
- **"Git link / URL"** (always) — paste a repo URL; `git clone` it and open the
  review inside the clone.
- **"Browse local files"** (always) — list/`ls` `*.seal.md` reviews to navigate, or
  accept a typed path.
- **"Other"** → type a path directly.
Call the chosen doc `DOC`.

- Run **`seal start DOC`** as a **background task** and give the user the
  `http://127.0.0.1:…` URL. No questions. **Open the LIVE server — never a static
  `*.review.html`.** This is the sealmd plugin, NOT the hosted "seal" skill; don't
  use any tool that mentions `seal publish` / `SEAL_API_TOKEN`.
- While it's open, watch for `summary_request` events (or run `seal pending --in
  DOC`) and generate any role the user types — or they hit the page's **Copy
  `/seal-role`** button.
- If `<DOC>.seal.md` doesn't exist yet, say there's no review to open and offer
  **`/seal-new DOC`**.
- In a git repo, after a batch of comments/suggestions (or when they're done), run
  **`seal commit DOC --push`** (stages doc + review file + summaries, commits,
  pushes) — that's how others see the latest review.
- **Approval is the user's normal GitHub PR**, not a Seal feature: once the review
  is committed/pushed, run **`seal pr DOC`** to open a PR and let the team
  approve/merge or comment on it on GitHub. The plugin does not track approval,
  sign-off, or quorum itself.
