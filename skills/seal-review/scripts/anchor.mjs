// ============================================================================
// seal-local — vendored normalization + content hash.
// DO NOT EDIT. Parity-frozen copy of packages/anchor/index.js (normalize +
// hash region) and skill/seal/scripts/render.mjs `normalizeMarkdownV1`.
// normalization_version = 1. The content_hash binds to THIS exact output, and
// a parity test asserts byte-identical results against @seal/anchor. ANY drift
// here is a Sev-1. Returns BARE hex (no "sha256:" prefix) — matches the hosted
// product and the prior-art renderer.
// ============================================================================
import { createHash } from 'node:crypto';

export function normalizeMarkdown(raw) {
  if (typeof raw !== 'string') throw new TypeError('normalizeMarkdown expects a string');
  let s = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;        // 1. strip one BOM
  s = s.replace(/\r\n?/g, '\n');                                    // 2. CRLF/CR -> LF
  let lines = s.split('\n').map((l) => l.replace(/[ \t]+$/, ''));   // 3. trim trailing ws
  const collapsed = [];                                            // 4. collapse blank runs
  let prevBlank = false;
  for (const l of lines) {
    const blank = l === '';
    if (blank && prevBlank) continue;
    collapsed.push(l);
    prevBlank = blank;
  }
  lines = collapsed;
  while (lines.length && lines[0] === '') lines.shift();            // 5. trim leading blanks
  while (lines.length && lines[lines.length - 1] === '') lines.pop();   //    & trailing
  return lines.join('\n');
}

export function sha256Hex(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

// content_hash = sha256 of the normalized markdown (BARE hex).
export function contentHash(raw) {
  return sha256Hex(normalizeMarkdown(raw));
}
