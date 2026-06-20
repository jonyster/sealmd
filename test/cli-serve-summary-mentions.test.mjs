// ============================================================================
// Whole-suite gap coverage: the CLI commands & integrations the reviewer flagged
// as having ZERO direct tests:
//   - `summary` (cmdSummary): role upsert, JSON-shape coercion, invalid-JSON die,
//     --file / --json / stdin input paths.
//   - `pending` (cmdPending): request-draining + fuzzy findRole.
//   - `start` (cmdStart): init-if-needed + shareability stderr guidance.
//   - `serve` (cmdServe): the HTTP server + /api/* routes, exercised live over
//     loopback (spawn, fetch, kill). Cores (coreSaveDoc/coreCommit) get hit too.
//   - @mention integration END-TO-END: `comment --mention name` and inline @tokens
//     resolving against doc-scraped people / a .seal.people.json, persisted into
//     the sidecar comment record.
//   - init `--notify` setup path: writes a gitignored .seal.notify.json and records
//     the channel choice on the document record.
//
// APPEND-ONLY. Imports the shared harness, defines only local helpers here.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { makeWorkspace, initWorkspace, runSeal, SEAL } from './helper.mjs';

// ---------------------------------------------------------------------------
// local helpers (NOT added to the shared harness — parallel authors race on it)
// ---------------------------------------------------------------------------

// Pull every parsed `json seal:<kind>` record of one kind out of a sidecar body.
function readRecords(sidecarText, kind) {
  const re = new RegExp('```json seal:' + kind + '\\n([\\s\\S]*?)\\n```', 'g');
  const out = [];
  let m;
  while ((m = re.exec(sidecarText))) {
    try { out.push(JSON.parse(m[1])); } catch { /* skip */ }
  }
  return out;
}

// Spawn `seal serve` on an ephemeral-ish port, wait for the listen line on
// stderr, hand the caller a fetch base + the live process, then guarantee kill.
// Port is randomized per call to avoid collisions across parallel test files.
async function withServe(ws, extraArgs, fn) {
  const port = 14000 + Math.floor(Math.random() * 50000);
  const child = spawn(process.execPath, [SEAL, 'serve', '--in', ws.doc, '--port', String(port), ...(extraArgs || [])], {
    cwd: ws.dir,
    env: { ...process.env, CI: '1', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  // wait for the server to actually be listening (or the process to die)
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (/live review at/.test(stderr) || /seal serve/.test(stderr)) {
      try { await fetch(base + '/api/state'); ready = true; break; } catch { /* not up yet */ }
    }
    if (child.exitCode != null) break;
    await delay(50);
  }
  try {
    if (!ready) throw new Error(`serve never came up. stderr=${stderr} stdout=${stdout}`);
    return await fn({ base, port, child, getStdout: () => stdout, getStderr: () => stderr });
  } finally {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    // give the kernel a beat to release the port
    await delay(20);
  }
}

const jpost = (base, path, body) =>
  fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

// ===========================================================================
// summary (cmdSummary)
// ===========================================================================

test('summary --json upserts a role and writes <doc>.seal.summary.json', () => {
  const ws = initWorkspace();
  try {
    const body = JSON.stringify({
      lead: 'You own the rollout call.',
      key_decisions: ['Ship behind a flag', 'Pick the region'],
      relevant_sections: ['Goals'],
      needs_attention: ['Anchor drift risk'],
    });
    const res = runSeal(['summary', '--in', ws.doc, '--role', 'Eng Lead', '--json', body], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.action, 'summary');
    assert.equal(res.json.role, 'Eng Lead');
    assert.ok(ws.exists('doc.seal.summary.json'), 'summary json file created');
    const saved = JSON.parse(ws.read('doc.seal.summary.json'));
    assert.ok(Array.isArray(saved.roles), 'roles is an array');
    assert.equal(saved.roles.length, 1);
    const role = saved.roles[0];
    assert.equal(role.role, 'Eng Lead');
    assert.equal(role.lead, 'You own the rollout call.');
    assert.deepEqual(role.key_decisions, ['Ship behind a flag', 'Pick the region']);
    assert.deepEqual(role.relevant_sections, ['Goals']);
    assert.deepEqual(role.needs_attention, ['Anchor drift risk']);
  } finally { ws.cleanup(); }
});

test('summary coerces alternate field names (role_lead / sections / needs_your_judgment)', () => {
  const ws = initWorkspace();
  try {
    const body = JSON.stringify({
      role_lead: 'alt lead field',
      sections: ['Overview'],
      needs_your_judgment: ['the tradeoff'],
    });
    const res = runSeal(['summary', '--in', ws.doc, '--role', 'PM', '--json', body], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    const role = JSON.parse(ws.read('doc.seal.summary.json')).roles[0];
    assert.equal(role.lead, 'alt lead field', 'role_lead coerced to lead');
    assert.deepEqual(role.relevant_sections, ['Overview'], 'sections coerced to relevant_sections');
    assert.deepEqual(role.needs_attention, ['the tradeoff'], 'needs_your_judgment coerced');
  } finally { ws.cleanup(); }
});

test('summary defaults missing fields to empty lead / empty arrays', () => {
  const ws = initWorkspace();
  try {
    const res = runSeal(['summary', '--in', ws.doc, '--role', 'Legal', '--json', '{}'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    const role = JSON.parse(ws.read('doc.seal.summary.json')).roles[0];
    assert.equal(role.lead, '');
    assert.deepEqual(role.key_decisions, []);
    assert.deepEqual(role.relevant_sections, []);
    assert.deepEqual(role.needs_attention, []);
  } finally { ws.cleanup(); }
});

test('summary upsert REPLACES an existing role (case-insensitive) rather than duplicating', () => {
  const ws = initWorkspace();
  try {
    runSeal(['summary', '--in', ws.doc, '--role', 'Eng Lead', '--json', JSON.stringify({ lead: 'v1' })], { cwd: ws.dir });
    const r2 = runSeal(['summary', '--in', ws.doc, '--role', 'eng lead', '--json', JSON.stringify({ lead: 'v2' })], { cwd: ws.dir });
    assert.equal(r2.code, 0, r2.stderr);
    const roles = JSON.parse(ws.read('doc.seal.summary.json')).roles;
    assert.equal(roles.length, 1, 'replaced, not duplicated');
    assert.equal(roles[0].lead, 'v2');
    // the label retained is the NEW one passed in (matches upsertSummaryRole)
    assert.equal(roles[0].role, 'eng lead');
  } finally { ws.cleanup(); }
});

test('summary reads the body from --file', () => {
  const ws = initWorkspace();
  try {
    ws.write('sum.json', JSON.stringify({ lead: 'from a file', key_decisions: ['x'] }));
    const res = runSeal(['summary', '--in', ws.doc, '--role', 'Design', '--file', 'sum.json'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    const role = JSON.parse(ws.read('doc.seal.summary.json')).roles[0];
    assert.equal(role.lead, 'from a file');
    assert.deepEqual(role.key_decisions, ['x']);
  } finally { ws.cleanup(); }
});

test('summary reads the body from stdin when no --json/--file', () => {
  const ws = initWorkspace();
  try {
    const res = runSeal(['summary', '--in', ws.doc, '--role', 'CTO'], {
      cwd: ws.dir,
      input: JSON.stringify({ lead: 'piped in', key_decisions: ['k'] }),
    });
    assert.equal(res.code, 0, res.stderr);
    const role = JSON.parse(ws.read('doc.seal.summary.json')).roles[0];
    assert.equal(role.lead, 'piped in');
  } finally { ws.cleanup(); }
});

test('summary with invalid JSON fails loud (non-zero + message), writes no file', () => {
  const ws = initWorkspace();
  try {
    const res = runSeal(['summary', '--in', ws.doc, '--role', 'PM', '--json', '{not valid json'], { cwd: ws.dir });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /summary JSON invalid/i);
    assert.ok(!ws.exists('doc.seal.summary.json'), 'no summary file on invalid input');
  } finally { ws.cleanup(); }
});

test('summary without --role fails loud', () => {
  const ws = initWorkspace();
  try {
    const res = runSeal(['summary', '--in', ws.doc, '--json', '{}'], { cwd: ws.dir });
    assert.notEqual(res.code, 0);
    assert.match(res.stderr, /--role/);
  } finally { ws.cleanup(); }
});

// ===========================================================================
// pending (cmdPending)
// ===========================================================================

test('pending lists requested roles that have no summary yet (drains the requests jsonl)', () => {
  const ws = initWorkspace();
  try {
    ws.write('doc.seal.requests.jsonl',
      JSON.stringify({ role: 'Eng Lead', at: '2026-01-01T00:00:00Z' }) + '\n' +
      JSON.stringify({ role: 'Legal Counsel', at: '2026-01-01T00:00:01Z' }) + '\n');
    const res = runSeal(['pending', '--in', ws.doc], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.action, 'pending');
    assert.deepEqual(res.json.pending.sort(), ['Eng Lead', 'Legal Counsel']);
  } finally { ws.cleanup(); }
});

test('pending dedupes repeated role requests (case-insensitive)', () => {
  const ws = initWorkspace();
  try {
    ws.write('doc.seal.requests.jsonl',
      JSON.stringify({ role: 'PM' }) + '\n' +
      JSON.stringify({ role: 'pm' }) + '\n' +
      JSON.stringify({ role: 'PM' }) + '\n');
    const res = runSeal(['pending', '--in', ws.doc], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.pending.length, 1, 'deduped to a single entry');
  } finally { ws.cleanup(); }
});

test('pending omits roles already fulfilled — fuzzy findRole match', () => {
  const ws = initWorkspace();
  try {
    // a summary already exists for "Engineering Lead"
    runSeal(['summary', '--in', ws.doc, '--role', 'Engineering Lead', '--json', JSON.stringify({ lead: 'done' })], { cwd: ws.dir });
    // request comes in for the looser label "Eng" — should be considered fulfilled (fuzzy)
    ws.write('doc.seal.requests.jsonl',
      JSON.stringify({ role: 'Eng' }) + '\n' +
      JSON.stringify({ role: 'Security' }) + '\n');
    const res = runSeal(['pending', '--in', ws.doc], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(!res.json.pending.includes('Eng'), 'fuzzy-matched role is not pending');
    assert.deepEqual(res.json.pending, ['Security']);
  } finally { ws.cleanup(); }
});

test('pending skips malformed/blank jsonl lines without crashing', () => {
  const ws = initWorkspace();
  try {
    ws.write('doc.seal.requests.jsonl',
      'not json\n' +
      '\n' +
      JSON.stringify({ role: '' }) + '\n' +     // blank role ignored
      JSON.stringify({ role: 'Valid Role' }) + '\n');
    const res = runSeal(['pending', '--in', ws.doc], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(res.json.pending, ['Valid Role']);
  } finally { ws.cleanup(); }
});

test('pending with no requests file returns an empty list (no error)', () => {
  const ws = initWorkspace();
  try {
    const res = runSeal(['pending', '--in', ws.doc], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(res.json.pending, []);
  } finally { ws.cleanup(); }
});

// ===========================================================================
// init --notify setup path
// ===========================================================================

test('init --notify writes a gitignored .seal.notify.json and records channels on the document', () => {
  const ws = makeWorkspace({ git: true });
  try {
    const res = runSeal(['init', '--in', ws.doc,
      '--notify', 'slack,email',
      '--slack-webhook', 'https://hooks.example/T/B/xyz',
      '--email-to', 'team@co.com'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(res.json.notify, ['slack', 'email']);
    assert.ok(res.json.notify_file, 'notify_file path reported');
    assert.ok(ws.exists('doc.seal.notify.json'), 'notify prefs file written');

    const prefs = JSON.parse(ws.read('doc.seal.notify.json'));
    assert.deepEqual(prefs.channels, ['slack', 'email']);
    assert.equal(prefs.slack_webhook, 'https://hooks.example/T/B/xyz');
    assert.equal(prefs.email_to, 'team@co.com');

    // document record carries the (non-secret) channel choice
    const doc = readRecords(ws.read('doc.seal.md'), 'document')[0];
    assert.deepEqual(doc.notify, ['slack', 'email'], 'channels recorded on the document');

    // secrets are gitignored
    const gi = ws.read('.gitignore');
    assert.match(gi, /\.seal\.notify\.json/, 'notify prefs file is gitignored');
  } finally { ws.cleanup(); }
});

test('init without --notify writes NO notify file and omits notify on the document', () => {
  const ws = makeWorkspace({ git: true });
  try {
    const res = runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(res.json.notify, [], 'no channels');
    assert.equal(res.json.notify_file, null);
    assert.ok(!ws.exists('doc.seal.notify.json'), 'no notify prefs file');
    const doc = readRecords(ws.read('doc.seal.md'), 'document')[0];
    assert.ok(doc.notify === undefined, 'document.notify omitted when no channels');
  } finally { ws.cleanup(); }
});

test('init --notify normalizes/trims channel tokens and drops empties', () => {
  const ws = makeWorkspace({ git: true });
  try {
    const res = runSeal(['init', '--in', ws.doc, '--notify', ' Slack , ,TEAMS '], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(res.json.notify, ['slack', 'teams']);
  } finally { ws.cleanup(); }
});

// ===========================================================================
// @mention integration END-TO-END (CLI -> sidecar record)
// ===========================================================================

const MENTION_DOC = `# Spec

| Role | Name |
| --- | --- |
| Owner | Alice Carter |
| Reviewer | Bob Lin |

## Body
Some text to anchor against in the body of the document.
`;

test('comment --mention resolves a doc-scraped person and persists name+handle into the comment', () => {
  const ws = makeWorkspace({ git: true, content: MENTION_DOC });
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    const res = runSeal(['comment', '--in', ws.doc, '--author', 'Me', '--body', 'please look', '--mention', 'alice', '--no-render'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.mentions.length, 1);
    assert.equal(res.json.mentions[0].name, 'alice');
    assert.equal(res.json.mentions[0].handle, 'alice-carter');

    const cm = readRecords(ws.read('doc.seal.md'), 'comment').at(-1);
    assert.ok(Array.isArray(cm.mentions), 'mentions persisted on the comment record');
    assert.equal(cm.mentions[0].name, 'alice');
    assert.equal(cm.mentions[0].handle, 'alice-carter');
  } finally { ws.cleanup(); }
});

test('inline @tokens in the body resolve against doc-scraped people and persist', () => {
  const ws = makeWorkspace({ git: true, content: MENTION_DOC });
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    const res = runSeal(['comment', '--in', ws.doc, '--author', 'Me', '--body', 'hey @bob can you confirm?', '--no-render'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    const handles = res.json.mentions.map((m) => m.handle);
    assert.ok(handles.includes('bob-lin'), `bob resolved to a handle, got ${JSON.stringify(res.json.mentions)}`);
    const cm = readRecords(ws.read('doc.seal.md'), 'comment').at(-1);
    assert.ok(cm.mentions.some((m) => m.handle === 'bob-lin'), 'persisted on record');
  } finally { ws.cleanup(); }
});

test('@token + --mention union is deduped in the persisted comment', () => {
  const ws = makeWorkspace({ git: true, content: MENTION_DOC });
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    const res = runSeal(['comment', '--in', ws.doc, '--body', '@alice and also', '--mention', 'alice,bob', '--no-render'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    const names = res.json.mentions.map((m) => m.name.toLowerCase());
    assert.equal(new Set(names).size, names.length, 'no duplicate people');
    assert.ok(names.includes('alice'));
    assert.ok(names.includes('bob'));
  } finally { ws.cleanup(); }
});

test('.seal.people.json overrides/extends doc-scraped people; handle is honored', () => {
  const ws = makeWorkspace({ git: true, content: MENTION_DOC });
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    // curate a handle + a person not in the doc
    ws.write('doc.seal.people.json', JSON.stringify({
      carol: { handle: 'carol-x', email: 'carol@co.com', slack: '@carol' },
    }));
    const res = runSeal(['comment', '--in', ws.doc, '--body', 'cc @carol', '--no-render'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.ok(res.json.mentions.some((m) => m.handle === 'carol-x'), `curated handle honored, got ${JSON.stringify(res.json.mentions)}`);
  } finally { ws.cleanup(); }
});

test('an unknown @mention falls back to the bare name as its own handle', () => {
  const ws = makeWorkspace({ git: true, content: MENTION_DOC });
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    const res = runSeal(['comment', '--in', ws.doc, '--body', 'cc @zoltan', '--no-render'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    const z = res.json.mentions.find((m) => m.name === 'zoltan');
    assert.ok(z, 'unknown mention still resolved (name as handle)');
    assert.equal(z.handle, 'zoltan');
  } finally { ws.cleanup(); }
});

test('comment with no mentions omits the mentions field on the record', () => {
  const ws = makeWorkspace({ git: true, content: MENTION_DOC });
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    const res = runSeal(['comment', '--in', ws.doc, '--body', 'plain comment, no tags', '--no-render'], { cwd: ws.dir });
    assert.equal(res.code, 0, res.stderr);
    assert.deepEqual(res.json.mentions, []);
    const cm = readRecords(ws.read('doc.seal.md'), 'comment').at(-1);
    assert.ok(cm.mentions === undefined, 'mentions field omitted when empty');
  } finally { ws.cleanup(); }
});

// ===========================================================================
// start (cmdStart) — init-if-needed + shareability stderr
//   NOTE: cmdStart() ends by calling cmdServe(), which binds a port and blocks.
//   So we spawn it like serve and inspect the stderr guidance + that the sidecar
//   got created, then kill it.
// ===========================================================================

async function spawnStart(ws, extraArgs) {
  const port = 14000 + Math.floor(Math.random() * 50000);
  const child = spawn(process.execPath, [SEAL, 'start', '--in', ws.doc, '--port', String(port), ...(extraArgs || [])], {
    cwd: ws.dir, env: { ...process.env, CI: '1', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });
  for (let i = 0; i < 100; i++) {
    if (/live review at|seal serve/.test(stderr)) break;
    if (child.exitCode != null) break;
    await delay(50);
  }
  return { child, getStderr: () => stderr };
}

test('start creates the sidecar if missing, then serves', async () => {
  const ws = makeWorkspace({ git: true });
  try {
    assert.ok(!ws.exists('doc.seal.md'), 'precondition: no sidecar');
    const { child, getStderr } = await spawnStart(ws);
    try {
      assert.ok(ws.exists('doc.seal.md'), 'start initialised the sidecar');
      assert.match(getStderr(), /git repo/, 'shareability guidance printed for a git repo');
    } finally { child.kill('SIGKILL'); await delay(20); }
  } finally { ws.cleanup(); }
});

test('start in a NON-git dir warns the review is local-only', async () => {
  const ws = makeWorkspace({ git: false });
  try {
    const { child, getStderr } = await spawnStart(ws);
    try {
      assert.match(getStderr(), /LOCAL ONLY|Not a git repo/i, 'local-only warning surfaced on stderr');
    } finally { child.kill('SIGKILL'); await delay(20); }
  } finally { ws.cleanup(); }
});

test('start surfaces the owner on stderr when one is known', async () => {
  const ws = makeWorkspace({ git: true, content: '# T\n\nAuthor: Dana Reed\n\nbody body body.\n' });
  try {
    const { child, getStderr } = await spawnStart(ws);
    try {
      assert.match(getStderr(), /Owner: Dana Reed/, 'owner echoed to stderr');
    } finally { child.kill('SIGKILL'); await delay(20); }
  } finally { ws.cleanup(); }
});

// ===========================================================================
// serve (cmdServe) — live HTTP server + /api/* routes
// ===========================================================================

test('serve: GET / returns the live review HTML; /api/state reports status', async () => {
  const ws = initWorkspace();
  try {
    await withServe(ws, [], async ({ base }) => {
      const page = await fetch(base + '/').then((r) => r.text());
      assert.match(page, /<html|<!doctype html/i, 'served an HTML page');
      const state = await fetch(base + '/api/state').then((r) => r.json());
      assert.equal(state.ok, true);
      assert.equal(state.comments, 0);
      assert.equal(typeof state.status, 'string');
    });
  } finally { ws.cleanup(); }
});

test('serve: POST /api/comment writes the sidecar via the core and emits a SEAL_EVENT', async () => {
  const ws = initWorkspace();
  try {
    await withServe(ws, [], async ({ base, getStdout }) => {
      const { status, json } = await jpost(base, '/api/comment', { author: 'Reviewer', body: 'a live comment' });
      assert.equal(status, 200);
      assert.equal(json.ok, true);
      assert.ok(json.id, 'returns the new comment id');

      const state = await fetch(base + '/api/state').then((r) => r.json());
      assert.equal(state.comments, 1, 'state reflects the new comment');

      const cm = readRecords(ws.read('doc.seal.md'), 'comment').at(-1);
      assert.equal(cm.author, 'Reviewer');
      assert.equal(cm.body, 'a live comment');

      await delay(50);
      assert.match(getStdout(), /SEAL_EVENT .*"type":"comment"/, 'comment event streamed to stdout');
    });
  } finally { ws.cleanup(); }
});

test('serve: /api/comment with @mention persists resolved mentions (core integration)', async () => {
  const ws = makeWorkspace({ git: true, content: MENTION_DOC });
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    await withServe(ws, [], async ({ base }) => {
      const { json } = await jpost(base, '/api/comment', { author: 'Me', body: 'ping @bob', mention: ['alice'] });
      assert.equal(json.ok, true);
      const handles = (json.mentions || []).map((m) => m.handle).sort();
      assert.deepEqual(handles, ['alice-carter', 'bob-lin']);
    });
  } finally { ws.cleanup(); }
});

test('serve: reply / resolve / reopen routes mutate the comment status', async () => {
  const ws = initWorkspace();
  try {
    await withServe(ws, [], async ({ base }) => {
      const { json: c } = await jpost(base, '/api/comment', { body: 'top' });
      const id = c.id;

      const rep = await jpost(base, '/api/reply', { id, author: 'A', body: 'a reply' });
      assert.equal(rep.json.ok, true);

      const res = await jpost(base, '/api/resolve', { id });
      assert.equal(res.json.ok, true);
      let cm = readRecords(ws.read('doc.seal.md'), 'comment').find((x) => x.id === id);
      assert.equal(cm.status, 'resolved');
      assert.equal(cm.thread.length, 1, 'reply landed in the thread');

      const reo = await jpost(base, '/api/reopen', { id });
      assert.equal(reo.json.ok, true);
      cm = readRecords(ws.read('doc.seal.md'), 'comment').find((x) => x.id === id);
      assert.equal(cm.status, 'open');
    });
  } finally { ws.cleanup(); }
});

test('serve: /api/dismiss resolves a comment (alias of resolve)', async () => {
  const ws = initWorkspace();
  try {
    await withServe(ws, [], async ({ base }) => {
      const { json: c } = await jpost(base, '/api/comment', { body: 'to dismiss' });
      const d = await jpost(base, '/api/dismiss', { id: c.id });
      assert.equal(d.json.ok, true);
      const cm = readRecords(ws.read('doc.seal.md'), 'comment').find((x) => x.id === c.id);
      assert.equal(cm.status, 'resolved');
    });
  } finally { ws.cleanup(); }
});

test('serve: /api/accept applies a suggestion to the doc and changes its content hash', async () => {
  const ws = initWorkspace();
  try {
    await withServe(ws, [], async ({ base }) => {
      const before = ws.read('doc.md');
      // anchor on an exact span present in SAMPLE_DOC
      const anchor = 'fully local review tool';
      const { json: c } = await jpost(base, '/api/comment', { body: 'tighten', anchor, suggestion: 'local-first review tool' });
      assert.ok(c.id, 'suggestion created');
      const acc = await jpost(base, '/api/accept', { id: c.id });
      assert.equal(acc.json.ok, true);
      assert.ok(acc.json.content_hash, 'returns new content hash');
      const after = ws.read('doc.md');
      assert.notEqual(after, before, 'doc.md was edited');
      assert.match(after, /local-first review tool/, 'suggestion applied');
    });
  } finally { ws.cleanup(); }
});

test('serve: /api/doc overwrites the document (coreSaveDoc); empty markdown is refused', async () => {
  const ws = initWorkspace();
  try {
    await withServe(ws, [], async ({ base }) => {
      const ok = await jpost(base, '/api/doc', { markdown: '# Rewritten\n\nfresh body content here.\n' });
      assert.equal(ok.status, 200);
      assert.equal(ok.json.ok, true);
      assert.ok(ok.json.content_hash);
      assert.match(ws.read('doc.md'), /# Rewritten/, 'doc was overwritten');

      const bad = await jpost(base, '/api/doc', { markdown: '   ' });
      assert.equal(bad.status, 400, 'empty markdown rejected');
      assert.equal(bad.json.ok, false);
      assert.match(String(bad.json.error), /empty markdown/i);
    });
  } finally { ws.cleanup(); }
});

test('serve: /api/summary returns a ready role, else queues a request + 202-style generating', async () => {
  const ws = initWorkspace();
  try {
    // pre-seed one ready role
    runSeal(['summary', '--in', ws.doc, '--role', 'Eng Lead', '--json', JSON.stringify({ lead: 'ready' })], { cwd: ws.dir });
    await withServe(ws, [], async ({ base }) => {
      const ready = await fetch(base + '/api/summary?role=Eng%20Lead').then((r) => r.json());
      assert.equal(ready.status, 'ready');
      assert.equal(ready.role, 'Eng Lead');

      // a brand-new role: POST queues it and reports generating
      const gen = await jpost(base, '/api/summary', { role: 'Data Science' });
      assert.equal(gen.json.status, 'generating');
      // the durable request queue was written for `seal pending` to drain
      assert.ok(ws.exists('doc.seal.requests.jsonl'), 'request persisted to jsonl');
      assert.match(ws.read('doc.seal.requests.jsonl'), /Data Science/);
    });
  } finally { ws.cleanup(); }
});

test('serve: /api/commit commits the review files (coreCommit) in a git repo', async () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    await withServe(ws, [], async ({ base }) => {
      const r = await jpost(base, '/api/commit', { message: 'review snapshot', push: false });
      assert.equal(r.status, 200);
      assert.equal(r.json.ok, true);
      assert.equal(r.json.committed, true, 'a commit was created');
      assert.deepEqual(
        r.json.files.map((f) => f.replace(/^.*\//, '')).sort(),
        ['doc.md', 'doc.seal.md'].sort(),
        'committed the doc + sidecar',
      );
    });
  } finally { ws.cleanup(); }
});

test('serve: /api/autocommit toggles the auto-commit flag reported by /api/state', async () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    await withServe(ws, [], async ({ base }) => {
      let st = await fetch(base + '/api/state').then((r) => r.json());
      assert.equal(st.auto_commit, false);
      const t = await jpost(base, '/api/autocommit', { on: true });
      assert.equal(t.json.auto_commit, true);
      st = await fetch(base + '/api/state').then((r) => r.json());
      assert.equal(st.auto_commit, true, 'toggle persisted in the running server');
    });
  } finally { ws.cleanup(); }
});

test('serve: /api/share writes a portable static HTML file and reports a file:// url', async () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    await withServe(ws, [], async ({ base }) => {
      const r = await jpost(base, '/api/share', { channels: [] });
      assert.equal(r.json.ok, true);
      assert.ok(ws.exists('doc.review.html'), 'static review file written');
      assert.match(String(r.json.fileUrl), /^file:\/\//, 'file:// url reported');
      assert.equal(r.json.dispatched, false, 'no channels -> nothing dispatched');
      const html = ws.read('doc.review.html');
      assert.match(html, /<html|<!doctype/i);
    });
  } finally { ws.cleanup(); }
});

test('serve: /api/share with channels emits a share_request event for the AI console', async () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    await withServe(ws, [], async ({ base, getStdout }) => {
      const r = await jpost(base, '/api/share', { channels: ['slack'], to: ['#team'] });
      assert.equal(r.json.dispatched, true);
      await delay(50);
      assert.match(getStdout(), /SEAL_EVENT .*"type":"share_request"/, 'share_request event emitted');
    });
  } finally { ws.cleanup(); }
});

test('serve: /api/closing reports commit status; local-only when there is no remote', async () => {
  const ws = makeWorkspace({ git: true });
  try {
    runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
    await withServe(ws, [], async ({ base }) => {
      const r = await jpost(base, '/api/closing', {});
      assert.equal(r.json.ok, true);
      assert.equal(r.json.has_remote, false, 'no origin remote configured in this throwaway repo');
      assert.equal(typeof r.json.uncommitted, 'boolean');
    });
  } finally { ws.cleanup(); }
});

test('serve: unknown POST route 404s; bad core input (reply missing id) returns 400 + error', async () => {
  const ws = initWorkspace();
  try {
    await withServe(ws, [], async ({ base }) => {
      const nf = await jpost(base, '/api/nope', {});
      assert.equal(nf.status, 404);
      assert.equal(nf.json.ok, false);

      const bad = await jpost(base, '/api/reply', { body: 'no id here' });
      assert.equal(bad.status, 400, 'core threw -> 400');
      assert.equal(bad.json.ok, false);
      assert.match(String(bad.json.error), /id is required/i);
    });
  } finally { ws.cleanup(); }
});

test('serve: with --notify-cmd, a comment runs the external command with SEAL_EVENT in env', async () => {
  const ws = initWorkspace();
  try {
    const marker = ws.dir + '/fired.txt';
    // a tiny shell cmd that APPENDS each event it receives (one per line). Every
    // emitEvent — including serve_started — runs the cmd, and the spawns race, so
    // we append + search rather than expecting a single overwrite.
    const cmd = `printf '%s\\n' "$SEAL_EVENT" >> ${JSON.stringify(marker).slice(1, -1)}`;
    await withServe(ws, ['--notify-cmd', cmd], async ({ base }) => {
      await jpost(base, '/api/comment', { body: 'trigger the hook' });
      // poll for the comment event to land among the fired events
      let body = '';
      for (let i = 0; i < 60; i++) {
        body = ws.exists('fired.txt') ? ws.read('fired.txt') : '';
        if (/"type":"comment"/.test(body)) break;
        await delay(50);
      }
      assert.ok(body, 'notify-cmd produced its side-effect file');
      assert.match(body, /"type":"comment"/, 'SEAL_EVENT for the comment passed to the external command');
    });
  } finally { ws.cleanup(); }
});
