// `seal backfill-src` adds src="blk-N" jump targets to summary points written
// before the flow emitted them, matching each point's section/label to a heading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initWorkspace, runSeal } from './helper.mjs';

test('backfill-src fills missing src on old summaries, idempotently', () => {
  const ws = initWorkspace();
  // A role summary with NO src on its points (the pre-fix shape).
  ws.write('s.json', JSON.stringify({
    lead: 'Decide.',
    key_decisions: [{ label: 'Goals', value: 'ship' }],
    relevant_sections: [{ section: '§ Risks', detail: 'watch' }, { section: 'Goals', detail: 'scope' }],
    needs_attention: ['a', 'b'],
  }));
  assert.equal(runSeal(['summary', '--in', ws.doc, '--role', 'PM', '--file', ws.dir + '/s.json'], { cwd: ws.dir }).code, 0);

  const r1 = runSeal(['backfill-src', '--in', ws.doc], { cwd: ws.dir });
  assert.equal(r1.json.filled, 3, 'matches Goals + Risks heading blks');

  // headings are blk-1 (## Goals at index 1) era — assert the points now carry blk ids
  const sum = JSON.parse(ws.read('doc.seal.summary.json'));
  const srcs = [...sum.roles[0].key_decisions, ...sum.roles[0].relevant_sections].map((o) => o.src);
  assert.ok(srcs.every((s) => /^blk-\d+$/.test(s)), 'every point got a blk-N src');

  // idempotent: nothing left to fill
  assert.equal(runSeal(['backfill-src', '--in', ws.doc], { cwd: ws.dir }).json.filled, 0);
  ws.cleanup();
});

test('backfill-src on a doc with no summary is a clean no-op', () => {
  const ws = initWorkspace();
  const r = runSeal(['backfill-src', '--in', ws.doc], { cwd: ws.dir });
  assert.equal(r.code, 0);
  assert.equal(r.json.filled, 0);
  assert.equal(r.json.roles, 0);
  ws.cleanup();
});
