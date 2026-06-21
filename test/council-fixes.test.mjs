// Regression tests for three bugs the test-case council found + verified.
// Each asserts the FIXED behavior; reverting the fix re-fails the matching test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { anchorDocLine, findRole, readBody } from '../skills/seal-review/scripts/seal.mjs';

// Bug #1: over-cap POST calls req.destroy(), which emits 'close'/'error' but
// never 'end' — so the readBody Promise must still settle (on 'close') instead
// of leaking a handler that awaits forever.
test('readBody resolves when the request closes without an end event (over-cap path)', async () => {
  const req = new EventEmitter();
  const p = readBody(req);
  req.emit('data', 'x'.repeat(10)); // partial body, then the socket dies
  req.emit('close');                // destroy() path: no 'end'
  const settled = await Promise.race([p, new Promise((r) => setTimeout(() => r('HANG'), 500))]);
  assert.notEqual(settled, 'HANG', 'readBody hung — destroy() never settled the Promise');
  assert.deepEqual(settled, {});
});

// Bug #2: an empty quote with a matching prefix used to return line 1 (the
// prefix match preceded the empty-quote guard), mis-placing inline comments.
test('anchorDocLine: empty quote returns null even when a prefix matches', () => {
  assert.equal(anchorDocLine('ab\ncd', { quote: '', prefix: 'ab' }), null);
  // sanity: a real quote still anchors
  assert.equal(anchorDocLine('ab\ncd', { quote: 'cd' }), 2);
});

// Bug #4: a summary.json entry with a blank role made n.includes('') true for
// every request, so findRole "matched" it and no role summaries ever generated.
test('findRole: a blank-role entry never matches a real requested role', () => {
  assert.equal(findRole([{ role: '' }], 'Engineering'), null);
  // a real role in the same list still matches
  assert.equal(findRole([{ role: '' }, { role: 'Engineering' }], 'Engineering').role, 'Engineering');
});
