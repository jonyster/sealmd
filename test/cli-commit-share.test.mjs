// ============================================================================
// GIT SHARE / COMMIT-PUSH flow tests for the sealmd plugin.
//
// Covers:
//   - CLI `seal commit` (stage/commit/push, no-op, non-repo, ignore-list, remote)
//   - `serve` HTTP endpoints: GET /, POST /api/commit, /api/share, /api/autocommit
//
// Node built-in runner only. Zero third-party deps. Deterministic, no network
// beyond loopback. Imports the shared harness; never edits it.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SEAL, makeWorkspace, runSeal, SAMPLE_DOC } from './helper.mjs';

// Run a git command in a workspace and return trimmed stdout.
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// ---------------------------------------------------------------------------
// 1. commit stages + commits doc.md + .seal.md (+ summary), custom messages.
// ---------------------------------------------------------------------------
test('commit stages and commits doc + sidecar with -m message', () => {
  const ws = makeWorkspace({ git: true });
  try {
    const init = runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    assert.equal(init.code, 0, init.stderr);

    const res = runSeal(['commit', '--in', ws.doc, '-m', 'review: first pass'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.committed, true);
    assert.equal(res.json.message, 'review: first pass');

    // commit subject matches
    const subject = git(ws.dir, ['log', '-1', '--pretty=%s']);
    assert.equal(subject, 'review: first pass');

    // both files are in the commit
    const names = git(ws.dir, ['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean);
    assert.ok(names.includes('doc.md'), `doc.md in commit; got ${JSON.stringify(names)}`);
    assert.ok(names.includes('doc.seal.md'), `doc.seal.md in commit; got ${JSON.stringify(names)}`);
  } finally {
    ws.cleanup();
  }
});

test('commit honors --message and includes summary file when present', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    // create a role summary so the summary json exists and should be committed
    const sum = runSeal(['summary', '--in', ws.doc, '--role', 'Engineering',
      '--json', JSON.stringify({ lead: 'eng lead', key_decisions: ['ship it'] })], { cwd: ws.dir });
    assert.equal(sum.code, 0, sum.stderr);
    assert.ok(ws.exists('doc.seal.summary.json'), 'summary json should exist after seal summary');

    const res = runSeal(['commit', '--in', ws.doc, '--message', 'review: with summary'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.committed, true);
    assert.equal(git(ws.dir, ['log', '-1', '--pretty=%s']), 'review: with summary');

    const names = git(ws.dir, ['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean);
    assert.ok(names.includes('doc.md'));
    assert.ok(names.includes('doc.seal.md'));
    assert.ok(names.includes('doc.seal.summary.json'), `summary json in commit; got ${JSON.stringify(names)}`);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 2. commit again with no changes => committed:false, note, exit 0.
// ---------------------------------------------------------------------------
test('commit with no changes => committed false, nothing-to-commit note, exit 0', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    const first = runSeal(['commit', '--in', ws.doc], { cwd: ws.dir });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.json.committed, true);

    const second = runSeal(['commit', '--in', ws.doc], { cwd: ws.dir });
    assert.equal(second.code, 0, second.stderr);
    assert.equal(second.json.committed, false);
    assert.match(second.json.note, /nothing to commit/i);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 3. commit in a non-repo => non-zero exit, error mentions 'not a git repo'.
// ---------------------------------------------------------------------------
test('commit in a non-repo workspace => exit non-zero, "not a git repo" error', () => {
  const ws = makeWorkspace(); // no git
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    const res = runSeal(['commit', '--in', ws.doc], { cwd: ws.dir });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /not a git repo/i);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 4. NEVER stages gitignored/derived files.
// ---------------------------------------------------------------------------
test('commit never tracks derived html / notify / requests files', () => {
  const ws = makeWorkspace({ git: true });
  try {
    // init with notify channels so .seal.notify.json is written; render makes html
    const init = runSeal(['init', '--in', ws.doc, '--notify', 'slack'], { cwd: ws.dir });
    assert.equal(init.code, 0, init.stderr);
    assert.ok(ws.exists('doc.review.html'), 'html should be rendered by init');
    assert.ok(ws.exists('doc.seal.notify.json'), 'notify prefs should exist after --notify');

    const res = runSeal(['commit', '--in', ws.doc, '-m', 'review'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.committed, true);

    const tracked = git(ws.dir, ['ls-files']).split('\n').filter(Boolean);
    // only the shareable artifacts are tracked
    assert.ok(tracked.includes('doc.md'));
    assert.ok(tracked.includes('doc.seal.md'));
    for (const f of tracked) {
      assert.ok(!/\.review\.html$/.test(f), `must not track ${f}`);
      assert.ok(!/\.seal\.notify\.json$/.test(f), `must not track ${f}`);
      assert.ok(!/\.seal\.requests\.jsonl$/.test(f), `must not track ${f}`);
    }
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 5. push to a real (bare) remote.
// ---------------------------------------------------------------------------
test('commit --push lands the commit in a bare remote', () => {
  const ws = makeWorkspace({ git: true });
  const bare = mkdtempSync(join(tmpdir(), 'seal-bare-'));
  try {
    execFileSync('git', ['init', '--bare', '-q', bare], { stdio: 'ignore' });
    // upstream tracking so `git push` (no args) has a target
    git(ws.dir, ['remote', 'add', 'origin', bare]);

    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    // first commit so the branch exists (HEAD is unborn until then), then set upstream
    runSeal(['commit', '--in', ws.doc, '-m', 'seed'], { cwd: ws.dir });
    const branch = git(ws.dir, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'main';
    git(ws.dir, ['push', '-u', 'origin', branch]);

    // make a change, then commit --push
    ws.write('doc.md', SAMPLE_DOC + '\n## Extra\nMore content to commit.\n');
    const res = runSeal(['commit', '--in', ws.doc, '-m', 'review: pushed', '--push'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.committed, true);
    assert.equal(res.json.pushed, true, `pushError: ${res.json.pushError}`);
    assert.ok(res.json.pushError == null, `expected no pushError, got ${res.json.pushError}`);

    // verify the commit actually landed in the bare remote
    const remoteSubjects = execFileSync('git', ['--git-dir=' + bare, 'log', '--oneline'], { encoding: 'utf8' });
    assert.match(remoteSubjects, /review: pushed/);
  } finally {
    ws.cleanup();
    rmSync(bare, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 6. push with no remote => committed true, pushed false, pushError surfaced.
// ---------------------------------------------------------------------------
test('commit --push with no remote => committed true, pushed false, exit 0', () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    const res = runSeal(['commit', '--in', ws.doc, '-m', 'review', '--push'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.committed, true);
    assert.equal(res.json.pushed, false);
    assert.ok(res.json.pushError, 'a pushError should surface when no remote is configured');
  } finally {
    ws.cleanup();
  }
});

// ===========================================================================
// serve HTTP endpoints — the live "share" flow.
// ===========================================================================
// Spawn `seal serve` and wait for the serve_started SEAL_EVENT on stdout.
// Collects every SEAL_EVENT seen so tests can assert emitted event shapes.
function startServer({ cwd, doc, port, env = {} }) {
  const child = spawn(process.execPath, [SEAL, 'serve', '--in', doc, '--port', String(port)], {
    cwd, env: { ...process.env, CI: '1', NO_COLOR: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events = [];
  let stdoutBuf = '';
  let stderrBuf = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (d) => {
    stdoutBuf += d;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl); stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line.startsWith('SEAL_EVENT ')) {
        try { events.push(JSON.parse(line.slice('SEAL_EVENT '.length))); } catch {}
      }
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
    // hard backstop
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 2000);
  });

  // wait until an event of a given type appears (post-request assertions)
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
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, text };
}

// Unique-ish high ports per test to avoid collisions on reruns.
let PORT = 4451;
const nextPort = () => PORT++;

// ---------------------------------------------------------------------------
// 7. GET / returns 200 text/html containing the doc title.
// ---------------------------------------------------------------------------
test('serve: GET / returns the review page with the doc title', async () => {
  const ws = makeWorkspace({ git: true });
  runSeal(['init', '--in', ws.doc, '--title', 'Sample PRD'], { cwd: ws.dir });
  const port = nextPort();
  const srv = startServer({ cwd: ws.dir, doc: ws.doc, port });
  try {
    await srv.ready;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /text\/html/);
    const html = await res.text();
    assert.match(html, /Sample PRD/);
  } finally {
    await srv.stop();
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 8. POST /api/commit commits + emits a 'committed' SEAL_EVENT.
// ---------------------------------------------------------------------------
test('serve: POST /api/commit commits and emits committed event', async () => {
  const ws = makeWorkspace({ git: true });
  runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
  const port = nextPort();
  const srv = startServer({ cwd: ws.dir, doc: ws.doc, port });
  try {
    await srv.ready;
    const { status, json } = await postJSON(port, '/api/commit', { push: false });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.committed, true);

    const ev = await srv.waitForEvent('committed');
    assert.ok(ev, 'a committed SEAL_EVENT should be emitted');
    assert.equal(ev.committed, true);

    // and the commit really exists
    const subject = git(ws.dir, ['log', '-1', '--pretty=%s']);
    assert.match(subject, /seal: review/);
  } finally {
    await srv.stop();
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9. POST /api/share writes the portable html + emits a 'share_request' event.
// ---------------------------------------------------------------------------
test('serve: POST /api/share writes static html and emits share_request (github)', async () => {
  const ws = makeWorkspace({ git: true });
  runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
  const port = nextPort();
  const srv = startServer({ cwd: ws.dir, doc: ws.doc, port });
  try {
    await srv.ready;
    const { status, json } = await postJSON(port, '/api/share', { channels: ['github'] });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.ok(json.file, 'response carries the portable file path');
    assert.ok(existsSync(json.file), 'the portable static html file exists on disk');
    assert.deepEqual(json.channels, ['github']);
    assert.equal(json.dispatched, true);

    const ev = await srv.waitForEvent('share_request');
    assert.ok(ev, 'a share_request SEAL_EVENT should be emitted');
    assert.ok(ev.channels.includes('github'), 'event channels include github');
    assert.ok(ev.file, 'event carries the file path the console will share');
    assert.match(ev.hint, /MCP/i, 'hint tells the AI console to share via the MCP integration');
  } finally {
    await srv.stop();
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9b. POST /api/bundle zips review.html + sidecar + source .md (+ summary).
// ---------------------------------------------------------------------------
test('serve: POST /api/bundle bundles all shareable files into one zip', async () => {
  const ws = makeWorkspace({ git: true });
  runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
  const port = nextPort();
  const srv = startServer({ cwd: ws.dir, doc: ws.doc, port });
  try {
    await srv.ready;
    const { status, json } = await postJSON(port, '/api/bundle', {});
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    // the file list always names the three shareable artifacts (basenames)
    assert.ok(json.files.some((f) => /\.review\.html$/.test(f)), 'bundle lists the review html');
    assert.ok(json.files.some((f) => /\.seal\.md$/.test(f)), 'bundle lists the sidecar');
    assert.ok(json.files.some((f) => /(^|\/)doc\.md$/.test(f) || f === 'doc.md'), 'bundle lists the source md');
    if (json.zip) {
      // `zip` present on this platform → a real archive on disk
      assert.ok(existsSync(json.zip), 'zip archive exists on disk');
      assert.match(json.zip, /\.review-bundle\.zip$/);
    } else {
      // graceful fallback: no zip tool, hand back the folder instead
      assert.ok(json.dir && existsSync(json.dir), 'fallback returns the folder path');
    }
  } finally {
    await srv.stop();
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9d. GET /api/bundle.zip streams a real zip as a download attachment.
// ---------------------------------------------------------------------------
test('serve: GET /api/bundle.zip streams the bundle as a zip download', async () => {
  const ws = makeWorkspace({ git: true });
  runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
  const port = nextPort();
  const srv = startServer({ cwd: ws.dir, doc: ws.doc, port });
  try {
    await srv.ready;
    const res = await fetch(`http://127.0.0.1:${port}/api/bundle.zip`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/zip');
    assert.match(res.headers.get('content-disposition') || '', /attachment; filename=".*\.review-bundle\.zip"/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.ok(buf.length > 0, 'zip body is non-empty');
    assert.equal(buf.slice(0, 2).toString('latin1'), 'PK', 'starts with the zip magic bytes');
  } finally {
    await srv.stop();
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 9c. POST /api/send-email without SEAL_RESEND_KEY => sent:false (draft fallback)
// ---------------------------------------------------------------------------
test('serve: POST /api/send-email without Resend key => ok, sent:false, no-resend-key', async () => {
  const ws = makeWorkspace({ git: true });
  runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
  const port = nextPort();
  // explicitly ensure no key is present in the server env
  const srv = startServer({ cwd: ws.dir, doc: ws.doc, port, env: { SEAL_RESEND_KEY: '' } });
  try {
    await srv.ready;
    const { status, json } = await postJSON(port, '/api/send-email', { to: ['a@co.com'], subject: 'Review', body: 'hi' });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.sent, false);
    assert.equal(json.reason, 'no-resend-key');
  } finally {
    await srv.stop();
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// 10. POST /api/autocommit {on:true} => auto_commit:true.
// ---------------------------------------------------------------------------
test('serve: POST /api/autocommit {on:true} returns auto_commit true', async () => {
  const ws = makeWorkspace({ git: true });
  runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
  const port = nextPort();
  const srv = startServer({ cwd: ws.dir, doc: ws.doc, port });
  try {
    await srv.ready;
    const { status, json } = await postJSON(port, '/api/autocommit', { on: true });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.auto_commit, true);

    const off = await postJSON(port, '/api/autocommit', { on: false });
    assert.equal(off.json.auto_commit, false);
  } finally {
    await srv.stop();
    ws.cleanup();
  }
});
