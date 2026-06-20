#!/usr/bin/env bash
# Non-plugin fallback: symlink the seal-review skill into ~/.claude/skills so it
# works without installing via /plugin. Idempotent.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dest="${HOME}/.claude/skills/seal-review"
mkdir -p "${HOME}/.claude/skills"
rm -f "${dest}"
ln -s "${here}/skills/seal-review" "${dest}"
echo "linked ${dest} -> ${here}/skills/seal-review"
echo "run:  node \"${here}/skills/seal-review/scripts/seal.mjs\" --help"
