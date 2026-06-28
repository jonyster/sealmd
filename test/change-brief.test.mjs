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

    assert.match(html, /bchg-sev high">Added · High/, 'added section → High');
    assert.match(html, /bchg-sev high">Removed · High/, 'removed section → High');
    assert.match(html, /bchg-sev (low|med)">Edited/, 'modified section → Med/Low by size');
    assert.match(html, /<span class="bchg-old">ship it\.<\/span> <span class="bchg-new">ship it FASTER\.<\/span>/, 'before → after delta');
    assert.match(html, /class="bchg [a-z]+ hassrc" data-src="blk-\d+"/, 'item links to the section in the Full doc');
    assert.match(html, /changes since this brief/, 'header counts the changes');
  } finally { ws.cleanup(); }
});

test('whitespace/blank-only edit does NOT produce a phantom change card', () => {
  const ws = initWorkspace({ content: DOC });
  try {
    runSeal(['summary', '--in', ws.doc, '--role', 'General', '--json', JSON.stringify({ lead: 'x', key_decisions: ['k'], relevant_sections: ['Goals'], needs_attention: ['n'] })], { cwd: ws.dir });
    // same content, extra blank lines + trailing spaces inside a section
    ws.write('doc.md', '# Spec\n\n## Overview\n\nfirst.\n\n## Goals\n\nship it.   \n\n\n## Risks\n\nmany.\n');
    runSeal(['render', '--in', ws.doc], { cwd: ws.dir });
    const html = ws.read('doc.review.html');
    assert.doesNotMatch(html, /class="bchg /, 'no change cards for whitespace-only edits');
    assert.match(html, /up to date/);
  } finally { ws.cleanup(); }
});

test('duplicate headings: editing one section does not falsely flag the namesake', () => {
  const dup = '# D\n\n## Notes\n\nfirst notes.\n\n## Intro\n\nintro body.\n\n## Notes\n\nsecond notes.\n';
  const ws = initWorkspace({ content: dup });
  try {
    runSeal(['summary', '--in', ws.doc, '--role', 'General', '--json', JSON.stringify({ lead: 'x', key_decisions: ['k'], relevant_sections: ['Intro'], needs_attention: ['n'] })], { cwd: ws.dir });
    // edit ONLY Intro; both "Notes" sections unchanged
    ws.write('doc.md', '# D\n\n## Notes\n\nfirst notes.\n\n## Intro\n\nintro body EDITED.\n\n## Notes\n\nsecond notes.\n');
    runSeal(['render', '--in', ws.doc], { cwd: ws.dir });
    const html = ws.read('doc.review.html');
    assert.match(html, /bchg-h">Intro/, 'Intro shows as edited');
    assert.doesNotMatch(html, /bchg-h">Notes/, 'neither Notes section is falsely flagged');
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
