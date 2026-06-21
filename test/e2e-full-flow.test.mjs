// ============================================================================
// END-TO-END full review lifecycle in ONE fresh tmp git repo with a LOCAL BARE
// remote as 'origin' (no GitHub). Drives BOTH layers:
//   - the CLI subcommands (init/comment/accept/submit/approve/request/render/commit)
//   - the serve HTTP API (POST /api/comment, /api/accept, /api/dismiss,
//     /api/doc, /api/commit) on a loopback port, asserting JSON shape AND the
//     resulting .seal.md sidecar + doc.md on disk.
//
// One workspace, several documents, full lifecycle, asserting state at each step:
//   init -> anchored comment -> general (unanchored) comment -> suggestion ->
//   reply -> resolve -> dismiss -> accept (assert doc.md changed + hash drift) ->
//   owner edit via /api/doc (assert hash change + approvals stale) -> submit ->
//   approve + request-changes from two approvers -> render (assert .review.html
//   markers) -> commit (assert .seal.md + doc committed, push to the bare remote).
//   Anchors are asserted to re-anchor after the edit.
//
// Node built-in runner only. Zero third-party deps. Loopback + local FS only.
// Imports the shared harness; never edits it. Local helpers live in THIS file so
// parallel authors never race on helper.mjs.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SEAL, runSeal, sealToken } from './helper.mjs';

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// A multi-doc tmp git repo wired to a LOCAL BARE remote named origin.
function makeRepoWithRemote(docs) {
  const dir = mkdtempSync(join(tmpdir(), 'seal-e2e-'));
  const bare = mkdtempSync(join(tmpdir(), 'seal-e2e-bare-'));
  execFileSync('git', ['init', '--bare', '-q', bare], { stdio: 'ignore' });
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
  git(dir, ['config', 'user.name', 'E2E User']);
  git(dir, ['config', 'user.email', 'e2e@example.com']);
  git(dir, ['remote', 'add', 'origin', bare]);
  for (const [name, body] of Object.entries(docs)) writeFileSync(join(dir, name), body, 'utf8');
  return {
    dir, bare,
    doc: (name) => join(dir, name),
    read: (name) => readFileSync(join(dir, name), 'utf8'),
    exists: (name) => existsSync(join(dir, name)),
    cleanup: () => { for (const p of [dir, bare]) { try { rmSync(p, { recursive: true, force: true }); } catch {} } },
  };
}

function startServer({ cwd, doc, port, env = {} }) {
  const child = spawn(process.execPath, [SEAL, 'serve', '--in', doc, '--port', String(port)], {
    cwd, env: { ...process.env, CI: '1', NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events = [];
  let stdoutBuf = '', stderrBuf = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    stdoutBuf += d;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl); stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.startsWith('SEAL_EVENT ')) { try { events.push(JSON.parse(line.slice('SEAL_EVENT '.length))); } catch {} }
    }
  });
  child.stderr.on('data', (d) => { stderrBuf += d; });

  const ready = (async () => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (events.some((e) => e.type === 'serve_started')) return;
      if (child.exitCode !== null) throw new Error(`server exited early (code ${child.exitCode}): ${stderrBuf}`);
      await delay(50);
    }
    throw new Error(`server never emitted serve_started: ${stderrBuf}`);
  })();

  const stop = () => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 2000);
  });

  const waitForEvent = async (type, timeout = 3000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ev = events.find((e) => e.type === type);
      if (ev) return ev;
      await delay(25);
    }
    return null;
  };

  return { child, events, ready, stop, waitForEvent, getStderr: () => stderrBuf };
}

async function postJSON(port, path, body) {
  const base = `http://127.0.0.1:${port}`;
  const res = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-seal-token': await sealToken(base) },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

function commentRecords(repo, sidecarName) {
  const sidecar = repo.read(sidecarName);
  const out = [];
  const re = /```json seal:comment\n([\s\S]*?)\n```/g;
  let m;
  while ((m = re.exec(sidecar)) !== null) out.push(JSON.parse(m[1]));
  return out;
}

function statusJson(repo, doc) {
  const res = runSeal(['status', '--in', doc, '--json'], { cwd: repo.dir });
  assert.equal(res.code, 0, res.stderr);
  return res.json;
}
function hash(repo, doc) {
  return runSeal(['hash', '--in', doc], { cwd: repo.dir }).json.content_hash;
}

let PORT = 4720;
const nextPort = () => PORT++;

const DOC_A = `# Payments Spec

## Overview
The system uses Postgres for storage and Redis for caching across regions.

## Goals
Ship a fully local review tool with zero network calls and strong privacy.

## Risks
There is a risk that anchors drift when the document changes underneath them.
`;

const DOC_B = `# Auth Spec

## Overview
Sessions are signed with HMAC and rotated every twenty four hours by default.
`;

const DOC_C = `# Infra Spec

## Overview
Workers run on a single queue and scale horizontally under sustained load.
`;

test('E2E: full review lifecycle across CLI + serve API, push to a local bare remote', async () => {
  const repo = makeRepoWithRemote({ 'payments.md': DOC_A, 'auth.md': DOC_B, 'infra.md': DOC_C });
  const docA = repo.doc('payments.md');
  const docB = repo.doc('auth.md');
  const docC = repo.doc('infra.md');
  let srv = null;
  try {
    // ---- init all three docs (CLI). Quorum 2 on the primary doc. ----
    const initA = runSeal(['init', '--in', docA, '--title', 'Payments Spec', '--quorum', '2', '--owner', 'Owner One'], { cwd: repo.dir });
    assert.equal(initA.code, 0, initA.stderr);
    assert.equal(initA.json.ok, true);
    assert.equal(initA.json.action, 'init');
    assert.ok(repo.exists('payments.seal.md'), 'sidecar A created');
    assert.equal(runSeal(['init', '--in', docB, '--title', 'Auth Spec'], { cwd: repo.dir }).code, 0);
    assert.equal(runSeal(['init', '--in', docC, '--title', 'Infra Spec'], { cwd: repo.dir }).code, 0);

    // Seed an initial commit and set upstream tracking so the later bare `git push`
    // (issued by coreCommit on /api/commit) has a target. Mirrors how a real repo
    // already has an upstream before the review starts.
    git(repo.dir, ['add', '-A']);
    git(repo.dir, ['commit', '-q', '-m', 'seed: docs + review files']);
    const branch = git(repo.dir, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
    git(repo.dir, ['push', '-q', '-u', 'origin', branch]);

    let s = statusJson(repo, docA);
    assert.equal(s.status, 'draft');
    assert.equal(s.approvals.quorum, 2);
    assert.equal(s.comments.total, 0);

    // ---- anchored comment on a REAL quote (CLI) ----
    const anchored = runSeal(['comment', '--in', docA, '--author', 'Reviewer A',
      '--body', 'Why Postgres and not the managed option?', '--anchor', 'Postgres for storage'], { cwd: repo.dir });
    assert.equal(anchored.code, 0, anchored.stderr);
    assert.equal(anchored.json.action, 'comment');
    assert.equal(anchored.json.anchored, true);
    const anchoredId = anchored.json.id;

    // ---- general / UNANCHORED comment (no --anchor) ----
    const general = runSeal(['comment', '--in', docA, '--author', 'Reviewer B',
      '--body', 'Overall the privacy story is strong. Ship it.'], { cwd: repo.dir });
    assert.equal(general.code, 0, general.stderr);
    assert.equal(general.json.action, 'comment');
    assert.equal(general.json.anchored, false, 'general comment carries no anchor');
    const generalId = general.json.id;

    // ---- suggestion (anchored, required) ----
    const suggest = runSeal(['comment', '--in', docA, '--author', 'Reviewer A',
      '--body', 'Prefer Memcached here', '--anchor', 'Redis for caching', '--suggest', 'Memcached for caching'], { cwd: repo.dir });
    assert.equal(suggest.code, 0, suggest.stderr);
    assert.equal(suggest.json.action, 'suggest');
    const suggestId = suggest.json.id;

    s = statusJson(repo, docA);
    assert.equal(s.comments.total, 3);
    assert.equal(s.comments.open, 3);

    // ---- reply to the anchored comment (CLI) ----
    const reply = runSeal(['reply', '--in', docA, '--id', anchoredId, '--author', 'Owner One',
      '--body', 'Postgres is a hard requirement from compliance.'], { cwd: repo.dir });
    assert.equal(reply.code, 0, reply.stderr);
    let recs = commentRecords(repo, 'payments.seal.md');
    const anchoredRec = recs.find((c) => c.id === anchoredId);
    assert.ok(anchoredRec, 'anchored comment present in sidecar');
    assert.equal(anchoredRec.thread.length, 1, 'one reply persisted');
    assert.match(anchoredRec.thread[0].body, /hard requirement/);

    // ---- resolve the anchored comment (CLI) ----
    const resolved = runSeal(['resolve', '--in', docA, '--id', anchoredId], { cwd: repo.dir });
    assert.equal(resolved.code, 0, resolved.stderr);
    s = statusJson(repo, docA);
    assert.equal(s.comments.open, 2, 'one resolved -> 2 open');

    // ===== SERVE layer for dismiss + accept + doc-edit + commit =====
    const port = nextPort();
    srv = startServer({ cwd: repo.dir, doc: docA, port });
    await srv.ready;

    const pageRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(pageRes.status, 200);
    assert.match(await pageRes.text(), /Payments Spec/);

    // ---- dismiss the GENERAL comment via the API ----
    const dis = await postJSON(port, '/api/dismiss', { id: generalId });
    assert.equal(dis.status, 200);
    assert.equal(dis.json.ok, true);
    assert.equal(dis.json.id, generalId);
    assert.ok(await srv.waitForEvent('dismiss'), 'dismiss event emitted');
    recs = commentRecords(repo, 'payments.seal.md');
    assert.equal(recs.find((c) => c.id === generalId).status, 'resolved');

    // ---- ADD a fresh comment via the API ----
    const apiComment = await postJSON(port, '/api/comment', { author: 'Reviewer C', body: 'Nit: clarify region failover.', anchor: 'across regions' });
    assert.equal(apiComment.status, 200);
    assert.equal(apiComment.json.ok, true);
    assert.equal(apiComment.json.anchored, true);
    assert.match(apiComment.json.id, /^c_/);
    assert.ok(await srv.waitForEvent('comment'), 'comment event emitted');

    // ---- accept the SUGGESTION via the API (doc.md changed + hash drift) ----
    const beforeAcceptHash = hash(repo, docA);
    const beforeDoc = repo.read('payments.md');
    assert.ok(beforeDoc.includes('Redis for caching'), 'pre-accept span present');

    const acc = await postJSON(port, '/api/accept', { id: suggestId });
    assert.equal(acc.status, 200);
    assert.equal(acc.json.ok, true);
    assert.equal(acc.json.id, suggestId);
    assert.ok(acc.json.content_hash, 'accept returns the new content hash');
    assert.ok(await srv.waitForEvent('accept'), 'accept event emitted');

    const afterDoc = repo.read('payments.md');
    assert.ok(!afterDoc.includes('Redis for caching'), 'old span gone from doc.md');
    assert.ok(afterDoc.includes('Memcached for caching'), 'replacement written to doc.md');
    assert.ok(afterDoc.includes('Postgres for storage'), 'neighbor text intact');
    const afterAcceptHash = hash(repo, docA);
    assert.notEqual(afterAcceptHash, beforeAcceptHash, 'content hash drifted after accept');
    assert.equal(acc.json.content_hash, afterAcceptHash, 'reported hash == live hash');
    const sugRec = commentRecords(repo, 'payments.seal.md').find((c) => c.id === suggestId);
    assert.equal(sugRec.status, 'resolved');
    assert.equal(sugRec.accepted, true);

    // ===== SUBMIT (CLI) -> pins to the live (post-accept) version =====
    const sub = runSeal(['submit', '--in', docA], { cwd: repo.dir });
    assert.equal(sub.code, 0, sub.stderr);
    assert.equal(sub.json.status, 'in_review');
    const submittedHash = sub.json.content_hash;
    assert.equal(submittedHash, afterAcceptHash, 'submit pins the live version');

    const ap1 = runSeal(['approve', '--in', docA, '--approver', 'Approver One', '--note', 'LGTM'], { cwd: repo.dir });
    assert.equal(ap1.code, 0, ap1.stderr);
    const rq = runSeal(['request', '--in', docA, '--approver', 'Approver Two', '--note', 'needs a rollback plan'], { cwd: repo.dir });
    assert.equal(rq.code, 0, rq.stderr);

    s = statusJson(repo, docA);
    assert.equal(s.status, 'changes_requested', 'a veto dominates over an approval');
    assert.equal(s.approvals.approved, 1);
    assert.deepEqual(s.approvals.vetoes, ['Approver Two']);

    // ===== OWNER EDIT via /api/doc — hash change + approvals stale =====
    const editedMarkdown = afterDoc.replace(
      'There is a risk that anchors drift when the document changes underneath them.',
      'There is a risk that anchors drift when the document changes underneath them.\n\nWe mitigate drift with prefix/suffix context windows.');
    const beforeEditHash = hash(repo, docA);
    const docEdit = await postJSON(port, '/api/doc', { markdown: editedMarkdown });
    assert.equal(docEdit.status, 200);
    assert.equal(docEdit.json.ok, true);
    assert.ok(docEdit.json.content_hash, 'doc edit returns a content hash');
    assert.ok(await srv.waitForEvent('doc_edited'), 'doc_edited event emitted');

    const afterEditHash = hash(repo, docA);
    assert.notEqual(afterEditHash, beforeEditHash, 'hash changed after the owner edit');
    assert.ok(repo.read('payments.md').includes('prefix/suffix context windows'), 'edit landed on disk');

    s = statusJson(repo, docA);
    assert.equal(s.doc_edited_after_submit, true, 'approvals go stale after a post-submit edit');
    assert.equal(s.approvals.approved_for_current_version, false, 'no longer approved for the live version');
    assert.equal(s.state_hash, submittedHash, 'state still pinned to the submitted version');
    assert.notEqual(s.live_hash, s.state_hash, 'live drifted from pinned');

    // Anchors RE-ANCHOR: the surviving "across regions" anchor still resolves
    // after the edit. (The accepted suggestion's old quote "Redis for caching"
    // is legitimately gone, so it is the ONE expected unanchored record.)
    const sc = statusJson(repo, docA);
    assert.equal(sc.unanchored_comments, 1, 'only the accepted/replaced span lost its anchor');
    const anchorStatuses = runSeal(['status', '--in', docA, '--json'], { cwd: repo.dir }).json;
    assert.equal(anchorStatuses.unanchored_comments, 1, 'exactly one anchor lost (the replaced span)');
    const postEditComment = runSeal(['comment', '--in', docA, '--author', 'Reviewer A',
      '--body', 'good mitigation', '--anchor', 'prefix/suffix context windows'], { cwd: repo.dir });
    assert.equal(postEditComment.code, 0, postEditComment.stderr);
    assert.equal(postEditComment.json.anchored, true, 're-anchors against the edited doc');

    const resub = runSeal(['submit', '--in', docA], { cwd: repo.dir });
    assert.equal(resub.code, 0, resub.stderr);
    assert.equal(resub.json.content_hash, afterEditHash, 're-submit pins the edited version');
    s = statusJson(repo, docA);
    assert.equal(s.doc_edited_after_submit, false, 'no longer stale after re-submit');

    // ===== RENDER (CLI) — .review.html markers =====
    const rend = runSeal(['render', '--in', docA], { cwd: repo.dir });
    assert.equal(rend.code, 0, rend.stderr);
    assert.ok(repo.exists('payments.review.html'), 'review html produced');
    const html = repo.read('payments.review.html');
    assert.match(html, /Payments Spec/, 'title rendered');
    assert.match(html, /Memcached for caching/, 'accepted suggestion reflected in the doc body');
    assert.match(html, /good mitigation/, 'a live comment body is present');
    assert.match(html, /class="badge/, 'status badge marker present');
    assert.match(html, /window\.__/, 'the live page hydration marker is present');

    // ===== COMMIT via the serve API -> push to the bare remote =====
    const commit = await postJSON(port, '/api/commit', { message: 'review: payments pass 1', push: true });
    assert.equal(commit.status, 200);
    assert.equal(commit.json.ok, true);
    assert.equal(commit.json.committed, true);
    assert.equal(commit.json.pushed, true, `push should succeed; pushError=${commit.json.push_error}`);
    assert.ok(commit.json.push_error == null, `no pushError expected, got ${commit.json.push_error}`);
    assert.ok(await srv.waitForEvent('committed'), 'committed event emitted');

    const names = git(repo.dir, ['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean);
    assert.ok(names.includes('payments.md'), `doc.md committed; got ${JSON.stringify(names)}`);
    assert.ok(names.includes('payments.seal.md'), `sidecar committed; got ${JSON.stringify(names)}`);
    for (const f of git(repo.dir, ['ls-files']).split('\n').filter(Boolean)) {
      assert.ok(!/\.review\.html$/.test(f), `derived html must not be tracked: ${f}`);
    }

    const remoteLog = execFileSync('git', ['--git-dir=' + repo.bare, 'log', '--oneline'], { encoding: 'utf8' });
    assert.match(remoteLog, /review: payments pass 1/, 'commit landed in the bare remote');

    s = statusJson(repo, docA);
    assert.equal(s.comments.total >= 3, true, 'all comments accounted for');
    const dr = runSeal(['doctor', '--in', docA, '--json'], { cwd: repo.dir });
    assert.equal(dr.code, 0, dr.stderr);
    assert.equal(dr.json.valid, true, 'sidecar is well-formed after the full lifecycle');
  } finally {
    if (srv) await srv.stop();
    repo.cleanup();
  }
});
