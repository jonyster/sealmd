---
description: Add a role-tailored summary to a seal review (generate a summary written for a specific reviewer role).
---

**Plain language:** call `<doc>.seal.md` **"the review file"** to the user — never say "sidecar" (jargon).

The user wants a **role-tailored summary** added to a seal review. `$ARGUMENTS`
may contain the role and/or the doc path.

Do this, in order:

1. **Find the doc.** Use the `.md` path in `$ARGUMENTS` if given; else the doc
   currently under review (the most recently `init`/`serve`d `.md`, or ask).
2. **Get the role.** If `$ARGUMENTS` names a role, use it. **If not, ASK the user
   what their role is** (e.g. "Compliance", "Eng lead", "Treasury", a job title —
   anything). Do not guess.
3. **Get the jump targets.** Run `seal blocks --in <doc>` — it returns every
   heading with its `src` id (`blk-N`). You'll cite these so each summary point
   becomes a clickable jump into the Full doc. Without `src`, points render as
   plain text (no hook to the doc).
4. **Generate the summary yourself.** Read the doc and write a concise
   ~90-second digest *for that role* — lead with the decision that role must make;
   cite real specifics from the doc. Shape it as JSON:
   ```json
   { "lead": "1–2 sentences: the call this role must make",
     "key_decisions": [{ "label": "…", "value": "… (inline markdown ok)", "src": "blk-N" }],
     "relevant_sections": [{ "section": "…", "detail": "what it means for this role", "src": "blk-N" }],
     "needs_attention": ["the risks/open questions this role must judge"] }
   ```
   **ALL FOUR fields are REQUIRED and must be non-empty** — the page renders each
   as its own block (lead → "Key decisions" → "What this means for you" → "Your
   call to make"). A summary missing a field shows a blank section, which looks
   broken. In particular **`relevant_sections` is the most-skipped one**: give 3–6
   entries, each naming a real doc section (use its `§`/heading) and saying, in one
   line, what that section means *for this role specifically* (not a generic recap).
   `key_decisions` ≥ 3, `needs_attention` ≥ 2. Cite real `§`/section refs throughout.
   **Set `src` on every `key_decision` and `relevant_section`** to the `blk-N` of
   the heading it refers to (from step 3) — that's what links the point to the Full
   doc. Use the closest matching heading; omit `src` only if a point maps to no
   section.
5. **Write it** with the engine (path: `${CLAUDE_PLUGIN_ROOT}/skills/seal-review/scripts/seal.mjs`,
   or the `scripts/` dir next to the skill):
   ```bash
   seal summary --in <doc> --role "<role>" --file <tmp.json>
   ```
   (or pipe the JSON on stdin / pass `--json '<…>'`).
6. **Confirm.** Tell the user it's ready — a **live** review page (`serve`) polls
   and swaps it in on its own; a static `render` page needs a refresh.

Also run `seal pending --in <doc>` first — if the live page already requested
roles that don't exist yet, generate those too (drain the queue), then step 5.

**Old review missing jump links?** Summaries written before src was emitted
render as plain text. Run `seal backfill-src --in <doc>` once to match each
point to its heading and wire the Full-doc hooks (idempotent; never overwrites).
