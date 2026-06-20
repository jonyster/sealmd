---
description: Local document review — comment on and render a Markdown doc with zero network.
---

Use the **seal-review** skill to run the local review lifecycle on $ARGUMENTS
(default: the most recently edited `.md` in the working tree).

Start by checking whether a `*.seal.md` sidecar already exists:
- If not, run `init` to create it.
- If it does, run `status` to show where the review stands.

Then carry out whatever the user asked (file a comment, resolve one, render and
offer to open the review page). Never auto-open the page — offer the path and
the open command.
