---
description: Open an EXISTING local document review — no setup questions, just opens the live page.
---

Open the existing review for the `.md` in `$ARGUMENTS` (or the doc the user means
— most recently edited `.md`, or ask). Engine:
`node "${CLAUDE_PLUGIN_ROOT}/skills/seal-review/scripts/seal.mjs"` (call it `seal`).

- Run **`seal start DOC`** as a **background task** and give the user the
  `http://127.0.0.1:…` URL. No questions.
- While it's open, watch for `summary_request` events (or run `seal pending --in
  DOC`) and generate any role the user types — or they hit the page's **Copy
  `/seal-role`** button.
- If `<DOC>.seal.md` doesn't exist yet, say there's no review to open and offer
  **`/seal-new DOC`**.
