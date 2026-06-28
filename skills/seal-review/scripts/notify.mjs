// ============================================================================
// sealmd — notifications. Tag people (@mention) and tell them + the doc
// owner about activity via Slack / Teams / email. Zero dependencies (global
// fetch, Node >=18). Every channel is OPT-IN via flag or env — nothing leaves
// the machine unless you configure a webhook/key.
//
// Directory: <doc>.seal.people.json maps names -> contact handles, e.g.
//   { "alice": { "handle": "alice-gh", "email": "alice@co.com", "slack": "@alice" },
//     "_owner": "alice" }
// The document's `owner` (set at init) names who gets owner notifications.
// ============================================================================

// Scrape people (name + email) from the document itself: author/email lines and
// person-columns of tables (Owner/Reviewer/Approver/Author/Lead/Name/DRI). Keyed
// by first name (lowercase) for @mention matching. Best-effort, never throws.
export function extractPeople(md) {
  const people = {};
  const slug = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const add = (name, email) => {
    name = String(name || '').replace(/\*\*|`/g, '').trim();
    if (!/^[A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){0,2}$/.test(name)) {
      if (email) name = email.split('@')[0]; else return;
    }
    const key = String(name).split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key) return;
    if (!people[key]) people[key] = { name, handle: slug(name) };
    else if (name.length > people[key].name.length) { people[key].name = name; people[key].handle = slug(name); }
    if (email && !people[key].email) people[key].email = email;
  };
  const lines = String(md || '').split('\n');
  // 1. lines containing an email — pull the nearest capitalised name on the line
  for (const line of lines) {
    const em = line.match(/[\w.+-]+@[\w-]+\.[\w.]+\w/);
    if (!em) continue;
    const nm = line.match(/([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){1,2})/);
    add(nm ? nm[1] : em[0], em[0]);
  }
  // 2. person-columns in markdown tables
  const personCol = /^\**\s*(owner|reviewer|approver|author|lead|assignee|name|dri)\s*\**$/i;
  let header = null, idx = -1;
  const cellsOf = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  for (const line of lines) {
    if (!line.includes('|')) { header = null; idx = -1; continue; }
    if (/^[\s|:.-]+$/.test(line)) continue;            // separator row
    const cells = cellsOf(line);
    if (!header) { header = cells; idx = cells.findIndex((c) => personCol.test(c)); continue; }
    if (idx >= 0 && cells[idx]) add(cells[idx]);
  }
  return people;
}

export function parseMentions(text) {
  const out = [];
  const re = /(^|[^\w@])@([a-z0-9][a-z0-9._-]{1,38})/gi;
  let m; while ((m = re.exec(String(text || '')))) out.push(m[2]);
  return [...new Set(out)];
}

export function resolvePerson(people, name) {
  if (!name) return { name, handle: name };
  const key = Object.keys(people || {}).find((k) => k.toLowerCase() === String(name).toLowerCase());
  const rec = key ? people[key] : null;
  if (!rec) return { name, handle: name };
  return { name: key, handle: rec.handle || key, email: rec.email || null, slack: rec.slack || null };
}

// Resolve @tokens in a comment body (+ explicit --mention list) to people.
export function resolveMentions(people, body, explicit = []) {
  const names = [...parseMentions(body), ...explicit];
  const seen = new Set(); const res = [];
  for (const n of names) {
    const p = resolvePerson(people, n);
    const k = p.name.toLowerCase();
    if (seen.has(k)) continue; seen.add(k); res.push(p);
  }
  return res;
}

// ---- config (flags > env) --------------------------------------------------
export function notifyConfig(arg, env = process.env) {
  return {
    slack: arg('slack-webhook') || env.SEAL_SLACK_WEBHOOK || null,
    teams: arg('teams-webhook') || env.SEAL_TEAMS_WEBHOOK || null,
    email: {
      to: arg('email-to') || env.SEAL_EMAIL_TO || null,
      from: arg('email-from') || env.SEAL_EMAIL_FROM || 'seal-review@localhost',
      resendKey: env.SEAL_RESEND_KEY || null,
    },
    digestInterval: parseInt(arg('digest-interval') || env.SEAL_DIGEST_INTERVAL || '0', 10) || 0,
  };
}
export function notifyEnabled(cfg) {
  return !!(cfg && (cfg.slack || cfg.teams || (cfg.email && cfg.email.to && cfg.email.resendKey)));
}

// ---- channel senders (best-effort; never throw into the caller) ------------
async function post(url, body, headers = {}) {
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { ok: res.ok, status: res.status };
  } catch (e) { return { ok: false, error: String(e.message || e) }; }
}
// Neutralize Slack/Teams control syntax (`<!channel>`, `<@id>`, `<url|text>`) so a
// reviewer's comment body can't @-ping a channel or impersonate. Channel-layer
// (not formatEvent) so email keeps its own HTML escaping and Slack sees no &lt;.
const noCtl = (s) => String(s || '').replace(/</g, '‹').replace(/>/g, '›');
export async function sendSlack(webhook, text) { return post(webhook, { text: noCtl(text) }); }
export async function sendTeams(webhook, text) {
  return post(webhook, { '@type': 'MessageCard', '@context': 'http://schema.org/extensions', text: noCtl(text) });
}
// Escape for HTML text content (& first, so we don't double-escape the others).
const escapeHtmlText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export async function sendEmail(email, subject, text) {
  if (!email.to || !email.resendKey) return { ok: false, error: 'email not configured' };
  return post('https://api.resend.com/emails',
    { from: email.from, to: [email.to], subject, html: `<pre style="font:14px ui-sans-serif">${escapeHtmlText(text)}</pre>` },
    { authorization: `Bearer ${email.resendKey}` });
}

// Like sendEmail but takes explicit recipients and optional file attachments
// ([{ filename, content }] where content is base64). Used by the live "Send via
// Email" share action to deliver the review + bundle in one real email.
export async function sendEmailRich(email, { to, subject, text, attachments = [] } = {}) {
  const recipients = (Array.isArray(to) ? to : (to ? [to] : [])).filter(Boolean);
  if (!recipients.length) return { ok: false, error: 'no recipients' };
  if (!email || !email.resendKey) return { ok: false, error: 'email not configured' };
  const payload = {
    from: email.from, to: recipients, subject: subject || 'Seal review',
    text: text || '', html: `<pre style="font:14px ui-sans-serif">${escapeHtmlText(text || '')}</pre>`,
  };
  if (attachments.length) payload.attachments = attachments.map((a) => ({ filename: a.filename, content: a.content }));
  return post('https://api.resend.com/emails', payload, { authorization: `Bearer ${email.resendKey}` });
}

// ---- message formatting ----------------------------------------------------
export function formatEvent(ev, link) {
  const who = ev.author || 'someone';
  const cc = ev.mentions && ev.mentions.length ? `  ·  cc ${ev.mentions.map((m) => '@' + m.handle).join(' ')}` : '';
  const where = ev.anchor ? ` on “${String(ev.anchor).slice(0, 60)}”` : '';
  let head;
  if (ev.type === 'suggestion') head = `✎ *${who}* suggested an edit${where}`;
  else if (ev.type === 'comment') head = `💬 *${who}* commented${where}`;
  else if (ev.type === 'reply') head = `↩︎ *${who}* replied`;
  else head = `• ${ev.type}`;
  const body = ev.body || ev.note || '';
  return `${head} on *${ev.docTitle || ev.doc}*${cc}\n${body ? '“' + body + '”\n' : ''}${link ? link : ''}`.trim();
}

// ---- dispatch one event to all configured channels + targeted people -------
// targets: mentioned people (their slack/email if set) + the owner. Channel
// webhooks (Slack/Teams) post once per event; per-person email goes to each
// mentioned person with an email AND to the owner's email when set.
export async function dispatch(cfg, ev, { link, ownerPerson } = {}) {
  if (!notifyEnabled(cfg)) return { sent: [], skipped: 'not configured' };
  const text = formatEvent(ev, link);
  const sent = [];
  const jobs = [];
  if (cfg.slack) jobs.push(sendSlack(cfg.slack, text).then((r) => sent.push({ ch: 'slack', ...r })));
  if (cfg.teams) jobs.push(sendTeams(cfg.teams, text).then((r) => sent.push({ ch: 'teams', ...r })));
  // email: to the configured catch-all --email-to, plus mentioned/owner emails
  const emails = new Set();
  if (cfg.email && cfg.email.to) emails.add(cfg.email.to);
  for (const m of ev.mentions || []) if (m.email) emails.add(m.email);
  if (ownerPerson && ownerPerson.email) emails.add(ownerPerson.email);
  if (cfg.email && cfg.email.resendKey) {
    for (const to of emails) jobs.push(sendEmail({ ...cfg.email, to }, `Seal review: ${ev.type} on ${ev.docTitle || ev.doc}`, text).then((r) => sent.push({ ch: 'email', to, ...r })));
  }
  await Promise.all(jobs);
  return { sent };
}

// ---- owner digest: batch events, flush on an interval ----------------------
export function makeDigest(cfg, flush) {
  const q = [];
  let timer = null;
  return {
    add(ev) {
      q.push(ev);
      if (!cfg.digestInterval) { flush(q.splice(0)); return; }      // 0 = immediate
      if (!timer) timer = setTimeout(() => { timer = null; flush(q.splice(0)); }, cfg.digestInterval * 1000);
    },
    stop() { if (timer) clearTimeout(timer); if (q.length) flush(q.splice(0)); },
  };
}
