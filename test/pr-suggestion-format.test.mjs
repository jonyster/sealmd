// Mirrored review-comment bodies: inline suggestions become NATIVE GitHub
// ```suggestion blocks (one-click "Commit suggestion"); the summary path and
// fence-containing replacements degrade to plain text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatReviewComment } from '../skills/seal-review/scripts/seal.mjs';

test('inline suggestion → native ```suggestion block', () => {
  const body = formatReviewComment({ author: 'jo', body: 'tighten this', suggestion: 'New line text' }, { native: true });
  assert.match(body, /```suggestion\nNew line text\n```/, 'emits a committable suggestion block');
  assert.match(body, /\*\*jo\*\*: tighten this/, 'keeps author + comment');
  assert.ok(!body.includes('_Suggested:_'), 'no plain-text fallback when native');
});

test('summary (non-inline) suggestion → plain text, not a block', () => {
  const body = formatReviewComment({ body: 'fix', suggestion: 'x' }, { native: false });
  assert.match(body, /_Suggested:_ `x`/);
  assert.ok(!body.includes('```suggestion'), 'no native block off the diff');
});

test('a ``` in the replacement falls back to plain text (would break the block)', () => {
  const body = formatReviewComment({ body: 'c', suggestion: 'has ``` fence' }, { native: true });
  assert.ok(!body.includes('```suggestion'), 'unsafe replacement is not fenced');
  assert.match(body, /_Suggested:_/);
});

test('no suggestion → just author + body + thread', () => {
  const body = formatReviewComment({ author: 'a', body: 'hi', thread: [{ author: 'b', body: 'reply' }] }, { native: true });
  assert.equal(body, '**a**: hi\n\n↳ **b**: reply');
});
