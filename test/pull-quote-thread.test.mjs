// Inbound GitHub replies: a "quote reply" pastes our comment back (quoted) plus
// the new text. The pull must keep ONLY the new text and thread it under the
// parent named by the quoted seal:c=<id> marker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripGithubQuote, sealCommentRef } from '../skills/seal-review/scripts/seal.mjs';

test('stripGithubQuote keeps only the reply, drops the quoted block', () => {
  const body = [
    '> <!-- seal:c=abc -->',
    '> 🦭 **Seal review** · line 5',
    '> ',
    '> **d**: i dint get it',
    '',
    'you are wrong',
  ].join('\n');
  assert.equal(stripGithubQuote(body), 'you are wrong');
});

test('a pure quote-reply OF OUR comment (no new text) strips to empty → nothing to import', () => {
  assert.equal(stripGithubQuote('> <!-- seal:c=abc -->\n> i dint get it'), '');
});

test('a HUMAN Markdown blockquote (no seal marker) is preserved, never stripped', () => {
  // leading blockquote the reviewer typed themselves — must survive
  assert.equal(stripGithubQuote('> the spec says X\n> and Y\n\nI disagree with this'), '> the spec says X\n> and Y\n\nI disagree with this');
  // an all-blockquote human reply is kept whole
  assert.equal(stripGithubQuote('> quoting the doc here'), '> quoting the doc here');
});

test('sealCommentRef finds the parent comment id even inside a quote', () => {
  assert.equal(sealCommentRef('> <!-- seal:c=xyz789 -->\n> **d**: i dint get it\n\nyou are wrong'), 'xyz789');
  assert.equal(sealCommentRef('a plain reply with no marker'), null);
});
