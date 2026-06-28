// Change Brief = what changed in the doc since the brief was written (a baseline
// snapshot taken on `seal summary`), section-level, ranked — NOT the role digest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initWorkspace, runSeal } from './helper.mjs';

const DOC = '# Spec\n\n## Overview\n\nfirst.\n\n## Goals\n\nship it.\n\n## Risks\n\nmany.\n';

test('Change Brief lists edited/added/removed sections since the brief baseline', () => {
  const ws = initWorkspace({ content: DOC });
  try {
    // generate a brief → snapshots the baseline
    runSeal(['summary', '--in', ws.doc, '--role', 'General', '--json', JSON.stringify({ lead: 'x', key_decisions: ['k'], relevant_sections: ['Goals'], needs_attention: ['n'] })], { cwd: ws.dir });
    assert.ok(ws.exists('doc.seal.baseline.md'), 'baseline snapshot written on summary');

    // edit: modify Goals, add Rollout, remove Risks
    ws.write('doc.md', '# Spec\n\n## Overview\n\nfirst.\n\n## Goals\n\nship it FASTER.\n\n## Rollout\n\nphased.\n');
    runSeal(['render', '--in', ws.doc], { cwd: ws.dir });
    const html = ws.read('doc.review.html');

    assert.match(html, /bchg-sev high">Added/, 'added section → High');
    assert.match(html, /bchg-sev high">Removed/, 'removed section → High');
    assert.match(html, /bchg-sev med">Edited/, 'modified section → Med');
    assert.match(html, /changes since this brief/, 'header counts the changes');
  } finally { ws.cleanup(); }
});

test('no edits since the brief → "up to date"', () => {
  const ws = initWorkspace({ content: DOC });
  try {
    runSeal(['summary', '--in', ws.doc, '--role', 'General', '--json', JSON.stringify({ lead: 'x', key_decisions: ['k'], relevant_sections: ['Goals'], needs_attention: ['n'] })], { cwd: ws.dir });
    runSeal(['render', '--in', ws.doc], { cwd: ws.dir });
    assert.match(ws.read('doc.review.html'), /up to date/);
  } finally { ws.cleanup(); }
});
