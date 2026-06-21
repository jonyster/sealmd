// ============================================================================
// Black-box tests for the sealmd approval STATE MACHINE (seal.mjs).
//
// Covers: draft -> submit -> approve/request, quorum, distinct-approver
// counting, veto precedence, staleness after a post-submit edit, re-submit,
// and the fail-loud error paths. Driven entirely through runSeal (the CLI),
// asserting on `status --json` and command exit codes.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { makeWorkspace, runSeal, SAMPLE_DOC, SEAL, sealToken } from './helper.mjs';

// --- local helpers (defined here so we never edit the shared harness) -------

// init a fresh workspace (optionally with a quorum), returning the workspace.
function setup({ quorum, git = false, content = SAMPLE_DOC } = {}) {
  const ws = makeWorkspace({ git, content });
  const initArgs = ['init', '--in', ws.doc];
  if (quorum != null) initArgs.push('--quorum', String(quorum));
  const res = runSeal(initArgs, { cwd: ws.dir });
  assert.equal(res.code, 0, `init failed: ${res.stderr || res.stdout}`);
  return ws;
}

// `status --json` -> the parsed summary object.
function status(ws) {
  const res = runSeal(['status', '--in', ws.doc, '--json'], { cwd: ws.dir });
  assert.equal(res.code, 0, `status failed: ${res.stderr || res.stdout}`);
  assert.ok(res.json, 'status produced no JSON');
  return res.json;
}

function submit(ws) {
  return runSeal(['submit', '--in', ws.doc], { cwd: ws.dir });
}
function approve(ws, approver, note) {
  const a = ['approve', '--in', ws.doc, '--approver', approver];
  if (note != null) a.push('--note', note);
  return runSeal(a, { cwd: ws.dir });
}
function request(ws, approver, note) {
  const a = ['request', '--in', ws.doc, '--approver', approver];
  if (note != null) a.push('--note', note);
  return runSeal(a, { cwd: ws.dir });
}
// overwrite doc.md with new content (an owner edit), changing the live hash.
function editDoc(ws, content) {
  ws.write('doc.md', content);
}

const EDITED_DOC = SAMPLE_DOC + '\n## New Section\nAdded after submit so the hash changes.\n';

// ----------------------------------------------------------------------------

test('fresh init: status is draft, nothing pinned to live, no approvals', () => {
  const ws = setup();
  try {
    const s = status(ws);
    assert.equal(s.status, 'draft');
    assert.equal(s.approvals.quorum, 1);
    assert.equal(s.approvals.approved, 0);
    assert.deepEqual(s.approvals.vetoes, []);
    assert.equal(s.approvals.approved_for_current_version, false);
    assert.equal(s.doc_edited_after_submit, false);
  } finally { ws.cleanup(); }
});

test('approve BEFORE submit exits non-zero (nothing submitted)', () => {
  const ws = setup();
  try {
    const res = approve(ws, 'Alice');
    assert.notEqual(res.code, 0, 'approve in draft should fail');
    assert.match(res.stderr, /nothing submitted/i);
    // state must remain draft, untouched
    assert.equal(status(ws).status, 'draft');
  } finally { ws.cleanup(); }
});

test('request BEFORE submit exits non-zero (nothing submitted)', () => {
  const ws = setup();
  try {
    const res = request(ws, 'Alice', 'please fix');
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /nothing submitted/i);
    assert.equal(status(ws).status, 'draft');
  } finally { ws.cleanup(); }
});

test('submit pins state to the live version and sets in_review', () => {
  const ws = setup();
  try {
    const hashRes = runSeal(['hash', '--in', ws.doc], { cwd: ws.dir });
    const live = hashRes.json.content_hash;

    const res = submit(ws);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.status, 'in_review');
    assert.equal(res.json.content_hash, live, 'submit must pin to the live hash');

    const s = status(ws);
    assert.equal(s.status, 'in_review');
    assert.equal(s.state_hash, live);
    assert.equal(s.live_hash, live);
    assert.equal(s.doc_edited_after_submit, false);
  } finally { ws.cleanup(); }
});

test('quorum 1: one approval reaches approved (current version)', () => {
  const ws = setup();
  try {
    assert.equal(submit(ws).code, 0);
    const res = approve(ws, 'Alice');
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.status, 'approved');

    const s = status(ws);
    assert.equal(s.status, 'approved');
    assert.equal(s.approvals.approved, 1);
    assert.equal(s.approvals.quorum, 1);
    assert.equal(s.approvals.approved_for_current_version, true);
    assert.deepEqual(s.approvals.vetoes, []);
  } finally { ws.cleanup(); }
});

test('quorum 2: one approval => in_review; second DISTINCT approver => approved', () => {
  const ws = setup({ quorum: 2 });
  try {
    assert.equal(submit(ws).code, 0);

    const r1 = approve(ws, 'Alice');
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(r1.json.status, 'in_review', 'one of two approvals is not enough');
    let s = status(ws);
    assert.equal(s.status, 'in_review');
    assert.equal(s.approvals.approved, 1);
    assert.equal(s.approvals.quorum, 2);
    assert.equal(s.approvals.approved_for_current_version, false);

    const r2 = approve(ws, 'Bob');
    assert.equal(r2.code, 0, r2.stderr);
    assert.equal(r2.json.status, 'approved');
    s = status(ws);
    assert.equal(s.status, 'approved');
    assert.equal(s.approvals.approved, 2);
    assert.equal(s.approvals.approved_for_current_version, true);
  } finally { ws.cleanup(); }
});

test('quorum 2: SAME approver approving twice does NOT double-count', () => {
  const ws = setup({ quorum: 2 });
  try {
    assert.equal(submit(ws).code, 0);
    assert.equal(approve(ws, 'Alice').code, 0);
    const again = approve(ws, 'Alice');
    assert.equal(again.code, 0, again.stderr);
    // still only 1 distinct approval => not yet at quorum 2
    assert.equal(again.json.status, 'in_review');
    const s = status(ws);
    assert.equal(s.approvals.approved, 1, 'duplicate approver must collapse to one');
    assert.equal(s.status, 'in_review');
  } finally { ws.cleanup(); }
});

test('request --approver WITHOUT --note exits non-zero (a note is required)', () => {
  const ws = setup();
  try {
    assert.equal(submit(ws).code, 0);
    const res = request(ws, 'Alice');
    assert.notEqual(res.code, 0, 'request without note must fail');
    assert.match(res.stderr, /note is required/i);
    // no veto recorded
    assert.equal(status(ws).status, 'in_review');
  } finally { ws.cleanup(); }
});

test('request --approver WITHOUT approver exits non-zero (approver is required)', () => {
  const ws = setup();
  try {
    assert.equal(submit(ws).code, 0);
    const res = runSeal(['approve', '--in', ws.doc], { cwd: ws.dir });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /approver is required/i);
  } finally { ws.cleanup(); }
});

test('request --approver --note sets changes_requested', () => {
  const ws = setup();
  try {
    assert.equal(submit(ws).code, 0);
    const res = request(ws, 'Alice', 'tighten the goals section');
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.status, 'changes_requested');
    const s = status(ws);
    assert.equal(s.status, 'changes_requested');
    assert.deepEqual(s.approvals.vetoes, ['Alice']);
    assert.equal(s.approvals.approved_for_current_version, false);
  } finally { ws.cleanup(); }
});

test('a current veto keeps changes_requested even when quorum approvals exist', () => {
  const ws = setup({ quorum: 2 });
  try {
    assert.equal(submit(ws).code, 0);
    // two distinct approvals (meets quorum)...
    assert.equal(approve(ws, 'Alice').code, 0);
    assert.equal(approve(ws, 'Bob').code, 0);
    assert.equal(status(ws).status, 'approved');
    // ...then a third reviewer vetoes -> changes_requested wins.
    const v = request(ws, 'Carol', 'blocking concern on risks');
    assert.equal(v.code, 0, v.stderr);
    assert.equal(v.json.status, 'changes_requested');
    const s = status(ws);
    assert.equal(s.status, 'changes_requested');
    assert.deepEqual(s.approvals.vetoes, ['Carol']);
    // even though 2 approvals are present, the version is NOT approved
    assert.equal(s.approvals.approved, 2);
    assert.equal(s.approvals.approved_for_current_version, false);
  } finally { ws.cleanup(); }
});

test('a reviewer can flip their veto to an approval (latest decision wins)', () => {
  const ws = setup();
  try {
    assert.equal(submit(ws).code, 0);
    assert.equal(request(ws, 'Alice', 'fix this').code, 0);
    assert.equal(status(ws).status, 'changes_requested');
    // same approver now approves -> filter removes old decision, approval stands
    const res = approve(ws, 'Alice');
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.status, 'approved');
    const s = status(ws);
    assert.equal(s.status, 'approved');
    assert.deepEqual(s.approvals.vetoes, []);
    assert.equal(s.approvals.approved, 1);
  } finally { ws.cleanup(); }
});

test('editing doc AFTER approval => doc_edited_after_submit, approvals go stale', () => {
  const ws = setup();
  try {
    assert.equal(submit(ws).code, 0);
    assert.equal(approve(ws, 'Alice').code, 0);
    assert.equal(status(ws).approvals.approved_for_current_version, true);

    editDoc(ws, EDITED_DOC);
    const s = status(ws);
    // approvals bind to the SUBMITTED hash; live hash now differs
    assert.equal(s.doc_edited_after_submit, true);
    assert.equal(s.approvals.approved_for_current_version, false);
    assert.notEqual(s.live_hash, s.state_hash);
    // derived status itself is still "approved" (for the submitted version)
    assert.equal(s.status, 'approved');
  } finally { ws.cleanup(); }
});

test('approve AFTER a post-submit edit exits non-zero (doc has changed since submit)', () => {
  const ws = setup();
  try {
    assert.equal(submit(ws).code, 0);
    assert.equal(approve(ws, 'Alice').code, 0);
    editDoc(ws, EDITED_DOC);

    const res = approve(ws, 'Bob');
    assert.notEqual(res.code, 0, 'approve on a drifted doc must fail');
    assert.match(res.stderr, /doc has changed since submit|submit again/i);
  } finally { ws.cleanup(); }
});

test('request AFTER a post-submit edit exits non-zero (doc has changed since submit)', () => {
  const ws = setup();
  try {
    assert.equal(submit(ws).code, 0);
    editDoc(ws, EDITED_DOC);
    const res = request(ws, 'Alice', 'note here');
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /doc has changed since submit|submit again/i);
  } finally { ws.cleanup(); }
});

test('re-submit re-pins to the edited version and clears staleness', () => {
  const ws = setup();
  try {
    assert.equal(submit(ws).code, 0);
    assert.equal(approve(ws, 'Alice').code, 0);
    editDoc(ws, EDITED_DOC);
    assert.equal(status(ws).doc_edited_after_submit, true);

    // re-submit pins to the NEW live hash
    const re = submit(ws);
    assert.equal(re.code, 0, re.stderr);
    const live = runSeal(['hash', '--in', ws.doc], { cwd: ws.dir }).json.content_hash;
    assert.equal(re.json.content_hash, live);

    const s = status(ws);
    assert.equal(s.doc_edited_after_submit, false);
    assert.equal(s.state_hash, live);
    assert.equal(s.status, 'in_review', 'old approval is stale; status resets to in_review');
    assert.equal(s.approvals.approved, 0, 'approval bound to old hash no longer counts');

    // and a fresh approval against the re-pinned version works again
    const ap = approve(ws, 'Alice');
    assert.equal(ap.code, 0, ap.stderr);
    assert.equal(ap.json.status, 'approved');
    assert.equal(status(ws).approvals.approved_for_current_version, true);
  } finally { ws.cleanup(); }
});

test('status --json exposes the documented field shape', () => {
  const ws = setup({ quorum: 2 });
  try {
    assert.equal(submit(ws).code, 0);
    assert.equal(approve(ws, 'Alice').code, 0);
    const s = status(ws);
    assert.equal(typeof s.status, 'string');
    assert.equal(typeof s.doc_edited_after_submit, 'boolean');
    assert.ok(s.approvals && typeof s.approvals === 'object');
    assert.equal(typeof s.approvals.quorum, 'number');
    assert.equal(typeof s.approvals.approved, 'number');
    assert.ok(Array.isArray(s.approvals.vetoes));
    assert.equal(typeof s.approvals.approved_for_current_version, 'boolean');
  } finally { ws.cleanup(); }
});

test('submit with no sidecar fails loud (init required)', () => {
  const ws = makeWorkspace({});
  try {
    const res = submit(ws);
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /no sidecar|init/i);
  } finally { ws.cleanup(); }
});

// ============================================================================
// APPENDED HARDENING TESTS (reviewer-flagged gaps)
//
// Gap 1: the /api/doc -> coreSaveDoc owner-edit path + its empty-markdown guard
//        ('refusing to write empty markdown'). Only suggestion-accept drift was
//        tested; the owner Markdown-editor write path was not.
// Gap 2: an approval with a --note on `approve` (note is optional on approve,
//        previously only exercised on `request`). It must persist + display.
// Gap 3: the per-approval current/valid_now flags in approvalState — a stale
//        (superseded) approval must be marked superseded, not current.
// ============================================================================

// --- render helper: write the static review HTML and return its text --------
function renderHtml(ws) {
  const res = runSeal(['render', '--in', ws.doc], { cwd: ws.dir });
  assert.equal(res.code, 0, `render failed: ${res.stderr || res.stdout}`);
  return ws.read('doc.review.html');
}

// --- the approvals panel slice of the HTML (so we match the right card) -----
function approvalsHtml(html) {
  const i = html.indexOf('Approvals ·');
  return i === -1 ? '' : html.slice(i);
}

// --- minimal serve harness: pick a free port ourselves, spawn `seal serve`
// on it (so we never need to parse the bound port out of logs), wait until it
// answers, run fn(base), then tear the server down. Loopback only, no network.
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
    // poll GET / until the server is accepting connections (no wall-clock sleep)
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

// ----------------------------------------------------------------------------
// Gap 1: owner edit via /api/doc (coreSaveDoc)
// ----------------------------------------------------------------------------

test('owner edit via /api/doc rewrites doc.md and reports the new hash', async () => {
  const ws = setup();
  try {
    const before = ws.read('doc.md');
    const newMd = SAMPLE_DOC + '\n## Owner Addendum\nThe owner rewrote this in the Markdown editor.\n';
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

test('owner edit via /api/doc AFTER approval makes prior approvals stale', async () => {
  const ws = setup();
  try {
    assert.equal(submit(ws).code, 0);
    assert.equal(approve(ws, 'Alice').code, 0);
    assert.equal(status(ws).approvals.approved_for_current_version, true);

    const newMd = SAMPLE_DOC + '\n## Owner Addendum\nEdited after sign-off, so the hash drifts.\n';
    const { status: code } = await withServer(ws, (base) =>
      postJson(base, '/api/doc', { markdown: newMd }));
    assert.equal(code, 200);

    // approvals bind to the SUBMITTED hash; an owner edit drifts the live hash,
    // so the prior approval no longer counts for the current version.
    const s = status(ws);
    assert.equal(s.doc_edited_after_submit, true);
    assert.equal(s.approvals.approved_for_current_version, false);
    assert.notEqual(s.live_hash, s.state_hash);
    // a fresh approve must now be refused until the owner re-submits
    const res = approve(ws, 'Bob');
    assert.notEqual(res.code, 0, 'approve on an owner-drifted doc must fail');
    assert.match(res.stderr, /doc has changed since submit|submit again/i);
  } finally { ws.cleanup(); }
});

test('owner edit via /api/doc REFUSES empty markdown (guard, no file write)', async () => {
  const ws = setup();
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
  const ws = setup();
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

// ----------------------------------------------------------------------------
// Gap 2: --note on `approve` (optional, but must persist + render)
// ----------------------------------------------------------------------------

test('approve --note persists the note in the sidecar and renders it', () => {
  const ws = setup();
  try {
    assert.equal(submit(ws).code, 0);
    const NOTE = 'LGTM — ship it, the risks section is solid';
    const res = approve(ws, 'Alice', NOTE);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.status, 'approved');

    // persisted verbatim in the sidecar record
    const sidecar = readFileSync(ws.sidecar, 'utf8');
    assert.ok(sidecar.includes(NOTE), 'note must be written to doc.seal.md');

    // and surfaced in the rendered approvals panel
    const panel = approvalsHtml(renderHtml(ws));
    assert.ok(panel.includes('Alice'), 'approver shown');
    assert.ok(panel.includes(NOTE), 'approval note shown in the HTML');
  } finally { ws.cleanup(); }
});

test('approve WITHOUT --note succeeds (note is optional on approve)', () => {
  const ws = setup();
  try {
    assert.equal(submit(ws).code, 0);
    const res = approve(ws, 'Alice'); // no note
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.status, 'approved');
    // null note must not render a stray body / the literal "null"
    const panel = approvalsHtml(renderHtml(ws));
    assert.ok(panel.includes('Alice'));
    assert.ok(!/>\s*null\s*</.test(panel), 'a missing note must not render as "null"');
  } finally { ws.cleanup(); }
});

test('approve --note HTML-escapes the note (no XSS injection)', () => {
  const ws = setup();
  try {
    assert.equal(submit(ws).code, 0);
    const XSS = 'pwn <img src=x onerror=alert(1)> & "quote"';
    assert.equal(approve(ws, 'Alice', XSS).code, 0);
    const html = renderHtml(ws);
    const panel = approvalsHtml(html);
    // the raw onerror payload must not appear as a live tag in the panel
    assert.ok(!panel.includes('<img src=x onerror'), 'raw script-y note must be escaped');
    // the angle brackets must be entity-encoded somewhere in the output
    assert.ok(html.includes('&lt;img') || html.includes('&lt;'), 'note must be HTML-escaped');
  } finally { ws.cleanup(); }
});

// ----------------------------------------------------------------------------
// Gap 3: per-approval current / valid_now flags after supersession
// ----------------------------------------------------------------------------

test('re-submit then re-approve: old approval is superseded, new one is current', () => {
  const ws = setup();
  try {
    // approve v1
    assert.equal(submit(ws).code, 0);
    assert.equal(approve(ws, 'Alice', 'approve of v1').code, 0);

    // owner edits + re-submits => v1 approval is now bound to an OLD hash
    editDoc(ws, EDITED_DOC);
    assert.equal(submit(ws).code, 0);
    // status resets: the v1 approval no longer counts toward quorum
    let s = status(ws);
    assert.equal(s.status, 'in_review');
    assert.equal(s.approvals.approved, 0, 'stale v1 approval does not count');

    // re-approve against v2
    assert.equal(approve(ws, 'Alice', 'approve of v2').code, 0);
    s = status(ws);
    assert.equal(s.status, 'approved');
    assert.equal(s.approvals.approved, 1, 'only the v2 approval counts');
    assert.equal(s.approvals.approved_for_current_version, true);

    // The per-approval current/valid_now flags live in approvalState and surface
    // in the rendered approvals panel as superseded / current / stale tags.
    // Both approvals are stored; exactly ONE must be superseded (the v1 one).
    const panel = approvalsHtml(renderHtml(ws));
    assert.equal((panel.match(/superseded/g) || []).length, 1,
      'the old (v1) approval card must be tagged superseded');
    assert.ok(panel.includes('>current<'),
      'the live (v2) approval card must be tagged current');
    // both notes are retained in history
    assert.ok(panel.includes('approve of v1'));
    assert.ok(panel.includes('approve of v2'));
  } finally { ws.cleanup(); }
});

test('approval current but NOT valid_now is tagged "stale" after a post-submit edit', () => {
  const ws = setup();
  try {
    assert.equal(submit(ws).code, 0);
    assert.equal(approve(ws, 'Alice', 'sealed').code, 0);
    // edit AFTER approval but do NOT re-submit: the approval is still bound to
    // the submitted (state) hash => current:true, but valid_now:false because
    // the live doc has drifted. The panel must show "stale", not "current".
    editDoc(ws, EDITED_DOC);
    const s = status(ws);
    assert.equal(s.doc_edited_after_submit, true);
    assert.equal(s.approvals.approved_for_current_version, false);

    const panel = approvalsHtml(renderHtml(ws));
    assert.ok(panel.includes('>stale<'), 'current-but-drifted approval must be tagged stale');
    assert.ok(!panel.includes('>current<'), 'a drifted approval must not be tagged current');
    assert.equal((panel.match(/superseded/g) || []).length, 0,
      'the approval is still bound to the submitted hash, so not superseded');
  } finally { ws.cleanup(); }
});
