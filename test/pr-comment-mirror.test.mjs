// Unit tests for the pure parsers behind the GitHub PR comment mirror
// (corePostReviewComments). The network path needs gh + a real PR, so we test
// the two deterministic helpers it depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anchorDocLine, changedRightLines } from '../skills/seal-review/scripts/seal.mjs';

const DOC = '# Title\n\nThe quick brown fox.\nThe quick red fox.\nDone.\n';
//           line1     (2 blank) line3                line4              line5

test('anchorDocLine: bare quote returns its 1-based line', () => {
  assert.equal(anchorDocLine(DOC, { quote: 'brown fox' }), 3);
  assert.equal(anchorDocLine(DOC, { quote: 'Done.' }), 5);
});

test('anchorDocLine: prefix disambiguates a repeated quote', () => {
  // "fox" appears on both line 3 and 4; prefix picks the second.
  assert.equal(anchorDocLine(DOC, { quote: 'fox', prefix: 'The quick red ' }), 4);
  assert.equal(anchorDocLine(DOC, { quote: 'fox', prefix: 'The quick brown ' }), 3);
});

test('anchorDocLine: falls back to bare quote when prefix misses', () => {
  // prefix+quote not found together → first bare "fox" (line 3).
  assert.equal(anchorDocLine(DOC, { quote: 'fox', prefix: 'NOPE ' }), 3);
});

test('anchorDocLine: returns null when quote is absent or empty', () => {
  assert.equal(anchorDocLine(DOC, { quote: 'unicorn' }), null);
  assert.equal(anchorDocLine(DOC, {}), null);
});

test('changedRightLines: expands hunk headers into right-side line numbers', () => {
  const G = () => [
    'diff --git a/x.md b/x.md',
    '@@ -0,0 +1,3 @@',  // added file: lines 1,2,3
    '@@ -10 +20 @@',     // single line, no count: line 20
  ].join('\n');
  const set = changedRightLines(G, 'base', 'head', 'x.md');
  assert.deepEqual([...set].sort((a, b) => a - b), [1, 2, 3, 20]);
});

test('changedRightLines: a git failure yields an empty set (→ summary fallback)', () => {
  const G = () => { throw new Error('not a git repo'); };
  assert.equal(changedRightLines(G, 'base', 'head', 'x.md').size, 0);
});
