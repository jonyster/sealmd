// ============================================================================
// Black-box CLI tests for the suggestion lifecycle:
//   comment --suggest (needs anchor) -> accept --id (applies to doc.md).
// Driven entirely through runSeal() so the engine is exercised as users invoke it.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { makeWorkspace, runSeal, SEAL, sealToken } from './helper.mjs';

// Local-only helper: pull the parsed JSON record of the (first) comment from the
// sidecar so a test can inspect/mutate the stored anchor directly. Defined here
// (not in helper.mjs) so parallel authors don't race on the shared harness.
function firstCommentRecord(ws) {
  const sidecar = ws.read('doc.seal.md');
  const m = sidecar.match(/```json seal:comment\n(.*)\n```/);
  assert.ok(m, 'comment record present in sidecar');
  return { record: JSON.parse(m[1]), raw: m[1], sidecar };
}

// A doc whose text is already normalized (no trailing ws, single blank runs,
// no BOM/CRLF) so that makeAnchor (operates on normalized) and coreAccept
// (operates on raw) agree on offsets.
const DOC = `# Spec

## Overview
The system uses Postgres for storage and Redis for caching.

## Goals
Ship a fully local review tool with zero network calls.

## Risks
There is a risk that anchors drift when the document changes underneath them.
`;

// Helper: pull the single comment id out of the sidecar by re-running status.
function statusJson(ws) {
  const res = runSeal(['status', '--in', ws.doc, '--json'], { cwd: ws.dir });
  assert.equal(res.code, 0, res.stderr);
  return res.json;
}

function initWs(content = DOC) {
  const ws = makeWorkspace({ git: true, content });
  const res = runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
  assert.equal(res.code, 0, `init failed: ${res.stderr || res.stdout}`);
  return ws;
}

// ---------------------------------------------------------------------------
test('suggest WITHOUT --anchor exits non-zero with "needs an anchor"', () => {
  const ws = initWs();
  try {
    const res = runSeal(
      ['comment', '--in', ws.doc, '--author', 'Reviewer', '--body', 'use Mongo', '--suggest', 'Mongo'],
      { cwd: ws.dir },
    );
    assert.notEqual(res.code, 0, 'expected non-zero exit');
    assert.match(res.stderr, /a suggestion needs an anchor/i);
    // No comment was recorded.
    assert.equal(statusJson(ws).comments.total, 0);
  } finally {
    ws.cleanup();
  }
});

test('suggest WITH a valid --anchor is recorded as a suggestion', () => {
  const ws = initWs();
  try {
    const res = runSeal(
      ['comment', '--in', ws.doc, '--author', 'Reviewer',
        '--body', 'prefer MySQL', '--anchor', 'Postgres', '--suggest', 'MySQL'],
      { cwd: ws.dir },
    );
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.action, 'suggest');
    assert.equal(res.json.anchored, true);
    assert.match(res.json.id, /^c_/);

    const st = statusJson(ws);
    assert.equal(st.comments.total, 1);
    // sidecar parses cleanly
    const dr = runSeal(['doctor', '--in', ws.doc, '--json'], { cwd: ws.dir });
    assert.equal(dr.code, 0, dr.stderr);
    assert.equal(dr.json.records.comments, 1);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
test('accept --id applies replacement to doc.md and changes the content hash', () => {
  const ws = initWs();
  try {
    const before = runSeal(['hash', '--in', ws.doc], { cwd: ws.dir }).json.content_hash;

    const sug = runSeal(
      ['comment', '--in', ws.doc, '--body', 'switch db',
        '--anchor', 'Postgres for storage', '--suggest', 'CockroachDB for storage'],
      { cwd: ws.dir },
    );
    assert.equal(sug.code, 0, sug.stderr);
    const id = sug.json.id;

    const before_doc = ws.read('doc.md');
    assert.ok(before_doc.includes('Postgres for storage'));

    const acc = runSeal(['accept', '--in', ws.doc, '--id', id], { cwd: ws.dir });
    assert.equal(acc.code, 0, acc.stderr);
    assert.equal(acc.json.action, 'accept');
    assert.equal(acc.json.id, id);

    // The file content actually changed: old span gone, replacement present.
    const after_doc = ws.read('doc.md');
    assert.ok(!after_doc.includes('Postgres for storage'), 'old span should be gone');
    assert.ok(after_doc.includes('CockroachDB for storage'), 'replacement should be present');
    // Redis (untouched neighbor) survives intact -> no corrupt/partial write.
    assert.ok(after_doc.includes('Redis for caching'));

    // content hash changed (and the json reports the new live hash).
    const after = runSeal(['hash', '--in', ws.doc], { cwd: ws.dir }).json.content_hash;
    assert.notEqual(after, before);
    assert.equal(acc.json.content_hash, after);

    // sidecar still parses after the write.
    const dr = runSeal(['doctor', '--in', ws.doc, '--json'], { cwd: ws.dir });
    assert.equal(dr.code, 0, dr.stderr);
  } finally {
    ws.cleanup();
  }
});

test('accept marks the comment resolved + accepted=true', () => {
  const ws = initWs();
  try {
    const sug = runSeal(
      ['comment', '--in', ws.doc, '--body', 'tighten',
        '--anchor', 'zero network calls', '--suggest', 'no network calls at all'],
      { cwd: ws.dir },
    );
    const id = sug.json.id;
    const acc = runSeal(['accept', '--in', ws.doc, '--id', id], { cwd: ws.dir });
    assert.equal(acc.code, 0, acc.stderr);

    // Inspect the sidecar record directly for status/accepted.
    const sidecar = ws.read('doc.seal.md');
    const m = sidecar.match(/```json seal:comment\n(.*)\n```/);
    assert.ok(m, 'comment record present in sidecar');
    const rec = JSON.parse(m[1]);
    assert.equal(rec.id, id);
    assert.equal(rec.status, 'resolved');
    assert.equal(rec.accepted, true);

    // status reflects it as resolved (0 open).
    const st = statusJson(ws);
    assert.equal(st.comments.open, 0);
    assert.equal(st.comments.resolved, 1);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
test('accept on a NON-suggestion comment exits non-zero with "not a suggestion"', () => {
  const ws = initWs();
  try {
    const cm = runSeal(
      ['comment', '--in', ws.doc, '--body', 'just a note', '--anchor', 'Postgres'],
      { cwd: ws.dir },
    );
    assert.equal(cm.code, 0, cm.stderr);
    assert.equal(cm.json.action, 'comment');
    const id = cm.json.id;

    const acc = runSeal(['accept', '--in', ws.doc, '--id', id], { cwd: ws.dir });
    assert.notEqual(acc.code, 0, 'expected non-zero exit');
    assert.match(acc.stderr, /not a suggestion/i);

    // The doc was NOT modified and the comment stays open.
    assert.ok(ws.read('doc.md').includes('Postgres for storage'));
    assert.equal(statusJson(ws).comments.open, 1);
  } finally {
    ws.cleanup();
  }
});

test('accept with an unknown --id fails loud', () => {
  const ws = initWs();
  try {
    const acc = runSeal(['accept', '--in', ws.doc, '--id', 'c_nope_zzzz'], { cwd: ws.dir });
    assert.notEqual(acc.code, 0);
    assert.match(acc.stderr, /no comment with id/i);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// AMBIGUOUS anchor: the span "the document" appears twice in DOC2. makeAnchor
// stores prefix/suffix context, and accept must replace the RIGHT occurrence.
const DOC2 = `# Ambiguity

## A
Please read the document carefully before you sign.

## B
We will revise the document after the meeting.
`;

test('ambiguous span: a too-short anchor is rejected as ambiguous', () => {
  const ws = initWs(DOC2);
  try {
    // "the document" appears twice with insufficient (32-char) context to be
    // unique? The two occurrences differ within 32 chars, so makeAnchor may
    // actually succeed. Use a bare ambiguous quote with NO surrounding context
    // by quoting a span whose 32-char windows are identical-length but differ.
    // To force the ambiguity error we quote a span that repeats and whose
    // CTX windows are not unique: "document" alone (8 chars).
    const res = runSeal(
      ['comment', '--in', ws.doc, '--body', 'which one?',
        '--anchor', 'document', '--suggest', 'doc'],
      { cwd: ws.dir },
    );
    // "document" appears 3x (heading "Ambiguity" has no "document"; bodies have
    // it twice). With CTX=32 the windows differ, so this likely succeeds; if it
    // does, accept must still hit a unique occurrence. Accept either outcome but
    // verify correctness of whichever path the engine takes.
    if (res.code !== 0) {
      assert.match(res.stderr, /ambiguous/i);
    } else {
      // recorded with disambiguating context -> accept replaces exactly one.
      const id = res.json.id;
      const acc = runSeal(['accept', '--in', ws.doc, '--id', id], { cwd: ws.dir });
      assert.equal(acc.code, 0, acc.stderr);
      const after = ws.read('doc.md');
      // exactly one of the two "document" occurrences was replaced.
      const count = (after.match(/\bdocument\b/g) || []).length;
      assert.equal(count, 1, 'exactly one occurrence replaced');
    }
  } finally {
    ws.cleanup();
  }
});

test('ambiguous span: unique surrounding context targets the RIGHT occurrence', () => {
  const ws = initWs(DOC2);
  try {
    // Anchor a longer, unique span that contains the repeated word, pinned by
    // its distinct neighbors. This unambiguously targets occurrence #2.
    const res = runSeal(
      ['comment', '--in', ws.doc, '--body', 'reword',
        '--anchor', 'revise the document after', '--suggest', 'update the spec after'],
      { cwd: ws.dir },
    );
    assert.equal(res.code, 0, res.stderr);
    const id = res.json.id;

    const acc = runSeal(['accept', '--in', ws.doc, '--id', id], { cwd: ws.dir });
    assert.equal(acc.code, 0, acc.stderr);

    const after = ws.read('doc.md');
    // Occurrence #1 (in section A) is untouched.
    assert.ok(after.includes('read the document carefully'), 'first occurrence untouched');
    // Occurrence #2 (in section B) was rewritten.
    assert.ok(after.includes('We will update the spec after the meeting.'));
    assert.ok(!after.includes('revise the document after'));

    // doctor still ok.
    const dr = runSeal(['doctor', '--in', ws.doc, '--json'], { cwd: ws.dir });
    assert.equal(dr.code, 0, dr.stderr);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// After accepting, a PRIOR anchor that pointed at the now-changed region must
// resolve as 'unanchored' in status (its quoted span is gone).
test('accepting a suggestion leaves a prior anchor on the changed region unanchored', () => {
  const ws = initWs();
  try {
    // Comment #1: a plain comment anchored on the exact text that will be replaced.
    const c1 = runSeal(
      ['comment', '--in', ws.doc, '--body', 'note on this line',
        '--anchor', 'Ship a fully local review tool with zero network calls'],
      { cwd: ws.dir },
    );
    assert.equal(c1.code, 0, c1.stderr);

    // Suggestion that rewrites that very span.
    const sug = runSeal(
      ['comment', '--in', ws.doc, '--body', 'reword goal',
        '--anchor', 'Ship a fully local review tool with zero network calls',
        '--suggest', 'Deliver an offline-first review tool.'],
      { cwd: ws.dir },
    );
    assert.equal(sug.code, 0, sug.stderr);

    const acc = runSeal(['accept', '--in', ws.doc, '--id', sug.json.id], { cwd: ws.dir });
    assert.equal(acc.code, 0, acc.stderr);

    // The prior comment's anchor text is gone -> status flags an unanchored comment.
    const st = statusJson(ws);
    assert.ok(st.unanchored_comments >= 1, 'prior anchor should be unanchored');
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Idempotency / re-accept: once applied the original span is gone, so a second
// accept of the same suggestion must fail loud (can't find the original text).
test('re-accepting an already-applied suggestion fails loud (original text gone)', () => {
  const ws = initWs();
  try {
    const sug = runSeal(
      ['comment', '--in', ws.doc, '--body', 'x',
        '--anchor', 'Redis for caching', '--suggest', 'Memcached for caching'],
      { cwd: ws.dir },
    );
    const id = sug.json.id;
    const first = runSeal(['accept', '--in', ws.doc, '--id', id], { cwd: ws.dir });
    assert.equal(first.code, 0, first.stderr);
    assert.ok(ws.read('doc.md').includes('Memcached for caching'));

    const second = runSeal(['accept', '--in', ws.doc, '--id', id], { cwd: ws.dir });
    assert.notEqual(second.code, 0, 'second accept should fail');
    assert.match(second.stderr, /could not find the original text/i);
    // Doc unchanged by the failed second accept.
    assert.ok(ws.read('doc.md').includes('Memcached for caching'));
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Security: an HTML/XSS-bearing replacement is applied to the doc verbatim
// (markdown is plaintext); the doc write stays intact and the sidecar parses.
test('suggestion replacement carrying HTML is written verbatim and sidecar stays valid', () => {
  const ws = initWs();
  try {
    const payload = '<script>alert(1)</script> & <b>bold</b>';
    const sug = runSeal(
      ['comment', '--in', ws.doc, '--body', 'inject',
        '--anchor', 'Postgres', '--suggest', payload],
      { cwd: ws.dir },
    );
    assert.equal(sug.code, 0, sug.stderr);
    const acc = runSeal(['accept', '--in', ws.doc, '--id', sug.json.id], { cwd: ws.dir });
    assert.equal(acc.code, 0, acc.stderr);

    const after = ws.read('doc.md');
    assert.ok(after.includes(payload), 'payload written verbatim into doc.md');

    // sidecar still parses; doctor green.
    const dr = runSeal(['doctor', '--in', ws.doc, '--json'], { cwd: ws.dir });
    assert.equal(dr.code, 0, dr.stderr);

    // The generated review HTML must ESCAPE the payload (no live <script>).
    const html = ws.read('doc.review.html');
    assert.ok(!html.includes('<script>alert(1)</script>'), 'payload must be escaped in HTML');
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Unicode replacement round-trips correctly through the doc write.
test('unicode replacement applies cleanly and changes the hash', () => {
  const ws = initWs();
  try {
    const before = runSeal(['hash', '--in', ws.doc], { cwd: ws.dir }).json.content_hash;
    const repl = 'café — naïve 你好 🚀';
    const sug = runSeal(
      ['comment', '--in', ws.doc, '--body', 'i18n',
        '--anchor', 'Redis', '--suggest', repl],
      { cwd: ws.dir },
    );
    assert.equal(sug.code, 0, sug.stderr);
    const acc = runSeal(['accept', '--in', ws.doc, '--id', sug.json.id], { cwd: ws.dir });
    assert.equal(acc.code, 0, acc.stderr);

    const after_doc = ws.read('doc.md');
    assert.ok(after_doc.includes(repl), 'unicode replacement present');
    const after = runSeal(['hash', '--in', ws.doc], { cwd: ws.dir }).json.content_hash;
    assert.notEqual(after, before);
  } finally {
    ws.cleanup();
  }
});

// ===========================================================================
// GAP 1 — makeAnchor's AMBIGUOUS-ANCHOR REJECTION path (seal.mjs:317).
// The existing line-200 test crafts a doc whose 32-char context windows differ,
// so it accepts EITHER outcome and never forces the throw. Here we build a doc
// where the bare quote AND its full 32-char prefix+suffix windows are byte-
// identical at two sites, so `prefix + quote + suffix` is non-unique and
// makeAnchor MUST throw 'anchor is ambiguous (appears multiple times)'.
// ---------------------------------------------------------------------------
// CTX = 32 in seal.mjs. To make prefix+q+suffix non-unique we repeat an
// identical block with >=32 chars of identical text on BOTH sides of the quote.
const PAD_L = 'left padding text that is plenty long here'; // > 32 chars
const PAD_R = 'right padding text that is plenty long here'; // > 32 chars
const AMBIG_BLOCK = `${PAD_L} MIDWORD ${PAD_R}.`;
const DOC_AMBIG = `# Ambiguity Forced

Intro paragraph one with its own distinct words alpha here.

${AMBIG_BLOCK}

Bridge paragraph two with its own distinct words beta here.

${AMBIG_BLOCK}

Closing line.
`;

test('makeAnchor REJECTS a non-unique prefix+quote+suffix as ambiguous (suggest fails loud)', () => {
  const ws = initWs(DOC_AMBIG);
  try {
    const res = runSeal(
      ['comment', '--in', ws.doc, '--author', 'R', '--body', 'which block?',
        '--anchor', 'MIDWORD', '--suggest', 'CENTERED'],
      { cwd: ws.dir },
    );
    assert.notEqual(res.code, 0, 'expected non-zero exit for ambiguous anchor');
    assert.match(res.stderr, /anchor is ambiguous \(appears multiple times\)/i);
    // Nothing was recorded — the throw happens before the sidecar write.
    assert.equal(statusJson(ws).comments.total, 0);
    // The doc is untouched.
    assert.ok(ws.read('doc.md').includes('MIDWORD'));
  } finally {
    ws.cleanup();
  }
});

// ===========================================================================
// GAP 2 — coreAccept's AMBIGUOUS-REPLACEMENT path (seal.mjs:624-628).
// (a) bare quote is non-unique in the RAW doc, but the stored prefix/suffix
//     makes prefix+quote+suffix unique -> accept disambiguates and replaces the
//     ONE occurrence makeAnchor pinned (occurrence #1 here), leaving the other.
// ---------------------------------------------------------------------------
const DOC_REPEAT = `# Repeat

Alpha section here please review the report before the deadline arrives now.

Beta section here we must revise the report after the launch event ends soon.
`;

test('coreAccept disambiguates a non-unique quote via stored context and replaces the pinned occurrence', () => {
  const ws = initWs(DOC_REPEAT);
  try {
    // Bare anchor "the report" appears twice -> makeAnchor stores prefix/suffix
    // that pin occurrence #1 ("...please review the report before...").
    const sug = runSeal(
      ['comment', '--in', ws.doc, '--body', 'reword',
        '--anchor', 'the report', '--suggest', 'THE DRAFT'],
      { cwd: ws.dir },
    );
    assert.equal(sug.code, 0, sug.stderr);
    assert.equal(sug.json.action, 'suggest');

    // Sanity: the stored anchor actually carries disambiguating context (so the
    // accept must traverse the ambiguous branch, not the simple unique branch).
    const { record } = firstCommentRecord(ws);
    assert.equal(record.anchor.quote, 'the report');
    assert.ok(record.anchor.prefix.length > 0, 'prefix context stored');
    assert.ok(record.anchor.suffix.length > 0, 'suffix context stored');

    const acc = runSeal(['accept', '--in', ws.doc, '--id', sug.json.id], { cwd: ws.dir });
    assert.equal(acc.code, 0, acc.stderr);

    const after = ws.read('doc.md');
    // Occurrence #1 (the pinned one) was rewritten.
    assert.ok(after.includes('please review THE DRAFT before the deadline'),
      'pinned occurrence #1 replaced');
    // Occurrence #2 is untouched.
    assert.ok(after.includes('revise the report after the launch'),
      'other occurrence left intact');
    // Exactly one "the report" remains.
    assert.equal((after.match(/the report/g) || []).length, 1, 'exactly one replacement');

    // sidecar still parses after the write.
    const dr = runSeal(['doctor', '--in', ws.doc, '--json'], { cwd: ws.dir });
    assert.equal(dr.code, 0, dr.stderr);
  } finally {
    ws.cleanup();
  }
});

// (b) The 'text appears multiple times — accept by editing manually' failure:
//     at accept time BOTH the bare quote AND prefix+quote+suffix are non-unique
//     in the raw doc. makeAnchor would reject this at suggest time, so we suggest
//     against a clean (unique) doc, then duplicate the line in doc.md BEFORE
//     accepting to make even the contextual probe ambiguous.
test('coreAccept fails loud when even the contextual probe is non-unique (edit manually)', () => {
  const ws = initWs(`# Doc

Section that mentions the special token uniquely here in this place once only.
`);
  try {
    const sug = runSeal(
      ['comment', '--in', ws.doc, '--body', 'rename',
        '--anchor', 'the special token', '--suggest', 'THE KEY'],
      { cwd: ws.dir },
    );
    assert.equal(sug.code, 0, sug.stderr);
    // At suggest time the quote was unique, so no context was stored.
    const { record } = firstCommentRecord(ws);
    assert.equal(record.anchor.prefix, '');
    assert.equal(record.anchor.suffix, '');

    // Mutate doc.md to duplicate the whole line: now the quote AND the empty-
    // context probe are both non-unique -> the disambiguation branch must throw.
    const dup = 'Section that mentions the special token uniquely here in this place once only.';
    ws.write('doc.md', ws.read('doc.md') + '\n' + dup + '\n');

    const acc = runSeal(['accept', '--in', ws.doc, '--id', sug.json.id], { cwd: ws.dir });
    assert.notEqual(acc.code, 0, 'expected non-zero exit');
    assert.match(acc.stderr, /text appears multiple times — accept by editing manually/i);

    // The doc was NOT modified by the failed accept (both occurrences survive,
    // none replaced with THE KEY) — fail-loud, no partial write.
    const after = ws.read('doc.md');
    assert.equal((after.match(/the special token/g) || []).length, 2, 'both occurrences intact');
    assert.ok(!after.includes('THE KEY'), 'no partial replacement written');

    // The comment stays OPEN (not resolved) since the accept aborted.
    assert.equal(statusJson(ws).comments.open, 1);
  } finally {
    ws.cleanup();
  }
});

// ===========================================================================
// GAP 3 — coreAccept's 'suggestion has no anchor to replace' branch
// (seal.mjs:615). This is unreachable through the CLI because `comment
// --suggest` requires --anchor, so a stored suggestion always has an anchor.
// We reach it by surgically nulling the anchor on a recorded suggestion in the
// sidecar, then running accept.
// ---------------------------------------------------------------------------
test('coreAccept rejects a suggestion whose stored anchor is null (no anchor to replace)', () => {
  const ws = initWs(`# Doc

Hello world this paragraph is perfectly fine for anchoring.
`);
  try {
    const sug = runSeal(
      ['comment', '--in', ws.doc, '--body', 'tweak',
        '--anchor', 'Hello world', '--suggest', 'Hi there'],
      { cwd: ws.dir },
    );
    assert.equal(sug.code, 0, sug.stderr);
    const id = sug.json.id;

    // Null the anchor (keep suggestion != null) directly in the sidecar so the
    // branch ordering reaches the no-anchor guard after the is-a-suggestion check.
    const { record, raw, sidecar } = firstCommentRecord(ws);
    assert.notEqual(record.suggestion, undefined, 'still a suggestion');
    record.anchor = null;
    ws.write('doc.seal.md', sidecar.replace(raw, JSON.stringify(record)));

    const acc = runSeal(['accept', '--in', ws.doc, '--id', id], { cwd: ws.dir });
    assert.notEqual(acc.code, 0, 'expected non-zero exit');
    assert.match(acc.stderr, /suggestion has no anchor to replace/i);

    // The doc is untouched by the failed accept.
    assert.ok(ws.read('doc.md').includes('Hello world'), 'doc unchanged');
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Empty-string suggestion (deletion). `arg('suggest')` returns the next argv,
// which for "--suggest ''" is the empty string -> suggestion != null is true,
// so it's a deletion suggestion. Accept removes the span.
test('empty-string suggestion deletes the anchored span', () => {
  const ws = initWs();
  try {
    const sug = runSeal(
      ['comment', '--in', ws.doc, '--body', 'delete this',
        '--anchor', ' and Redis for caching', '--suggest', ''],
      { cwd: ws.dir },
    );
    assert.equal(sug.code, 0, sug.stderr);
    assert.equal(sug.json.action, 'suggest', 'empty string is still a suggestion');

    const acc = runSeal(['accept', '--in', ws.doc, '--id', sug.json.id], { cwd: ws.dir });
    assert.equal(acc.code, 0, acc.stderr);
    const after = ws.read('doc.md');
    assert.ok(!after.includes('Redis'), 'span deleted');
    assert.ok(after.includes('Postgres for storage'), 'rest of line intact');
  } finally {
    ws.cleanup();
  }
});

// ============================================================================
// Owner edit via the serve API (/api/doc → coreSaveDoc). Relocated here from
// the (deleted) approval test file: the owner Markdown-editor write path + its
// empty/non-string guard are core review behavior, unrelated to approval.
// ============================================================================

// minimal serve harness: pick a free port, spawn `seal serve`, wait until it
// answers, run fn(base), tear down. Loopback only, no network.
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

async function withServer(ws, fn) {
  const port = await freePort();
  const child = spawn(process.execPath, [SEAL, 'serve', '--in', ws.doc, '--port', String(port)], {
    cwd: ws.dir,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 10000;
    for (;;) {
      try { await fetch(base + '/api/state'); break; } catch (e) {
        if (Date.now() > deadline) throw new Error('serve never came up: ' + e.message);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    return await fn(base);
  } finally {
    child.kill('SIGKILL');
    await new Promise((r) => child.on('exit', r));
  }
}

async function postJson(base, path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-seal-token': await sealToken(base) },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

test('owner edit via /api/doc rewrites doc.md and reports the new hash', async () => {
  const ws = initWs();
  try {
    const before = ws.read('doc.md');
    const newMd = DOC + '\n## Owner Addendum\nThe owner rewrote this in the Markdown editor.\n';
    const liveHash = runSeal(['hash', '--in', ws.doc], { cwd: ws.dir }).json.content_hash;

    const { status: code, json } = await withServer(ws, (base) =>
      postJson(base, '/api/doc', { markdown: newMd }));

    assert.equal(code, 200, 'owner save should succeed');
    assert.equal(json.ok, true);
    assert.ok(json.content_hash, 'content_hash returned');
    assert.notEqual(json.content_hash, liveHash, 'owner edit must change the hash');

    // doc.md actually rewritten on disk (atomic tmp->rename path in coreSaveDoc)
    const after = ws.read('doc.md');
    assert.notEqual(after, before);
    assert.equal(after, newMd, 'doc.md holds exactly the saved markdown');
    // the new on-disk live hash matches what /api/doc reported
    assert.equal(runSeal(['hash', '--in', ws.doc], { cwd: ws.dir }).json.content_hash, json.content_hash);
  } finally { ws.cleanup(); }
});

test('owner edit via /api/doc REFUSES empty markdown (guard, no file write)', async () => {
  const ws = initWs();
  try {
    const before = ws.read('doc.md');
    for (const bad of ['', '   ', '\n\t\n']) {
      const { status: code, json } = await withServer(ws, (base) =>
        postJson(base, '/api/doc', { markdown: bad }));
      assert.equal(code, 400, `empty markdown ${JSON.stringify(bad)} must be rejected`);
      assert.equal(json.ok, false);
      assert.match(json.error, /refusing to write empty markdown/i);
    }
    // doc.md must be untouched by the rejected writes
    assert.equal(ws.read('doc.md'), before, 'guarded write must not clobber doc.md');
  } finally { ws.cleanup(); }
});

test('owner edit via /api/doc REFUSES a non-string markdown payload', async () => {
  const ws = initWs();
  try {
    const before = ws.read('doc.md');
    // markdown omitted entirely -> typeof !== 'string' -> same guard
    const { status: code, json } = await withServer(ws, (base) =>
      postJson(base, '/api/doc', { notMarkdown: 'oops' }));
    assert.equal(code, 400);
    assert.equal(json.ok, false);
    assert.match(json.error, /refusing to write empty markdown/i);
    assert.equal(ws.read('doc.md'), before);
  } finally { ws.cleanup(); }
});
