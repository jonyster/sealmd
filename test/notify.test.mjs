// Tests for skills/seal-review/scripts/notify.mjs
// node:test + node:assert/strict only. No third-party deps, no real network.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const NOTIFY = join(HERE, '..', 'skills', 'seal-review', 'scripts', 'notify.mjs');

const {
  extractPeople, parseMentions, resolvePerson, resolveMentions,
  notifyConfig, notifyEnabled, formatEvent, makeDigest,
  sendSlack, sendTeams, sendEmail, sendEmailRich, dispatch,
} = await import(NOTIFY);

// arg() factory mirroring how seal.mjs feeds notifyConfig: a flag lookup.
const argFrom = (flags = {}) => (name) => (name in flags ? flags[name] : null);

// ---------------------------------------------------------------------------
// extractPeople
// ---------------------------------------------------------------------------
test('extractPeople: pulls name + email from an email line', () => {
  // Use a line whose only capitalised run is the actual name (the line-scan
  // grabs the FIRST capitalised 2-3 word run, so leading capitalised prose like
  // "Contact" would otherwise be picked up).
  const p = extractPeople('Alice Smith — alice@co.com');
  assert.ok(p.alice, 'alice keyed by first name');
  assert.equal(p.alice.name, 'Alice Smith');
  assert.equal(p.alice.email, 'alice@co.com');
  assert.equal(p.alice.handle, 'alice-smith');
});

test('extractPeople: email with no capitalised name keys off email localpart', () => {
  const p = extractPeople('reach us: bob@co.com');
  // name falls back to email localpart "bob"
  assert.ok(p.bob);
  assert.equal(p.bob.email, 'bob@co.com');
});

test('extractPeople: person-columns of a markdown table (Owner/Reviewer/...)', () => {
  const md = [
    '| Role | Owner |',
    '| --- | --- |',
    '| Backend | Carol Jones |',
    '| Frontend | Dan |',
  ].join('\n');
  const p = extractPeople(md);
  assert.ok(p.carol, 'Carol from Owner column');
  assert.equal(p.carol.name, 'Carol Jones');
  assert.ok(p.dan, 'Dan from Owner column');
});

test('extractPeople: recognises each person-column header keyword', () => {
  for (const col of ['Owner', 'Reviewer', 'Approver', 'Author', 'Lead', 'DRI']) {
    const md = `| ${col} | x |\n| --- | --- |\n| Eve Adams | y |`;
    const p = extractPeople(md);
    assert.ok(p.eve, `header "${col}" should be a person column`);
  }
});

test('extractPeople: bold/backtick markers stripped from names', () => {
  const md = '| Owner |\n| --- |\n| **Frank Miller** |';
  const p = extractPeople(md);
  assert.ok(p.frank);
  assert.equal(p.frank.name, 'Frank Miller');
});

test('extractPeople: prefers the longer name on collision', () => {
  const md = 'Gina at gina@co.com\n\n| Owner |\n| --- |\n| Gina Hill |';
  const p = extractPeople(md);
  assert.equal(p.gina.name, 'Gina Hill', 'longer name wins');
  assert.equal(p.gina.email, 'gina@co.com', 'email preserved across merge');
});

test('extractPeople: keeps first email when two appear for same key', () => {
  const md = 'Hank Lee hank@first.com\nHank Lee hank@second.com';
  const p = extractPeople(md);
  assert.equal(p.hank.email, 'hank@first.com');
});

test('extractPeople: never throws on junk / empty / non-string input', () => {
  assert.doesNotThrow(() => extractPeople(''));
  assert.doesNotThrow(() => extractPeople(null));
  assert.doesNotThrow(() => extractPeople(undefined));
  assert.doesNotThrow(() => extractPeople('||||\n@@@\n| | |'));
  assert.doesNotThrow(() => extractPeople('!!! random $$$ no people here 123'));
  assert.deepEqual(extractPeople(''), {});
});

test('extractPeople: lowercase prose word is not mistaken for a name', () => {
  const p = extractPeople('please email the team at team@co.com');
  // "please"/"the"/"team" are not capitalised proper names -> localpart used
  assert.ok(p.team, 'falls back to email localpart');
  assert.equal(Object.keys(p).length, 1);
});

test('extractPeople: handles CRLF line endings', () => {
  const md = 'Ivan Petrov ivan@co.com\r\n| Owner |\r\n| --- |\r\n| Jane Doe |\r\n';
  const p = extractPeople(md);
  assert.ok(p.ivan);
  assert.ok(p.jane);
});

// ---------------------------------------------------------------------------
// parseMentions
// ---------------------------------------------------------------------------
test('parseMentions: extracts @handles', () => {
  assert.deepEqual(parseMentions('hey @alice and @bob-gh look'), ['alice', 'bob-gh']);
});

test('parseMentions: dedups repeated handles', () => {
  assert.deepEqual(parseMentions('@alice @alice @alice'), ['alice']);
});

test('parseMentions: an email is not parsed as a mention', () => {
  // the "@" in alice@co.com is preceded by a word char, so the regex excludes it
  assert.deepEqual(parseMentions('mail alice@co.com'), []);
});

test('parseMentions: handle at start of string', () => {
  assert.deepEqual(parseMentions('@carol hi'), ['carol']);
});

test('parseMentions: requires 2+ char handles (min length)', () => {
  // pattern is [a-z0-9] + {1,38} more -> needs at least 2 chars total
  assert.deepEqual(parseMentions('@a alone but @ab ok'), ['ab']);
});

test('parseMentions: empty / non-string never throws', () => {
  assert.deepEqual(parseMentions(''), []);
  assert.deepEqual(parseMentions(null), []);
  assert.deepEqual(parseMentions(undefined), []);
});

test('parseMentions: case-insensitive match but preserves captured text', () => {
  // regex has /i; capture group keeps the original casing of the handle
  assert.deepEqual(parseMentions('@Alice'), ['Alice']);
});

// ---------------------------------------------------------------------------
// resolvePerson
// ---------------------------------------------------------------------------
test('resolvePerson: resolves a known person case-insensitively', () => {
  const people = { alice: { handle: 'alice-smith', email: 'a@co.com', slack: '@al' } };
  const r = resolvePerson(people, 'Alice');
  assert.equal(r.name, 'alice');
  assert.equal(r.handle, 'alice-smith');
  assert.equal(r.email, 'a@co.com');
  assert.equal(r.slack, '@al');
});

test('resolvePerson: unknown name echoes back with name as handle', () => {
  const r = resolvePerson({}, 'nobody');
  assert.deepEqual(r, { name: 'nobody', handle: 'nobody' });
});

test('resolvePerson: empty name returns name/handle echo', () => {
  assert.deepEqual(resolvePerson({}, ''), { name: '', handle: '' });
  assert.deepEqual(resolvePerson(null, ''), { name: '', handle: '' });
});

test('resolvePerson: missing handle/email/slack default sensibly', () => {
  const r = resolvePerson({ bob: {} }, 'bob');
  assert.equal(r.name, 'bob');
  assert.equal(r.handle, 'bob'); // falls back to key
  assert.equal(r.email, null);
  assert.equal(r.slack, null);
});

// ---------------------------------------------------------------------------
// resolveMentions
// ---------------------------------------------------------------------------
test('resolveMentions: union of body @tokens + explicit list, deduped', () => {
  const people = {
    alice: { handle: 'alice-h', email: 'a@co.com' },
    bob: { handle: 'bob-h' },
  };
  const res = resolveMentions(people, 'ping @alice please', ['bob', 'alice']);
  const names = res.map((r) => r.name);
  assert.deepEqual(names, ['alice', 'bob'], 'alice deduped across body+explicit');
});

test('resolveMentions: dedup is case-insensitive across sources', () => {
  const people = { alice: { handle: 'h' } };
  const res = resolveMentions(people, '@Alice', ['alice']);
  assert.equal(res.length, 1);
});

test('resolveMentions: unknown mentions still resolved (echo), no throw', () => {
  const res = resolveMentions({}, '@ghost', ['phantom']);
  assert.deepEqual(res.map((r) => r.name), ['ghost', 'phantom']);
});

test('resolveMentions: empty body + empty explicit -> []', () => {
  assert.deepEqual(resolveMentions({}, '', []), []);
  assert.deepEqual(resolveMentions({}, ''), []);
});

// ---------------------------------------------------------------------------
// notifyConfig
// ---------------------------------------------------------------------------
test('notifyConfig: flags take precedence over env', () => {
  const arg = argFrom({ 'slack-webhook': 'https://flag.slack', 'email-to': 'flag@co.com' });
  const env = { SEAL_SLACK_WEBHOOK: 'https://env.slack', SEAL_EMAIL_TO: 'env@co.com' };
  const cfg = notifyConfig(arg, env);
  assert.equal(cfg.slack, 'https://flag.slack');
  assert.equal(cfg.email.to, 'flag@co.com');
});

test('notifyConfig: falls back to env when no flag', () => {
  const cfg = notifyConfig(argFrom({}), {
    SEAL_TEAMS_WEBHOOK: 'https://env.teams',
    SEAL_RESEND_KEY: 'rk_123',
    SEAL_EMAIL_FROM: 'me@co.com',
  });
  assert.equal(cfg.teams, 'https://env.teams');
  assert.equal(cfg.email.resendKey, 'rk_123');
  assert.equal(cfg.email.from, 'me@co.com');
});

test('notifyConfig: defaults', () => {
  const cfg = notifyConfig(argFrom({}), {});
  assert.equal(cfg.slack, null);
  assert.equal(cfg.teams, null);
  assert.equal(cfg.email.to, null);
  assert.equal(cfg.email.from, 'seal-review@localhost');
  assert.equal(cfg.email.resendKey, null);
  assert.equal(cfg.digestInterval, 0);
});

test('notifyConfig: digestInterval parses int; garbage -> 0', () => {
  assert.equal(notifyConfig(argFrom({ 'digest-interval': '30' }), {}).digestInterval, 30);
  assert.equal(notifyConfig(argFrom({ 'digest-interval': 'abc' }), {}).digestInterval, 0);
  assert.equal(notifyConfig(argFrom({}), { SEAL_DIGEST_INTERVAL: '15' }).digestInterval, 15);
});

// ---------------------------------------------------------------------------
// notifyEnabled
// ---------------------------------------------------------------------------
test('notifyEnabled: true with slack only', () => {
  assert.equal(notifyEnabled({ slack: 'x' }), true);
});
test('notifyEnabled: true with teams only', () => {
  assert.equal(notifyEnabled({ teams: 'x' }), true);
});
test('notifyEnabled: email needs BOTH to AND resendKey', () => {
  assert.equal(notifyEnabled({ email: { to: 'a@co.com' } }), false);
  assert.equal(notifyEnabled({ email: { resendKey: 'k' } }), false);
  assert.equal(notifyEnabled({ email: { to: 'a@co.com', resendKey: 'k' } }), true);
});
test('notifyEnabled: false for empty/null cfg', () => {
  assert.equal(notifyEnabled(null), false);
  assert.equal(notifyEnabled(undefined), false);
  assert.equal(notifyEnabled({}), false);
  assert.equal(notifyEnabled({ slack: null, teams: null, email: { to: null, resendKey: null } }), false);
});

// ---------------------------------------------------------------------------
// formatEvent
// ---------------------------------------------------------------------------
test('formatEvent: comment uses 💬 and includes docTitle', () => {
  const out = formatEvent({ type: 'comment', author: 'Alice', docTitle: 'My PRD', body: 'looks good' });
  assert.match(out, /💬/);
  assert.match(out, /\*Alice\* commented/);
  assert.match(out, /\*My PRD\*/);
  assert.match(out, /“looks good”/);
});

test('formatEvent: suggestion uses ✎ and shows anchor', () => {
  const out = formatEvent({ type: 'suggestion', author: 'Bob', doc: 'd.md', anchor: 'the goals section' });
  assert.match(out, /✎/);
  assert.match(out, /suggested an edit on “the goals section”/);
});

test('formatEvent: reply uses ↩︎', () => {
  const out = formatEvent({ type: 'reply', author: 'Eve', doc: 'd.md' });
  assert.match(out, /↩︎/);
  assert.match(out, /replied/);
});

test('formatEvent: unknown type falls through to bullet', () => {
  const out = formatEvent({ type: 'weird', doc: 'd.md' });
  assert.match(out, /• weird/);
});

test('formatEvent: no author/approver -> "someone"', () => {
  const out = formatEvent({ type: 'comment', doc: 'd.md' });
  assert.match(out, /\*someone\* commented/);
});

test('formatEvent: mentions are cc-ed by handle', () => {
  const out = formatEvent({
    type: 'comment', author: 'A', doc: 'd.md',
    mentions: [{ handle: 'alice-h' }, { handle: 'bob-h' }],
  });
  assert.match(out, /cc @alice-h @bob-h/);
});

test('formatEvent: no mentions -> no cc segment', () => {
  const out = formatEvent({ type: 'comment', author: 'A', doc: 'd.md' });
  assert.doesNotMatch(out, /cc/);
});

test('formatEvent: anchor truncated to 60 chars', () => {
  const anchor = 'x'.repeat(100);
  const out = formatEvent({ type: 'comment', author: 'A', doc: 'd.md', anchor });
  // the on-“...” segment carries exactly 60 chars of the anchor
  const m = out.match(/“(x+)”/);
  assert.ok(m);
  assert.equal(m[1].length, 60);
});

test('formatEvent: prefers docTitle over doc', () => {
  const out = formatEvent({ type: 'comment', author: 'A', doc: 'fallback.md', docTitle: 'Pretty Title' });
  assert.match(out, /\*Pretty Title\*/);
  assert.doesNotMatch(out, /fallback\.md/);
});

test('formatEvent: falls back to doc when no docTitle', () => {
  const out = formatEvent({ type: 'comment', author: 'A', doc: 'fallback.md' });
  assert.match(out, /\*fallback\.md\*/);
});

test('formatEvent: appends link when provided, trims otherwise', () => {
  const withLink = formatEvent({ type: 'comment', author: 'A', doc: 'd.md' }, 'http://x/y');
  assert.match(withLink, /http:\/\/x\/y$/);
  const noLink = formatEvent({ type: 'comment', author: 'A', doc: 'd.md' });
  assert.equal(noLink, noLink.trim());
  assert.ok(!/\n$/.test(noLink));
});

test('formatEvent: uses ev.note when no body', () => {
  const out = formatEvent({ type: 'comment', author: 'A', doc: 'd.md', note: 'a note' });
  assert.match(out, /“a note”/);
});

// ---------------------------------------------------------------------------
// channel senders — config gating only / stubbed fetch. NO real network.
// ---------------------------------------------------------------------------
test('sendEmail: returns not-configured without to/resendKey (no fetch)', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw new Error('network should not be touched');
  });
  try {
    assert.deepEqual(await sendEmail({ to: null, resendKey: 'k' }, 's', 't'), { ok: false, error: 'email not configured' });
    assert.deepEqual(await sendEmail({ to: 'a@co.com', resendKey: null }, 's', 't'), { ok: false, error: 'email not configured' });
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test('sendSlack: posts {text} to webhook (fetch stubbed)', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  });
  try {
    const r = await sendSlack('https://hooks/x', 'hello');
    assert.deepEqual(r, { ok: true, status: 200 });
    assert.equal(calls[0].url, 'https://hooks/x');
    assert.equal(calls[0].opts.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].opts.body), { text: 'hello' });
  } finally {
    fetchMock.mock.restore();
  }
});

test('sendTeams: posts MessageCard shape (fetch stubbed)', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  });
  try {
    await sendTeams('https://teams/x', 'hi');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body['@type'], 'MessageCard');
    assert.equal(body.text, 'hi');
  } finally {
    fetchMock.mock.restore();
  }
});

// sendEmail must fully HTML-escape the body (< > &) before embedding it in the
// <pre> HTML email — fixed: escapeHtmlText escapes & first, then < and >.
test('sendEmail: HTML-escapes the body to prevent injection (fetch stubbed)', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  });
  try {
    await sendEmail({ to: 'a@co.com', from: 'f@co.com', resendKey: 'rk' }, 'subj', '<script>alert(1)</script>');
    const body = JSON.parse(calls[0].opts.body);
    assert.match(body.html, /&lt;script&gt;/);
    assert.doesNotMatch(body.html, /<script>/);
    assert.equal(calls[0].opts.headers.authorization, 'Bearer rk');
  } finally {
    fetchMock.mock.restore();
  }
});

// Full escaping contract: & escaped first (no double-encoding), then < and >.
test('sendEmail: escapes & < > completely without double-encoding', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  });
  try {
    await sendEmail({ to: 'a@co.com', from: 'f@co.com', resendKey: 'rk' }, 'subj', 'tom & jerry > "q" <b>');
    const body = JSON.parse(calls[0].opts.body);
    const inner = body.html.replace('<pre style="font:14px ui-sans-serif">', '').replace('</pre>', '');
    // no raw markup chars survive in the body content
    assert.doesNotMatch(inner, /[<>]/);
    assert.equal(inner, 'tom &amp; jerry &gt; "q" &lt;b&gt;');
    assert.equal(calls[0].opts.headers.authorization, 'Bearer rk');
  } finally {
    fetchMock.mock.restore();
  }
});

test('post() swallows fetch rejection into {ok:false,error} (via sendSlack)', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('boom'); });
  try {
    const r = await sendSlack('https://x', 't');
    assert.equal(r.ok, false);
    assert.match(r.error, /boom/);
  } finally {
    fetchMock.mock.restore();
  }
});

// ---------------------------------------------------------------------------
// sendEmailRich — explicit recipients + attachments, config-gated
// ---------------------------------------------------------------------------
test('sendEmailRich: no recipients => error, no fetch', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch'); });
  try {
    assert.deepEqual(await sendEmailRich({ resendKey: 'k', from: 'f@co.com' }, { to: [], subject: 's', text: 't' }),
      { ok: false, error: 'no recipients' });
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally { fetchMock.mock.restore(); }
});

test('sendEmailRich: recipients but no resendKey => not configured, no fetch', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('should not fetch'); });
  try {
    assert.deepEqual(await sendEmailRich({ from: 'f@co.com' }, { to: ['a@co.com'], subject: 's', text: 't' }),
      { ok: false, error: 'email not configured' });
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally { fetchMock.mock.restore(); }
});

test('sendEmailRich: posts to Resend with recipients + base64 attachment (fetch stubbed)', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200 }; });
  try {
    await sendEmailRich({ from: 'f@co.com', resendKey: 'rk' }, {
      to: ['a@co.com', 'b@co.com'], subject: 'Review: X', text: 'body <b>here</b>',
      attachments: [{ filename: 'r.zip', content: 'QkFTRTY0' }],
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.resend.com/emails');
    const body = JSON.parse(calls[0].opts.body);
    assert.deepEqual(body.to, ['a@co.com', 'b@co.com']);
    assert.equal(body.subject, 'Review: X');
    assert.match(body.html, /&lt;b&gt;/, 'html body is escaped');
    assert.equal(body.attachments[0].filename, 'r.zip');
    assert.equal(body.attachments[0].content, 'QkFTRTY0');
    assert.equal(calls[0].opts.headers.authorization, 'Bearer rk');
  } finally { fetchMock.mock.restore(); }
});

// ---------------------------------------------------------------------------
// dispatch — config-gating + stubbed fetch (no real requests)
// ---------------------------------------------------------------------------
test('dispatch: returns skipped when not configured (no fetch)', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => {
    throw new Error('network should not be touched');
  });
  try {
    const r = await dispatch({}, { type: 'comment', author: 'A', doc: 'd.md' });
    assert.deepEqual(r, { sent: [], skipped: 'not configured' });
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    fetchMock.mock.restore();
  }
});

test('dispatch: slack-configured sends one slack message (fetch stubbed)', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  });
  try {
    const r = await dispatch({ slack: 'https://s/x' }, { type: 'comment', author: 'A', doc: 'd.md' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://s/x');
    assert.deepEqual(r.sent, [{ ch: 'slack', ok: true, status: 200 }]);
  } finally {
    fetchMock.mock.restore();
  }
});

test('dispatch: email fans out to catch-all + mentioned + owner emails (deduped)', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  });
  try {
    const cfg = { email: { to: 'all@co.com', from: 'f@co.com', resendKey: 'rk' } };
    const ev = {
      type: 'comment', author: 'A', doc: 'd.md',
      mentions: [{ handle: 'm', email: 'mention@co.com' }, { handle: 'n', email: 'all@co.com' }],
    };
    const r = await dispatch(cfg, ev, { ownerPerson: { email: 'owner@co.com' } });
    const tos = r.sent.map((s) => s.to).sort();
    // all@co.com (catch-all + duplicate mention), mention@co.com, owner@co.com -> 3 unique
    assert.deepEqual(tos, ['all@co.com', 'mention@co.com', 'owner@co.com']);
    assert.equal(calls.length, 3);
  } finally {
    fetchMock.mock.restore();
  }
});

test('dispatch: email configured with to-but-no-key is NOT enabled -> skipped', async () => {
  const fetchMock = mock.method(globalThis, 'fetch', async () => { throw new Error('no net'); });
  try {
    const r = await dispatch({ email: { to: 'a@co.com', resendKey: null } }, { type: 'comment', doc: 'd.md' });
    assert.deepEqual(r, { sent: [], skipped: 'not configured' });
  } finally {
    fetchMock.mock.restore();
  }
});

// ---------------------------------------------------------------------------
// makeDigest
// ---------------------------------------------------------------------------
test('makeDigest: interval 0 flushes immediately on each add', () => {
  const flushed = [];
  const d = makeDigest({ digestInterval: 0 }, (batch) => flushed.push(batch));
  d.add({ id: 1 });
  d.add({ id: 2 });
  assert.equal(flushed.length, 2);
  assert.deepEqual(flushed[0], [{ id: 1 }]);
  assert.deepEqual(flushed[1], [{ id: 2 }]);
});

test('makeDigest: >0 batches and flushes once after the interval (mock timers)', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const flushed = [];
    const d = makeDigest({ digestInterval: 5 }, (batch) => flushed.push(batch));
    d.add({ id: 1 });
    d.add({ id: 2 });
    d.add({ id: 3 });
    assert.equal(flushed.length, 0, 'nothing flushed before interval elapses');
    mock.timers.tick(5 * 1000);
    assert.equal(flushed.length, 1, 'one flush after interval');
    assert.deepEqual(flushed[0], [{ id: 1 }, { id: 2 }, { id: 3 }]);
  } finally {
    mock.timers.reset();
  }
});

test('makeDigest: after a flush a new add starts a fresh timer', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const flushed = [];
    const d = makeDigest({ digestInterval: 5 }, (b) => flushed.push(b));
    d.add({ id: 1 });
    mock.timers.tick(5000);
    assert.equal(flushed.length, 1);
    d.add({ id: 2 });
    assert.equal(flushed.length, 1, 'fresh timer not yet fired');
    mock.timers.tick(5000);
    assert.equal(flushed.length, 2);
    assert.deepEqual(flushed[1], [{ id: 2 }]);
  } finally {
    mock.timers.reset();
  }
});

test('makeDigest: stop() flushes remaining queued events', () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const flushed = [];
    const d = makeDigest({ digestInterval: 100 }, (b) => flushed.push(b));
    d.add({ id: 1 });
    d.add({ id: 2 });
    assert.equal(flushed.length, 0);
    d.stop();
    assert.equal(flushed.length, 1, 'stop flushes the pending batch');
    assert.deepEqual(flushed[0], [{ id: 1 }, { id: 2 }]);
  } finally {
    mock.timers.reset();
  }
});

test('makeDigest: stop() with empty queue does not flush', () => {
  const flushed = [];
  const d = makeDigest({ digestInterval: 100 }, (b) => flushed.push(b));
  d.stop();
  assert.equal(flushed.length, 0);
});

// ===========================================================================
// APPENDED — reviewer-flagged gaps
// ===========================================================================

// ---------------------------------------------------------------------------
// GAP 1: channel-payload injection contract.
//
// formatEvent interpolates ev.body / ev.note / ev.anchor RAW into the message
// string (notify.mjs L118 + L127). The ONLY thing protecting Slack/Teams is
// JSON.stringify at transit (post() -> sendSlack/sendTeams), which escapes the
// string for JSON but does NOT HTML/markup-escape it. sendEmail separately
// escapes "<" for its HTML body. These pin the contract: the formatted text is
// RAW, so any future "fix" that escapes markup must live in the CHANNEL layer
// (sendEmail), never in formatEvent — otherwise Slack would show &lt; literals.
// ---------------------------------------------------------------------------
test('formatEvent: body is interpolated RAW (no HTML/markup escaping)', () => {
  const payload = '<b>bold</b> & <script>alert(1)</script> "quote" \'apos\'';
  const out = formatEvent({ type: 'comment', author: 'A', doc: 'd.md', body: payload });
  // The exact bytes survive verbatim inside the curly quotes.
  assert.ok(out.includes(`“${payload}”`), 'body passes through unescaped');
  assert.doesNotMatch(out, /&lt;|&amp;|&gt;|&quot;/, 'no entity escaping in formatEvent');
});

test('formatEvent: note is interpolated RAW when body absent', () => {
  const payload = '<i>note</i> & more';
  const out = formatEvent({ type: 'comment', author: 'A', doc: 'd.md', note: payload });
  assert.ok(out.includes(`“${payload}”`));
  assert.doesNotMatch(out, /&lt;|&amp;|&gt;/);
});

test('formatEvent: anchor is interpolated RAW (no escaping, still truncated)', () => {
  const out = formatEvent({ type: 'comment', author: 'A', doc: 'd.md', anchor: '<x> & "y"' });
  assert.ok(out.includes('“<x> & "y"”'), 'anchor markup passes through unescaped');
  assert.doesNotMatch(out, /&lt;|&amp;|&gt;|&quot;/);
});

test('sendSlack: only JSON.stringify protects transit — raw markup reaches body.text', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  });
  try {
    const text = formatEvent({ type: 'comment', author: 'A', doc: 'd.md', body: '<!channel> <script>x</script> & y' });
    await sendSlack('https://hooks/x', text);
    const parsed = JSON.parse(calls[0].opts.body);
    // Slack control syntax neutralized (no <!channel> ping / <@id> spoof), but
    // not HTML-escaped — Slack mrkdwn, so & stays literal, no &lt;.
    assert.doesNotMatch(parsed.text, /<|>/, 'angle brackets gone');
    assert.match(parsed.text, /‹!channel› ‹script›x‹\/script› & y/);
    assert.doesNotMatch(parsed.text, /&lt;|&amp;/);
  } finally {
    fetchMock.mock.restore();
  }
});

test('sendTeams: raw markup reaches MessageCard text after JSON transit', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  });
  try {
    const text = formatEvent({ type: 'comment', author: 'A', doc: 'd.md', body: '<img src=x> & z' });
    await sendTeams('https://teams/x', text);
    const parsed = JSON.parse(calls[0].opts.body);
    // angle brackets neutralized (no Slack/Teams control-syntax injection) but
    // not HTML-escaped — a card is markdown, so & stays literal.
    assert.match(parsed.text, /‹img src=x› & z/);
    assert.doesNotMatch(parsed.text, /<|>|&lt;|&amp;/);
  } finally {
    fetchMock.mock.restore();
  }
});

// ---------------------------------------------------------------------------
// GAP 2: dispatch fan-out — teams-only and slack+teams+email combined.
// ---------------------------------------------------------------------------
test('dispatch: teams-configured sends exactly one teams message (fetch stubbed)', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, status: 200 };
  });
  try {
    const r = await dispatch({ teams: 'https://t/x' }, { type: 'comment', author: 'A', doc: 'd.md' });
    assert.equal(calls.length, 1, 'one teams post, no slack/email');
    assert.equal(calls[0].url, 'https://t/x');
    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body['@type'], 'MessageCard');
    assert.deepEqual(r.sent, [{ ch: 'teams', ok: true, status: 200 }]);
  } finally {
    fetchMock.mock.restore();
  }
});

test('dispatch: slack+teams+email combined fans out to all three channels', async () => {
  const calls = [];
  const fetchMock = mock.method(globalThis, 'fetch', async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  });
  try {
    const cfg = {
      slack: 'https://s/x',
      teams: 'https://t/x',
      email: { to: 'all@co.com', from: 'f@co.com', resendKey: 'rk' },
    };
    const ev = {
      type: 'comment', author: 'A', doc: 'd.md',
      mentions: [{ handle: 'm', email: 'mention@co.com' }],
    };
    const r = await dispatch(cfg, ev, { ownerPerson: { email: 'owner@co.com' } });

    // Channels present in the result, regardless of completion order.
    const chans = r.sent.map((s) => s.ch);
    assert.equal(chans.filter((c) => c === 'slack').length, 1, 'one slack');
    assert.equal(chans.filter((c) => c === 'teams').length, 1, 'one teams');
    // email: catch-all + mention + owner = 3 unique recipients
    const emailTos = r.sent.filter((s) => s.ch === 'email').map((s) => s.to).sort();
    assert.deepEqual(emailTos, ['all@co.com', 'mention@co.com', 'owner@co.com']);

    // Total fetch calls = slack(1) + teams(1) + email(3) = 5
    assert.equal(calls.length, 5);

    // Slack hit the slack URL with {text}; teams hit teams URL with MessageCard.
    const slackCall = calls.find((c) => c.url === 'https://s/x');
    const teamsCall = calls.find((c) => c.url === 'https://t/x');
    assert.ok(slackCall && 'text' in slackCall.body);
    assert.ok(teamsCall && teamsCall.body['@type'] === 'MessageCard');
    // Email subject carries the event type + doc.
    const emailCall = calls.find((c) => c.url === 'https://api.resend.com/emails');
    assert.match(emailCall.body.subject, /Seal review: comment on d\.md/);
  } finally {
    fetchMock.mock.restore();
  }
});

// ---------------------------------------------------------------------------
// GAP 3: extractPeople table edge cases.
// ---------------------------------------------------------------------------
test('extractPeople: person-column header WITHOUT leading/trailing pipes', () => {
  // cellsOf only optionally strips edge pipes, so a borderless table still
  // splits correctly and the Owner column is recognised at idx 0.
  const md = [
    'Owner | Role',
    '--- | ---',
    'Carol Jones | Backend',
    'Dan | Frontend',
  ].join('\n');
  const p = extractPeople(md);
  assert.ok(p.carol, 'Carol picked up from borderless Owner column');
  assert.equal(p.carol.name, 'Carol Jones');
  assert.ok(p.dan, 'Dan picked up from borderless Owner column');
});

test('extractPeople: person-column in a NON-leading borderless table column', () => {
  // Owner is the SECOND borderless column (idx 1); the Role column is ignored.
  const md = [
    'Role | Owner',
    '--- | ---',
    'Backend | Grace Hopper',
  ].join('\n');
  const p = extractPeople(md);
  assert.ok(p.grace, 'name read from the borderless Owner column at idx 1');
  assert.equal(p.grace.name, 'Grace Hopper');
});

test('extractPeople: non-person header (idx === -1) is ignored, no names harvested', () => {
  // No header cell matches the person-column keywords -> idx stays -1 ->
  // capitalised cells in data rows are NOT treated as people.
  const md = [
    '| Color | Size |',
    '| --- | --- |',
    '| Zelda Quinn | Large |',
  ].join('\n');
  const p = extractPeople(md);
  assert.deepEqual(p, {}, 'no person column -> nothing extracted');
});

test('extractPeople: non-person header is ignored even borderless', () => {
  const md = [
    'Color | Size',
    '--- | ---',
    'Mauve Indigo | Large',
  ].join('\n');
  const p = extractPeople(md);
  assert.deepEqual(p, {});
});
