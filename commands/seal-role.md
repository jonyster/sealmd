---
description: Add a role-tailored summary to a seal review (generate a summary written for a specific reviewer role).
---

The user wants a **role-tailored summary** added to a seal review. `$ARGUMENTS`
may contain the role and/or the doc path.

Do this, in order:

1. **Find the doc.** Use the `.md` path in `$ARGUMENTS` if given; else the doc
   currently under review (the most recently `init`/`serve`d `.md`, or ask).
2. **Get the role.** If `$ARGUMENTS` names a role, use it. **If not, ASK the user
   what their role is** (e.g. "Compliance", "Eng lead", "Treasury", a job title —
   anything). Do not guess.
3. **Generate the summary yourself.** Read the doc and write a concise
   ~90-second digest *for that role* — lead with the decision that role must make;
   cite real specifics from the doc. Shape it as JSON:
   ```json
   { "lead": "1–2 sentences: the call this role must make",
     "key_decisions": [{ "label": "…", "value": "… (inline markdown ok)" }],
     "relevant_sections": [{ "section": "…", "detail": "what it means for this role" }],
     "needs_attention": ["the risks/open questions this role must judge"] }
   ```
4. **Write it** with the engine (path: `${CLAUDE_PLUGIN_ROOT}/skills/seal-review/scripts/seal.mjs`,
   or the `scripts/` dir next to the skill):
   ```bash
   seal summary --in <doc> --role "<role>" --file <tmp.json>
   ```
   (or pipe the JSON on stdin / pass `--json '<…>'`).
5. **Confirm.** Tell the user it's ready — a **live** review page (`serve`) polls
   and swaps it in on its own; a static `render` page needs a refresh.

Also run `seal pending --in <doc>` first — if the live page already requested
roles that don't exist yet, generate those too (drain the queue), then step 5.
