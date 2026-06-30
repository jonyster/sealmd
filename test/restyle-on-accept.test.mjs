// Phase-2 style preservation: an accepted suggestion adopts the document's own
// Markdown style (bullet marker, fence char) so the edit doesn't churn formatting
// on the line under review. Unit coverage of restyleToDoc + a black-box accept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initWorkspace, runSeal } from './helper.mjs';
import { restyleToDoc } from '../skills/seal-review/scripts/seal.mjs';

const DASH_DOC = `# Plan

## Items
- alpha
- beta

## Section
Replace this line here.
`;

test('restyleToDoc rewrites bullet markers to the doc dominant', () => {
  assert.equal(restyleToDoc('* gamma\n* delta', DASH_DOC), '- gamma\n- delta');
  assert.equal(restyleToDoc('+ one\n- two', DASH_DOC), '- one\n- two');
});

test('restyleToDoc leaves inline emphasis and thematic breaks alone', () => {
  // `*word*` is emphasis (no space after the marker), not a list bullet.
  assert.equal(restyleToDoc('see *this* and **that**', DASH_DOC), 'see *this* and **that**');
  // `* * *` is a thematic break, not a bullet.
  assert.equal(restyleToDoc('* * *', DASH_DOC), '* * *');
});

test('restyleToDoc never touches code-block interiors', () => {
  const snippet = '```\n* not a bullet, it is code\n```';
  // Doc dominant fence is backtick (no fences in DASH_DOC → backtick default), so the
  // fence stays ``` and the interior `* ...` line is left verbatim.
  assert.equal(restyleToDoc(snippet, DASH_DOC), snippet);
});

test('restyleToDoc matches the doc dominant fence char', () => {
  const tildeDoc = '# D\n\n~~~js\ncode();\n~~~\n\n~~~py\nx=1\n~~~\n';
  // Snippet uses ``` fences; doc prefers ~~~ → rewrite the markers, keep the body.
  assert.equal(restyleToDoc('```\nhi\n```', tildeDoc), '~~~\nhi\n~~~');
});

test('restyleToDoc is a no-op for plain inline text', () => {
  assert.equal(restyleToDoc('Redis for caching', DASH_DOC), 'Redis for caching');
});

test('accept restyles the suggestion to the doc style before splicing', () => {
  const ws = initWorkspace({ content: DASH_DOC });
  const c = runSeal(['comment', '--in', ws.doc, '--body', 'use these items',
    '--anchor', 'Replace this line here.', '--suggest', '* gamma\n* delta', '--no-render'], { cwd: ws.dir });
  assert.ok(c.json?.id, `suggestion filed: ${c.stderr}`);
  const a = runSeal(['accept', '--in', ws.doc, '--id', c.json.id, '--no-render'], { cwd: ws.dir });
  assert.equal(a.code, 0, `accept ok: ${a.stderr}`);
  const doc = readFileSync(ws.doc, 'utf8');
  assert.ok(doc.includes('- gamma') && doc.includes('- delta'), 'inserted bullets match the doc `-` style');
  assert.ok(!doc.includes('* gamma'), 'no foreign `*` bullet smuggled in');
});
