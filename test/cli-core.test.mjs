// ============================================================================
// Black-box CLI tests for seal.mjs via runSeal(). Covers init, comment/anchor,
// reply, resolve/reopen, doctor, hash, title/owner derivation, fail-loud on
// corrupted sidecars, and HTML regeneration.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { makeWorkspace, runSeal, initWorkspace, SAMPLE_DOC, SEAL } from './helper.mjs';
import { contentHash } from '../skills/seal-review/scripts/anchor.mjs';

// ---- local helpers ---------------------------------------------------------
// Read the parsed sidecar records by running `doctor --json` and re-reading raw.
function readSidecarRaw(ws) { return readFileSync(ws.sidecar, 'utf8'); }
// Pull the seal:state JSON record out of the raw sidecar text.
function stateRecord(raw) {
  const m = raw.match(/```json seal:state\n([\s\S]*?)\n```/);
  return m ? JSON.parse(m[1]) : null;
}
function documentRecord(raw) {
  const m = raw.match(/```json seal:document\n([\s\S]*?)\n```/);
  return m ? JSON.parse(m[1]) : null;
}
function commentRecords(raw) {
  const re = /```json seal:comment\n([\s\S]*?)\n```/g;
  const out = []; let m;
  while ((m = re.exec(raw)) !== null) out.push(JSON.parse(m[1]));
  return out;
}

// ---- init ------------------------------------------------------------------
test('init creates a sidecar with document + draft state, prints content_hash, updates .gitignore', () => {
  const ws = makeWorkspace({ git: true });
  try {
    const res = runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(ws.exists('doc.seal.md'), 'sidecar created');

    const raw = readSidecarRaw(ws);
    const doc = documentRecord(raw);
    const state = stateRecord(raw);
    assert.ok(doc, 'has seal:document record');
    assert.equal(doc.kind, 'document');
    assert.equal(state.kind, 'state');
    assert.equal(state.status, 'draft', 'initial state is draft');

    // printed content_hash equals the doc's normalized content hash
    const expected = contentHash(SAMPLE_DOC);
    assert.equal(res.json.content_hash, expected, 'init prints content_hash');
    assert.equal(state.content_hash, expected, 'state pins the same hash');

    // .gitignore got the three derived/secret patterns appended
    const gi = ws.read('.gitignore');
    for (const pat of ['*.review.html', '*.seal.notify.json', '*.seal.requests.jsonl']) {
      assert.ok(gi.split('\n').map((l) => l.trim()).includes(pat), `gitignore has ${pat}`);
    }
  } finally { ws.cleanup(); }
});

test('init twice without --force exits non-zero with "already exists"', () => {
  const ws = makeWorkspace({ git: true });
  try {
    const first = runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    assert.equal(first.code, 0, first.stderr);
    const second = runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    assert.notEqual(second.code, 0, 'second init must fail');
    assert.match(second.stderr, /already exists/i);
  } finally { ws.cleanup(); }
});

test('init --force overwrites an existing sidecar', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    // mutate so we can tell it was rewritten: append a comment first
    runSeal(['comment', '--in', ws.doc, '--body', 'hi', '--no-render'], { cwd: ws.dir });
    assert.equal(commentRecords(readSidecarRaw(ws)).length, 1);

    const forced = runSeal(['init', '--in', ws.doc, '--force', '--no-render'], { cwd: ws.dir });
    assert.equal(forced.code, 0, forced.stderr);
    // force re-creates fresh => no comments
    assert.equal(commentRecords(readSidecarRaw(ws)).length, 0, 'force resets comments');
  } finally { ws.cleanup(); }
});

// ---- title & owner derivation ---------------------------------------------
test('title is derived from the first H1 when --title is not given', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    assert.equal(documentRecord(readSidecarRaw(ws)).title, 'Sample PRD');
  } finally { ws.cleanup(); }
});

test('--title overrides the H1-derived title', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--title', 'Custom Title', '--no-render'], { cwd: ws.dir });
    assert.equal(documentRecord(readSidecarRaw(ws)).title, 'Custom Title');
  } finally { ws.cleanup(); }
});

test('owner comes from git user.name when no --owner and no Author line', () => {
  const ws = makeWorkspace({ git: true });
  try {
    const res = runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    assert.equal(res.json.owner, 'Test User');
    assert.equal(res.json.owner_source, 'git');
    assert.equal(documentRecord(readSidecarRaw(ws)).owner, 'Test User');
  } finally { ws.cleanup(); }
});

test('owner comes from the doc Author line, overriding git user', () => {
  const content = `# Spec\n\nAuthor: Jane Doe\n\n## Body\nSome content with enough words to exist here.\n`;
  const ws = makeWorkspace({ git: true, content });
  try {
    const res = runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    assert.equal(res.json.owner, 'Jane Doe');
    assert.equal(res.json.owner_source, 'doc');
  } finally { ws.cleanup(); }
});

test('--owner overrides both the doc Author line and git', () => {
  const content = `# Spec\n\nAuthor: Jane Doe\n\n## Body\nSome content here.\n`;
  const ws = makeWorkspace({ git: true, content });
  try {
    const res = runSeal(['init', '--in', ws.doc, '--owner', 'Explicit Owner', '--no-render'], { cwd: ws.dir });
    assert.equal(res.json.owner, 'Explicit Owner');
    assert.equal(res.json.owner_source, 'flag');
  } finally { ws.cleanup(); }
});

// ---- hash ------------------------------------------------------------------
test('hash prints a bare-hex hash equal to contentHash of the doc', () => {
  const ws = makeWorkspace({ git: false });
  try {
    const res = runSeal(['hash', '--in', ws.doc], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    const h = res.json.content_hash;
    assert.match(h, /^[0-9a-f]{64}$/, 'bare 64-char hex, no prefix');
    assert.equal(h, contentHash(SAMPLE_DOC));
  } finally { ws.cleanup(); }
});

// ---- comment ---------------------------------------------------------------
test('comment --body adds an open comment reflected in status', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    const res = runSeal(['comment', '--in', ws.doc, '--body', 'looks good', '--no-render'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.anchored, false, 'doc-level comment is not anchored');

    const st = runSeal(['status', '--in', ws.doc, '--json'], { cwd: ws.dir });
    assert.equal(st.json.comments.total, 1);
    assert.equal(st.json.comments.open, 1);
  } finally { ws.cleanup(); }
});

test('comment --anchor on an exact span anchors it; status shows anchored (here)', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    const span = 'The primary goal is to ship a fully local review tool';
    const res = runSeal(['comment', '--in', ws.doc, '--body', 'anchor me', '--anchor', span, '--no-render'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.anchored, true);

    const cm = commentRecords(readSidecarRaw(ws))[0];
    assert.ok(cm.anchor, 'comment has an anchor');
    assert.equal(cm.anchor.quote, span);

    const st = runSeal(['status', '--in', ws.doc, '--json'], { cwd: ws.dir });
    assert.equal(st.json.unanchored_comments, 0, 'anchor resolves to here, not lost');
  } finally { ws.cleanup(); }
});

test('comment --anchor whose text is NOT in the doc exits non-zero with a clear message', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    const res = runSeal(['comment', '--in', ws.doc, '--body', 'x', '--anchor', 'this text does not appear anywhere', '--no-render'], { cwd: ws.dir });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /not found|exact span/i);
    // sidecar must not have gained a comment
    assert.equal(commentRecords(readSidecarRaw(ws)).length, 0);
  } finally { ws.cleanup(); }
});

// ---- reply / resolve / reopen ---------------------------------------------
test('reply --id appends to the comment thread', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    const c = runSeal(['comment', '--in', ws.doc, '--body', 'parent', '--no-render'], { cwd: ws.dir });
    const id = c.json.id;
    const r = runSeal(['reply', '--in', ws.doc, '--id', id, '--body', 'a reply', '--no-render'], { cwd: ws.dir });
    assert.equal(r.code, 0, r.stderr);

    const cm = commentRecords(readSidecarRaw(ws))[0];
    assert.equal(cm.thread.length, 1);
    assert.equal(cm.thread[0].body, 'a reply');
  } finally { ws.cleanup(); }
});

test('resolve then reopen flip the comment status', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    const c = runSeal(['comment', '--in', ws.doc, '--body', 'flip me', '--no-render'], { cwd: ws.dir });
    const id = c.json.id;

    runSeal(['resolve', '--in', ws.doc, '--id', id, '--no-render'], { cwd: ws.dir });
    assert.equal(commentRecords(readSidecarRaw(ws))[0].status, 'resolved');
    let st = runSeal(['status', '--in', ws.doc, '--json'], { cwd: ws.dir });
    assert.equal(st.json.comments.open, 0);

    runSeal(['reopen', '--in', ws.doc, '--id', id, '--no-render'], { cwd: ws.dir });
    assert.equal(commentRecords(readSidecarRaw(ws))[0].status, 'open');
    st = runSeal(['status', '--in', ws.doc, '--json'], { cwd: ws.dir });
    assert.equal(st.json.comments.open, 1);
  } finally { ws.cleanup(); }
});

test('reply to a non-existent id fails loud', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    const r = runSeal(['reply', '--in', ws.doc, '--id', 'c_nope_zzzz', '--body', 'x', '--no-render'], { cwd: ws.dir });
    assert.notEqual(r.code, 0);
    assert.match(r.stderr, /no comment with id/i);
  } finally { ws.cleanup(); }
});

// ---- doctor (healthy) ------------------------------------------------------
test('doctor on a healthy sidecar exits 0', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    const res = runSeal(['doctor', '--in', ws.doc, '--json'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.valid, true);
  } finally { ws.cleanup(); }
});

// ---- doctor / mutations on CORRUPTED sidecars (FAIL LOUD, no overwrite) ----
// Snapshot the sidecar, run a command that should refuse, assert non-zero +
// 'Refusing to' and that the sidecar file is byte-identical afterward.
function assertRefusesAndPreserves(ws, args, { matchExtra } = {}) {
  const before = readSidecarRaw(ws);
  const res = runSeal(args, { cwd: ws.dir });
  assert.notEqual(res.code, 0, `expected non-zero exit for ${args.join(' ')}`);
  assert.match(res.stderr + res.stdout, /Refusing to/i, 'must say "Refusing to"');
  if (matchExtra) assert.match(res.stderr + res.stdout, matchExtra);
  const after = readSidecarRaw(ws);
  assert.equal(after, before, 'corrupted sidecar must be left untouched');
  return res;
}

test('corrupted sidecar: invalid JSON inside a record fails loud and is not overwritten', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    // break the state record JSON
    let raw = readSidecarRaw(ws);
    raw = raw.replace(/```json seal:state\n[\s\S]*?\n```/, '```json seal:state\n{not valid json,,}\n```');
    writeFileSync(ws.sidecar, raw, 'utf8');

    assertRefusesAndPreserves(ws, ['comment', '--in', ws.doc, '--body', 'x', '--no-render']);
    // doctor should also fail loud (read-only path)
    const d = runSeal(['doctor', '--in', ws.doc, '--json'], { cwd: ws.dir });
    assert.notEqual(d.code, 0);
    assert.match(d.stderr, /not valid JSON|Refusing to/i);
  } finally { ws.cleanup(); }
});

test('corrupted sidecar: fence label != kind mismatch fails loud and is not overwritten', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    let raw = readSidecarRaw(ws);
    // relabel the document fence as "state" while keeping kind:"document" inside
    raw = raw.replace('```json seal:document\n', '```json seal:state\n');
    writeFileSync(ws.sidecar, raw, 'utf8');
    assertRefusesAndPreserves(ws, ['doctor', '--in', ws.doc, '--json'], { matchExtra: /!= kind|label/i });
  } finally { ws.cleanup(); }
});

test('corrupted sidecar: duplicate comment id fails loud and is not overwritten', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    runSeal(['comment', '--in', ws.doc, '--body', 'first', '--no-render'], { cwd: ws.dir });
    // duplicate the single comment record verbatim -> same id twice
    let raw = readSidecarRaw(ws);
    const m = raw.match(/```json seal:comment\n[\s\S]*?\n```/);
    assert.ok(m, 'has a comment block to duplicate');
    raw = raw.replace(m[0], m[0] + '\n\n' + m[0]);
    writeFileSync(ws.sidecar, raw, 'utf8');
    assertRefusesAndPreserves(ws, ['doctor', '--in', ws.doc, '--json'], { matchExtra: /duplicate/i });
  } finally { ws.cleanup(); }
});

test('corrupted sidecar: removed records-region guard fails loud and is not overwritten', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    let raw = readSidecarRaw(ws);
    raw = raw.replace('<!-- seal:records:begin -->', '');
    writeFileSync(ws.sidecar, raw, 'utf8');
    const res = assertRefusesAndPreserves(ws, ['comment', '--in', ws.doc, '--body', 'x', '--no-render']);
    assert.match(res.stderr, /records region/i);
  } finally { ws.cleanup(); }
});

// ---- HTML regeneration -----------------------------------------------------
test('a normal mutation regenerates the .review.html (escaped, self-contained)', () => {
  const ws = makeWorkspace({ git: true });
  try {
    // init WITHOUT --no-render so the html is produced
    const res = runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(ws.exists('doc.review.html'), 'init rendered the html');
    const html = ws.read('doc.review.html');
    assert.match(html, /<html|<!doctype/i, 'looks like an HTML doc');

    // a comment with HTML-ish body should regenerate and escape it
    const xss = '<script>alert(1)</script>';
    const c = runSeal(['comment', '--in', ws.doc, '--body', xss], { cwd: ws.dir });
    assert.equal(c.code, 0, c.stderr);
    const html2 = ws.read('doc.review.html');
    assert.ok(!html2.includes('<script>alert(1)</script>'), 'raw script tag must be escaped in output');
    assert.match(html2, /&lt;script&gt;/, 'angle brackets escaped');
  } finally { ws.cleanup(); }
});

// ---- missing doc / sidecar fail-loud --------------------------------------
test('command on a doc with no sidecar tells you to run init', () => {
  const ws = makeWorkspace({ git: false });
  try {
    const res = runSeal(['status', '--in', ws.doc, '--json'], { cwd: ws.dir });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /no sidecar|seal init/i);
  } finally { ws.cleanup(); }
});

test('init on a non-existent doc fails loud', () => {
  const ws = makeWorkspace({ git: false });
  try {
    const res = runSeal(['init', '--in', ws.dir + '/nope.md', '--no-render'], { cwd: ws.dir });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /not found/i);
  } finally { ws.cleanup(); }
});

// ---- idempotency: status is read-only -------------------------------------
test('status does not mutate the sidecar', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    const before = readSidecarRaw(ws);
    runSeal(['status', '--in', ws.doc, '--json'], { cwd: ws.dir });
    runSeal(['hash', '--in', ws.doc], { cwd: ws.dir });
    runSeal(['doctor', '--in', ws.doc, '--json'], { cwd: ws.dir });
    assert.equal(readSidecarRaw(ws), before, 'read-only commands leave the sidecar untouched');
  } finally { ws.cleanup(); }
});

// ---- unicode / CRLF doc -----------------------------------------------------
test('init handles a CRLF + unicode doc; hash matches normalized content', () => {
  const content = '# Tîtle ünicode 🚀\r\n\r\nBödy with CRLF line endings and emoji 🎯.\r\n';
  const ws = makeWorkspace({ git: true, content });
  try {
    const res = runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.content_hash, contentHash(content));
    assert.equal(documentRecord(readSidecarRaw(ws)).title, 'Tîtle ünicode 🚀');
  } finally { ws.cleanup(); }
});

// ===========================================================================
// APPENDED (hardening): commit, --no-render suppression, --sidecar override,
// positional doc resolution, unknown-command/missing-arg usage, owner 'none',
// and the two untested parseSidecar branches.
// ===========================================================================
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Read a comment record block out of the raw sidecar so we can corrupt it.
function firstCommentBlock(raw) {
  const m = raw.match(/```json seal:comment\n[\s\S]*?\n```/);
  return m ? m[0] : null;
}

// ---- commit (coreCommit) ---------------------------------------------------
test('commit in a git repo stages doc + sidecar and commits with --message', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    const res = runSeal(['commit', '--in', ws.doc, '--message', 'review pass 1'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.committed, true, 'first commit actually commits');
    assert.equal(res.json.message, 'review pass 1');
    assert.equal(res.json.note, null, 'note is null when something was committed');
    // committable files are the doc + the sidecar; derived html is never staged
    assert.ok(res.json.files.includes('doc.md'));
    assert.ok(res.json.files.includes('doc.seal.md'));
    // the commit really landed in git history
    const log = execSync('git log --oneline', { cwd: ws.dir, encoding: 'utf8' });
    assert.match(log, /review pass 1/);
  } finally { ws.cleanup(); }
});

test('commit -m sets the commit message (alias of --message)', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    const res = runSeal(['commit', '--in', ws.doc, '-m', 'via dash-m'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.committed, true);
    assert.equal(res.json.message, 'via dash-m');
  } finally { ws.cleanup(); }
});

test('commit with no changes since last commit -> committed:false + "nothing to commit" note', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    const first = runSeal(['commit', '--in', ws.doc, '-m', 'initial'], { cwd: ws.dir });
    assert.equal(first.json.committed, true, first.stderr);
    // immediately commit again with nothing changed
    const second = runSeal(['commit', '--in', ws.doc], { cwd: ws.dir });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.json.committed, false, 'nothing to commit');
    assert.equal(second.json.message, null);
    assert.match(second.json.note, /nothing to commit/i);
  } finally { ws.cleanup(); }
});

test('commit --push with no remote surfaces a push_error but still reports the commit', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    runSeal(['commit', '--in', ws.doc, '-m', 'base'], { cwd: ws.dir });
    // make a real change so there is something to commit, then push (no origin)
    writeFileSync(ws.doc, SAMPLE_DOC + '\n## Extra\nmore words here for a change.\n', 'utf8');
    const res = runSeal(['commit', '--in', ws.doc, '--push', '-m', 'with push'], { cwd: ws.dir });
    assert.equal(res.code, 0, 'a failed push must NOT make commit exit non-zero');
    assert.equal(res.json.committed, true);
    assert.equal(res.json.pushed, false);
    assert.ok(res.json.push_error, 'push_error is surfaced');
    assert.match(res.json.push_error, /push/i);
  } finally { ws.cleanup(); }
});

test('commit in a NON-git repo fails loud with "not a git repo"', () => {
  const ws = makeWorkspace({ git: false });
  try {
    // init works fine without git; the sidecar exists, only commit should refuse
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    const res = runSeal(['commit', '--in', ws.doc], { cwd: ws.dir });
    assert.notEqual(res.code, 0, 'commit must fail in a non-git dir');
    assert.match(res.stderr, /not a git repo/i);
  } finally { ws.cleanup(); }
});

// ---- --no-render actually suppresses html ---------------------------------
test('--no-render suppresses html on init AND on a later mutation', () => {
  const ws = makeWorkspace({ git: true });
  try {
    const i = runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    assert.equal(i.code, 0, i.stderr);
    assert.equal(ws.exists('doc.review.html'), false, 'init --no-render must NOT write the html');
    assert.equal(i.json.html, null, 'json reports html:null when suppressed');

    const c = runSeal(['comment', '--in', ws.doc, '--body', 'x', '--no-render'], { cwd: ws.dir });
    assert.equal(c.code, 0, c.stderr);
    assert.equal(ws.exists('doc.review.html'), false, 'mutation --no-render must NOT create the html');
    assert.equal(c.json.html, null);
  } finally { ws.cleanup(); }
});

test('--no-render on a mutation does NOT update an already-existing html', () => {
  const ws = makeWorkspace({ git: true });
  try {
    // render once so the html exists
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    assert.ok(ws.exists('doc.review.html'), 'baseline html exists');
    const mtimeBefore = statSync(join(ws.dir, 'doc.review.html')).mtimeMs;
    const bytesBefore = ws.read('doc.review.html');
    // now mutate WITH --no-render: the existing html must be left byte-identical
    const c = runSeal(['comment', '--in', ws.doc, '--body', 'should not touch html', '--no-render'], { cwd: ws.dir });
    assert.equal(c.code, 0, c.stderr);
    assert.equal(ws.read('doc.review.html'), bytesBefore, 'html bytes must be unchanged');
    assert.equal(statSync(join(ws.dir, 'doc.review.html')).mtimeMs, mtimeBefore, 'html mtime unchanged');
  } finally { ws.cleanup(); }
});

// ---- --sidecar override ----------------------------------------------------
test('--sidecar override is honored on init AND on a later mutation', () => {
  const ws = makeWorkspace({ git: true });
  try {
    const custom = join(ws.dir, 'review-state.seal.md');
    const i = runSeal(['init', '--in', ws.doc, '--sidecar', custom, '--no-render'], { cwd: ws.dir });
    assert.equal(i.code, 0, i.stderr);
    assert.ok(existsSync(custom), 'sidecar written to the override path');
    assert.equal(ws.exists('doc.seal.md'), false, 'default sidecar path must NOT be written');
    assert.equal(i.json.sidecar, custom);

    // a mutation must read+write the SAME override, not the default
    const cm = runSeal(['comment', '--in', ws.doc, '--sidecar', custom, '--body', 'hi', '--no-render'], { cwd: ws.dir });
    assert.equal(cm.code, 0, cm.stderr);
    assert.equal(ws.exists('doc.seal.md'), false, 'mutation must not create the default sidecar');
    const raw = readFileSync(custom, 'utf8');
    assert.equal(commentRecords(raw).length, 1, 'the comment landed in the override sidecar');
  } finally { ws.cleanup(); }
});

test('a mutation WITHOUT --sidecar cannot find an override-only sidecar (tells you to init)', () => {
  const ws = makeWorkspace({ git: true });
  try {
    const custom = join(ws.dir, 'elsewhere.seal.md');
    runSeal(['init', '--in', ws.doc, '--sidecar', custom, '--no-render'], { cwd: ws.dir });
    // no --sidecar => default path => no sidecar there => fail loud
    const res = runSeal(['status', '--in', ws.doc, '--json'], { cwd: ws.dir });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /no sidecar|seal init/i);
  } finally { ws.cleanup(); }
});

// ---- positional / bare-path doc resolution --------------------------------
test('positional doc path (no --in) resolves: `seal hash doc.md`', () => {
  const ws = makeWorkspace({ git: false });
  try {
    // pass the doc as a bare positional argument, not via --in
    const res = runSeal(['hash', ws.doc], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.content_hash, contentHash(SAMPLE_DOC));
  } finally { ws.cleanup(); }
});

test('a bare `.md` first arg is treated as the `start` shorthand (routes to start, not unknown)', () => {
  const ws = makeWorkspace({ git: false });
  try {
    // `start` -> cmdStart -> cmdServe binds a loopback server and blocks, so we
    // can't let it run to completion. Run it briefly and assert it took the
    // START path (its distinctive shareability stderr) rather than printing USAGE.
    // Use a short-lived spawn with a kill timeout.
    const r = spawnSync(process.execPath, [SEAL, ws.doc, '--port', '0'], {
      cwd: ws.dir, encoding: 'utf8', timeout: 2500,
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    });
    const all = (r.stdout || '') + (r.stderr || '');
    // start prints the shareability guidance to stderr; USAGE would say "Usage:"
    assert.ok(!/^Usage:/m.test(all), 'must not fall through to USAGE');
    assert.match(all, /LOCAL ONLY|live review|Owner/i, 'took the start/serve path');
  } finally { ws.cleanup(); }
});

// ---- unknown command / missing required arg (fail-loud usage) -------------
test('unknown command prints USAGE and exits 1', () => {
  const ws = makeWorkspace({ git: false });
  try {
    const res = runSeal(['bogus-command', '--in', ws.doc], { cwd: ws.dir });
    assert.equal(res.code, 1, 'unknown command exits 1');
    assert.match(res.stderr, /Usage:/);
  } finally { ws.cleanup(); }
});

test('comment with no --body fails loud ("body is required")', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    const res = runSeal(['comment', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /body is required/i);
    // and it must not have appended a comment
    assert.equal(commentRecords(readSidecarRaw(ws)).length, 0);
  } finally { ws.cleanup(); }
});

// ---- owner derivation: the 'none' branch ----------------------------------
test('owner_source is "none" when no --owner, no Author line, and no git user.name', () => {
  // A doc with NO author line, in a NON-git dir => gitInfo.name is null => 'none'.
  const content = `# Headless Doc\n\n## Body\nPlain content with no author metadata at all here.\n`;
  const ws = makeWorkspace({ git: false, content });
  try {
    // Deterministically neutralize ANY ambient git user.name (the dir is not a
    // repo, but `git config user.name` still reads the global/system config).
    const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: ws.dir };
    const res = runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir, env });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.owner, null, 'no owner could be derived');
    assert.equal(res.json.owner_source, 'none');
  } finally { ws.cleanup(); }
});

// ---- parseSidecar: untested error branches --------------------------------
test('corrupted sidecar: a comment record with NO id fails loud and is not overwritten', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    runSeal(['comment', '--in', ws.doc, '--body', 'first', '--no-render'], { cwd: ws.dir });
    let raw = readSidecarRaw(ws);
    const block = firstCommentBlock(raw);
    assert.ok(block, 'has a comment block');
    // strip the "id":"..." field from inside the canonical JSON
    const broken = block.replace(/"id":"[^"]*",/, '');
    assert.notEqual(broken, block, 'id field was removed');
    raw = raw.replace(block, broken);
    writeFileSync(ws.sidecar, raw, 'utf8');
    assertRefusesAndPreserves(ws, ['doctor', '--in', ws.doc, '--json'], { matchExtra: /has no id/i });
  } finally { ws.cleanup(); }
});

test('corrupted sidecar: an unknown record kind fence fails loud and is not overwritten', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc, '--no-render'], { cwd: ws.dir });
    let raw = readSidecarRaw(ws);
    // relabel the state fence + its kind to a kind the parser doesn't know.
    // (use a-z only so the /seal:([a-z]+)/ tokenizer still matches the fence)
    raw = raw.replace('```json seal:state\n', '```json seal:frobnicate\n')
             .replace('"kind":"state"', '"kind":"frobnicate"');
    writeFileSync(ws.sidecar, raw, 'utf8');
    assertRefusesAndPreserves(ws, ['doctor', '--in', ws.doc, '--json'], { matchExtra: /unknown record kind/i });
  } finally { ws.cleanup(); }
});
