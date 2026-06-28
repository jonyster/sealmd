#!/usr/bin/env node
// ============================================================================
// sealmd — fully local, file-based document review engine (v1: REVIEW).
//
// TWO committed files living side by side:
//   doc.md         the canonical document the agent reads & writes
//   doc.seal.md    the sidecar: review state + comments, as structured
//                  `json seal:<kind>` blocks inside a guarded records region.
// Plus a derived, gitignored viewer:
//   doc.review.html  regenerated on every change; never committed.
//
// No server, no network. Comments bind to the sha256 content hash of the
// normalized doc, so a later edit is visible as drift (tamper-EVIDENT, not
// tamper-proof — anyone can hand-edit the plaintext sidecar; git is the real
// audit trail). Approval lives in the user's GitHub PR (`seal pr`), not in
// this engine — Seal does not track approval state locally.
//
// Zero dependencies. ESM. Importable (guarded entrypoint).
//
// Commands:
//   init     --in doc.md [--title T]              create the sidecar + gitignore the html
//   status   --in doc.md [--json]                 review state, comments, anchor health
//   comment  --in doc.md [--author A] --body B [--anchor "exact quoted span"]
//   reply    --in doc.md --id ID [--author A] --body B
//   resolve  --in doc.md --id ID                  mark a comment resolved
//   reopen   --in doc.md --id ID                  reopen a resolved comment
//   render   --in doc.md [--out f.html] [--summary s.json] [--open]
//   hash     --in doc.md                          print bare-hex content hash
//   doctor   --in doc.md [--json]                 validate the sidecar (read-only)
//
// Mutating commands auto-regenerate the HTML unless --no-render.
// Sidecar defaults to <doc-without-.md>.seal.md; override with --sidecar.
// ============================================================================

import { readFileSync, writeFileSync, existsSync, realpathSync, renameSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { dirname, basename, relative } from 'node:path';
import { normalizeMarkdown, contentHash } from './anchor.mjs';
import { renderReviewPage, deriveSummary, markdownBlocks } from './render-core.mjs';
import { resolveMentions, notifyEnabled, dispatch as notifyDispatch, makeDigest, resolvePerson,
  sendSlack, sendTeams, sendEmail, sendEmailRich, formatEvent, extractPeople } from './notify.mjs';

function buildNotifyCfg(doc) {
  const p = readNotifyPrefs(doc); const e = process.env;
  return {
    slack: arg('slack-webhook') || p.slack_webhook || e.SEAL_SLACK_WEBHOOK || null,
    teams: arg('teams-webhook') || p.teams_webhook || e.SEAL_TEAMS_WEBHOOK || null,
    email: {
      to: arg('email-to') || p.email_to || e.SEAL_EMAIL_TO || null,
      from: arg('email-from') || p.email_from || e.SEAL_EMAIL_FROM || 'seal-review@localhost',
      resendKey: e.SEAL_RESEND_KEY || null,
    },
    digestInterval: parseInt(arg('digest-interval') || p.digest_interval || '0', 10) || 0,
  };
}

// Absolute path to this engine (for the composer's copyable CLI command).
let ENGINE = 'seal.mjs';
try { ENGINE = realpathSync(process.argv[1] || ''); } catch {}

const SCHEMA_VERSION = 1;
const NORM_VERSION = 1;
const BEGIN = '<!-- seal:records:begin -->';
const END = '<!-- seal:records:end -->';

// ---- tiny utils -----------------------------------------------------------
function arg(name) { const i = process.argv.indexOf(`--${name}`); return i !== -1 ? process.argv[i + 1] : null; }
function flag(name) { return process.argv.includes(`--${name}`); }
function die(msg) { console.error('seal: ' + msg); process.exit(1); }
const isTTY = process.stdout.isTTY && !process.env.CI;
const c = (code, s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const SHORT = (h) => (h || '').slice(0, 12);
function nowISO() { return new Date().toISOString(); }
function rid(prefix) {
  // sortable-ish, collision-safe enough for local single-writer use:
  // base36 time + 4 random base36 chars.
  const t = Date.now().toString(36);
  let r = '';
  for (let i = 0; i < 4; i++) r += Math.floor(Math.random() * 36).toString(36);
  return `${prefix}_${t}_${r}`;
}
function gitUser(dir) {
  try { return execFileSync('git', ['config', 'user.name'], { cwd: dir, encoding: 'utf8' }).trim() || null; }
  catch { return null; }
}

// ---- paths ----------------------------------------------------------------
function docPath() {
  let p = arg('in');
  if (!p) {
    // positional path: an argv item ending in .md that isn't a flag value
    for (let i = 2; i < process.argv.length; i++) {
      const a = process.argv[i];
      if (/\.md$/i.test(a) && !a.startsWith('-') && !(process.argv[i - 1] || '').startsWith('--')) { p = a; break; }
    }
  }
  if (!p) die('provide the doc: --in <doc.md> (or pass the path as an argument)');
  return p;
}
// git context for owner + shareability.
function gitInfo(dir) {
  const SILENT = { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] };
  const git = (args) => { try { return execFileSync('git', args, SILENT).trim() || null; } catch { return null; } };
  const root = git(['rev-parse', '--show-toplevel']);
  return { inRepo: !!root, root, remote: git(['remote', 'get-url', 'origin']), name: git(['config', 'user.name']), email: git(['config', 'user.email']) };
}
let START_OPEN = false;
let AUTO_COMMIT = false;   // serve: commit+push after every comment/suggestion
function sidecarPath(doc) { return arg('sidecar') || doc.replace(/\.md$/i, '') + '.seal.md'; }
function htmlPath(doc) { return arg('out') || doc.replace(/\.md$/i, '') + '.review.html'; }
function readDoc(doc) { if (!existsSync(doc)) die(`doc not found: ${doc}`); return readFileSync(doc, 'utf8'); }
function liveHash(doc) { return contentHash(readDoc(doc)); }

// ---- role-tailored summaries (persisted in <doc>.seal.summary.json) --------
function summaryFilePath(doc) { return doc.replace(/\.md$/i, '') + '.seal.summary.json'; }
function baselinePath(doc) { return doc.replace(/\.md$/i, '') + '.seal.baseline.md'; }

// Split markdown into sections at ATX headings: [{ heading, body }].
function splitSections(md) {
  const out = []; let cur = { heading: '(intro)', body: [] };
  for (const l of String(md).split('\n')) {
    const m = l.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (m) { out.push(cur); cur = { heading: m[1].trim(), body: [] }; } else cur.body.push(l);
  }
  out.push(cur);
  return out.map((s) => ({ heading: s.heading, body: s.body.join('\n').trim() }));
}
// What changed in the doc since the last brief was generated (the baseline snapshot)
// — section-level: added / removed / modified, ranked high-first. The Change Brief
// shows ONLY these, so it reflects edits, not the whole digest.
function docChanges(doc) {
  const cur = readDoc(doc);
  let base;
  try { base = readFileSync(baselinePath(doc), 'utf8'); }
  catch { try { writeFileSync(baselinePath(doc), cur); } catch {} return { hasBaseline: true, items: [] }; }   // lazy bootstrap = up to date
  if (base === cur) return { hasBaseline: true, items: [] };
  const A = splitSections(base), B = splitSections(cur);
  const ah = new Map(A.map((s) => [s.heading, s.body])), bh = new Map(B.map((s) => [s.heading, s.body]));
  const items = [];
  for (const s of B) {
    if (!ah.has(s.heading)) items.push({ heading: s.heading, kind: 'added', sev: 'high' });
    else if (ah.get(s.heading) !== s.body) items.push({ heading: s.heading, kind: 'modified', sev: 'med' });
  }
  for (const s of A) if (!bh.has(s.heading)) items.push({ heading: s.heading, kind: 'removed', sev: 'high' });
  items.sort((x, y) => (x.sev === 'high' ? 0 : 1) - (y.sev === 'high' ? 0 : 1));
  return { hasBaseline: true, items };
}
function readSummaryRoles(doc) {
  const sp = arg('summary') && existsSync(arg('summary')) ? arg('summary') : summaryFilePath(doc);
  if (!existsSync(sp)) return [];
  try {
    const j = JSON.parse(readFileSync(sp, 'utf8'));
    if (Array.isArray(j.roles)) return j.roles;
    if (Array.isArray(j)) return j;
    if (j.lead || j.key_decisions) return [{ role: j.role || 'General', ...j }];
  } catch {}
  return [];
}
export function findRole(roles, name) {
  if (!name) return null;
  const n = name.trim().toLowerCase();
  return roles.find((r) => (r.role || '').toLowerCase() === n)
    || roles.find((r) => { const rl = (r.role || '').toLowerCase(); return rl && (rl.includes(n) || n.includes(rl.split(/[ (]/)[0])); })
    || null;
}
// Which reviewer ROLE owns a section heading? Scans each role's summary relevant_sections
// (entries are heading strings or { section } objects) for a label matching `heading`.
// This is how `seal pull` routes an inbound PR comment to the responsible role — the local
// echo of hosted's section→role mapping. Returns the role name or null.
export function roleForSection(roles, heading) {
  if (!heading) return null;
  const h = heading.trim().toLowerCase();
  const label = (s) => String(typeof s === 'string' ? s : (s.section || s.label || '')).trim().toLowerCase();
  // Exact heading match first — avoids "Overview" routing on "Cost Overview" / "Overview of X".
  for (const r of roles || []) for (const s of (r.relevant_sections || r.sections || [])) if (label(s) === h) return r.role || null;
  // Then containment, as a looser fallback.
  for (const r of roles || []) for (const s of (r.relevant_sections || r.sections || [])) { const l = label(s); if (l && (l.includes(h) || h.includes(l))) return r.role || null; }
  return null;
}
// A person in the people directory whose `role` (or reviewer_role) matches `role` — so we can
// mention them BY EMAIL. people.json entries are free-form, so a curated `role` field is the
// bridge the plugin otherwise lacks. Returns { name, email } or null.
export function personForRole(people, role) {
  if (!role) return null;
  const want = role.trim().toLowerCase();
  for (const [name, v] of Object.entries(people || {})) {
    if (name.startsWith('_') || !v || typeof v !== 'object') continue;
    const pr = String(v.role || v.reviewer_role || '').trim().toLowerCase();
    if (pr && (pr === want || pr.includes(want) || want.includes(pr))) return { name, email: v.email || null };
  }
  return null;
}
// ---- people directory + notification prefs --------------------------------
function peopleFilePath(doc) { return doc.replace(/\.md$/i, '') + '.seal.people.json'; }
function readPeople(doc) {
  // Base: people scraped from the doc (names + emails). Override: explicit
  // <doc>.seal.people.json (handles/slack/email the user curated).
  let docPeople = {};
  try { docPeople = extractPeople(normalizeMarkdown(readDoc(doc))); } catch {}
  let filePeople = {};
  const p = peopleFilePath(doc);
  if (existsSync(p)) { try { const j = JSON.parse(readFileSync(p, 'utf8')); if (j && typeof j === 'object') filePeople = j; } catch {} }
  const merged = { ...docPeople };
  for (const [k, v] of Object.entries(filePeople)) {
    if (k.startsWith('_')) { merged[k] = v; continue; }
    merged[k] = { ...(merged[k] || {}), ...v };  // file fields win, doc fills gaps
  }
  return merged;
}
function requestsPath(doc) { return doc.replace(/\.md$/i, '') + '.seal.requests.jsonl'; }
// The doc's author/publisher — the natural owner. From frontmatter author/owner,
// or an "Author:" / "Prepared by:" line. Falls back to null (caller uses git user).
function docAuthor(md) {
  const text = String(md || '');
  // 1. frontmatter author/owner
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  if (fm) {
    const m = fm[1].match(/^\s*(?:author|owner)\s*:\s*(.+?)\s*$/im);
    if (m) { const v = m[1].replace(/^["']|["']$/g, '').split(/[<(]/)[0].trim(); if (v) return v; }
  }
  // 2. an "Author:" / "Owner:" / "Prepared by:" line — keyword case-insensitive,
  //    but extract the NAME case-sensitively (a Capitalised name), so we don't
  //    grab a following lowercase word.
  const line = text.match(/^.*?\b(?:author|owner|prepared by|written by)\b\s*:?\s*(.+)$/im);
  if (line) {
    const rest = line[1].replace(/\*\*/g, '').trim();
    const nm = rest.match(/^([A-Z][a-zA-Z'’.-]+(?:\s+[A-Z][a-zA-Z'’.-]+){0,2})/);
    if (nm) return nm[1].trim();
  }
  return null;
}
function notifyPrefsPath(doc) { return doc.replace(/\.md$/i, '') + '.seal.notify.json'; }
function readNotifyPrefs(doc) {
  const p = notifyPrefsPath(doc);
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')) || {}; } catch { return {}; }
}

function upsertSummaryRole(doc, roleObj) {
  const sp = summaryFilePath(doc);
  let roles = readSummaryRoles(doc);
  const i = roles.findIndex((r) => (r.role || '').toLowerCase() === (roleObj.role || '').toLowerCase());
  if (i >= 0) roles[i] = roleObj; else roles.push(roleObj);
  const tmp = sp + '.tmp';
  writeFileSync(tmp, JSON.stringify({ roles }, null, 2));
  renameSync(tmp, sp);
  return sp;
}

// ---- canonical serializers (fixed key order per kind => stable diffs) ------
const KEY_ORDER = {
  document: ['kind', 'seal_schema_version', 'normalization_version', 'source', 'title', 'owner', 'notify', 'created_at'],
  state: ['kind', 'status', 'content_hash', 'updated_at'],
  comment: ['kind', 'id', 'author', 'anchor', 'suggestion', 'accepted', 'mentions', 'body', 'status', 'content_hash', 'created_at', 'thread', 'origin', 'external_ref'],
};
function canon(kind, obj) {
  const order = KEY_ORDER[kind];
  const out = {};
  for (const k of order) if (obj[k] !== undefined) out[k] = obj[k];
  return JSON.stringify(out); // compact, one line
}
function humanLine(kind, o) {
  if (kind === 'document') return `**${o.title}** · created ${o.created_at.slice(0, 10)}`;
  if (kind === 'state') return `Status: **${o.status}** · pinned \`${SHORT(o.content_hash)}\``;
  if (kind === 'comment') {
    const q = o.anchor ? ` · on "${o.anchor.quote.slice(0, 40)}${o.anchor.quote.length > 40 ? '…' : ''}"` : '';
    const kindLabel = o.suggestion != null ? 'suggestion' : 'comment';
    const cc = o.mentions && o.mentions.length ? ' · cc ' + o.mentions.map((m) => '@' + m.handle).join(' ') : '';
    return `**${o.author}** · ${kindLabel} · ${o.status}${q}${cc} — ${o.body.replace(/\n/g, ' ').slice(0, 60)}`;
  }
  return '';
}

// ---- sidecar read (FAIL-LOUD) ---------------------------------------------
// Only fences inside the BEGIN/END guard are parsed. Any unparseable record, or
// a fence-label/kind mismatch, aborts — we NEVER derive a sidecar from a partial
// parse (a later write would then permanently drop the lost records).
function parseSidecar(text, sp) {
  const a = text.indexOf(BEGIN), b = text.indexOf(END);
  if (a === -1 || b === -1 || b < a) die(`sidecar ${sp} is missing its records region (${BEGIN} … ${END}) — refusing to touch it`);
  // Guard against silent data loss: a second region, or a seal record sitting
  // OUTSIDE the guard, would be dropped on the next rewrite. Refuse instead.
  if (text.indexOf(BEGIN, a + BEGIN.length) !== -1 || text.indexOf(END, b + END.length) !== -1)
    die(`sidecar ${sp}: multiple records regions — refusing to write. Keep one ${BEGIN} … ${END} block.`);
  if (/```json seal:[a-z]+/.test(text.slice(0, a) + text.slice(b + END.length)))
    die(`sidecar ${sp}: a seal record exists OUTSIDE the ${BEGIN}/${END} guard — refusing to write (it would be dropped). Move it inside the guard or remove it.`);
  const region = text.slice(a + BEGIN.length, b);
  const re = /```json seal:([a-z]+)\n([\s\S]*?)\n```/g;
  // `approvals` is kept as an always-empty array for back-compat with callers that
  // still read r.approvals during the transition. Legacy seal:approval records are
  // parsed-and-ignored (approval now lives in the GitHub PR), never re-emitted.
  const records = { document: null, state: null, comments: [], approvals: [] };
  const seen = new Set();
  let m, idx = 0;
  while ((m = re.exec(region)) !== null) {
    const label = m[1];
    let obj;
    try { obj = JSON.parse(m[2]); }
    catch (e) { die(`sidecar ${sp}: record #${idx} (seal:${label}) is not valid JSON — ${e.message}. Refusing to write; fix or restore from git.`); }
    if (obj.kind !== label) die(`sidecar ${sp}: record #${idx} fence label "seal:${label}" != kind "${obj.kind}". Refusing to write.`);
    if (label === 'document') records.document = obj;
    else if (label === 'state') records.state = obj;
    else if (label === 'comment') {
      if (!obj.id) die(`sidecar ${sp}: comment #${idx} has no id. Refusing to write.`);
      if (seen.has(obj.id)) die(`sidecar ${sp}: duplicate comment id ${obj.id}. Refusing to write.`);
      seen.add(obj.id);
      records.comments.push(obj);
    } else if (label === 'approval') {
      // legacy approval record — parsed and ignored (approval now lives in the
      // GitHub PR). Intentionally NOT stored, so it is dropped on the next rewrite.
    } else die(`sidecar ${sp}: unknown record kind "${label}" #${idx}. Refusing to write.`);
    idx++;
  }
  if (!records.document) die(`sidecar ${sp}: no seal:document record found. Refusing to write.`);
  return records;
}
function loadSidecar(doc) {
  const sp = sidecarPath(doc);
  if (!existsSync(sp)) die(`no sidecar at ${sp} — run \`seal init --in ${doc}\` first`);
  return { sp, r: parseSidecar(readFileSync(sp, 'utf8'), sp) };
}

// ---- sidecar render + atomic write ----------------------------------------
function block(kind, obj) {
  return `${humanLine(kind, obj)}\n\n\`\`\`json seal:${kind}\n${canon(kind, obj)}\n\`\`\``;
}
function renderSidecar(r) {
  const L = [];
  L.push(`# Seal · ${r.document.source}`);
  L.push('');
  L.push('<!-- Review sidecar managed by the `seal-review` skill. Edit via the skill, not by hand.');
  L.push(`     This file + the doc beside it (${r.document.source}) are the entire review — no server.`);
  L.push('     Each record is one compact JSON block; the line above it is a human summary. -->');
  L.push('');
  L.push(BEGIN);
  L.push('');
  L.push('## Document');
  L.push('');
  L.push(block('document', r.document));
  L.push('');
  L.push('## State');
  L.push('');
  L.push(block('state', r.state));
  L.push('');
  L.push('## Comments');
  L.push('');
  if (r.comments.length === 0) L.push('_No comments yet._');
  for (const cm of r.comments) { L.push(block('comment', cm)); L.push(''); }
  L.push(END);
  L.push('');
  return L.join('\n').replace(/\n{3,}/g, '\n\n');
}
function writeSidecar(sp, r) {
  const tmp = sp + '.tmp';
  writeFileSync(tmp, renderSidecar(r), 'utf8');
  renameSync(tmp, sp);
}

// ---- anchors --------------------------------------------------------------
const CTX = 32;
function makeAnchor(normDoc, quote) {
  const q = normalizeMarkdown(quote).trim();
  if (!q) throw new Error('anchor is empty');
  const first = normDoc.indexOf(q);
  if (first === -1) throw new Error('anchor text not found verbatim in the doc — copy an exact span');
  const second = normDoc.indexOf(q, first + 1);
  let prefix = '', suffix = '';
  if (second !== -1) {
    // ambiguous: capture context to disambiguate; require uniqueness of prefix+q+suffix
    prefix = normDoc.slice(Math.max(0, first - CTX), first);
    suffix = normDoc.slice(first + q.length, first + q.length + CTX);
    const probe = prefix + q + suffix;
    if (normDoc.indexOf(probe) !== normDoc.lastIndexOf(probe)) throw new Error('anchor is ambiguous (appears multiple times) — select a longer, unique span');
    let n = 0; for (let i = normDoc.indexOf(q); i !== -1; i = normDoc.indexOf(q, i + 1)) n++;
    console.error(`⚠ anchor "${q}" appears ${n}× — pinned the FIRST match via surrounding context. Pass a longer span to target another.`);
  }
  return { quote: q, prefix, suffix };
}
// read-time resolution: exact-unique, then context-unique, else unanchored
function resolveAnchor(anchor, normDoc) {
  if (!anchor) return 'none';
  const q = anchor.quote;
  const f = normDoc.indexOf(q);
  if (f !== -1 && normDoc.indexOf(q, f + 1) === -1) return 'here';
  const probe = (anchor.prefix || '') + q + (anchor.suffix || '');
  if (probe !== q) {
    const pf = normDoc.indexOf(probe);
    if (pf !== -1 && normDoc.indexOf(probe, pf + 1) === -1) return 'here';
  }
  return 'unanchored';
}

// ---- build the review page (HTML string) ----------------------------------
function buildPage(doc, r, { mode = 'static', token = '' } = {}) {
  const md = normalizeMarkdown(readDoc(doc));
  const ch = contentHash(md);
  const wordCount = (md.match(/\S+/g) || []).length;
  // Role-tailored summaries. A --summary file may be either a single summary
  // { lead, key_decisions, needs_attention } or a role set { roles: [{role, ...}] }.
  // Persisted across renders in <doc>.seal.summary.json so the agent generates
  // them once. Falls back to a single auto-derived "General" summary.
  let roles = [];
  const sCandidates = [arg('summary'), doc.replace(/\.md$/i, '') + '.seal.summary.json'].filter(Boolean);
  for (const sp of sCandidates) {
    if (!existsSync(sp)) continue;
    try {
      const j = JSON.parse(readFileSync(sp, 'utf8'));
      if (Array.isArray(j.roles)) roles = j.roles;
      else if (Array.isArray(j)) roles = j;
      else if (j.lead || j.key_decisions) roles = [{ role: j.role || 'General', ...j }];
      if (roles.length) break;
    } catch {}
  }
  // No agent-authored summary on file → we render an auto-derived one and flag it
  // as generic so the page doesn't dress a headings-restatement as a role-tailored digest.
  const genericSummary = !roles.length;
  if (genericSummary) roles = [{ role: 'General', ...deriveSummary(md, wordCount) }];
  const comments = r.comments.map((cm) => ({ ...cm, anchor_status: resolveAnchor(cm.anchor, md) }));
  let srcUrl = null;
  try { srcUrl = pathToFileURL(realpathSync(doc)).href; } catch {}
  // Canonical reviewer-role taxonomy — identical to ai/summary.mjs REVIEWER_ROLES /
  // ROLE_META, so the role pills + datalist match sealmd.net exactly.
  const curatedRoles = [
    { value: 'legal_compliance', label: 'Legal & Compliance' },
    { value: 'engineering', label: 'Engineering' },
    { value: 'gtm', label: 'GTM' },
    { value: 'ciso', label: 'CISO' },
    { value: 'product_manager', label: 'Product Manager' },
    { value: 'ux_designer', label: 'UX Designer' },
    { value: 'content_designer', label: 'Content Designer' },
    { value: 'privacy', label: 'Privacy' },
    { value: 'data_analytics', label: 'Data & Analytics' },
    { value: 'customer_support', label: 'Customer Support' },
    { value: 'finance', label: 'Finance' },
    { value: 'general', label: 'General' },
  ];
  // people directory for the @-mention picker (name + handle + email so the
  // composer can auto-fill the notify field when you tag someone).
  const peopleDir = readPeople(doc);
  const people = Object.keys(peopleDir).filter((k) => !k.startsWith('_'))
    .map((name) => ({ name, handle: peopleDir[name].handle || name, email: peopleDir[name].email || null }));
  // Resolve the repo regardless of mode so the filename can link to GitHub even in a
  // static export (commit/PR controls stay serve-gated via the mode-restricted `git`).
  const gitAll = gitInfo(dirname(doc));
  const git = (mode === 'serve') ? gitAll : { inRepo: false, remote: null };
  // Prefer a GitHub blob link over the file:// URL — browsers block file:// nav anyway,
  // and a teammate's link is more useful. Falls back to file:// (which the serve page
  // turns into a "reveal in Finder" action) when the repo isn't on GitHub.
  const ghUrl = githubBlobUrl(gitAll, doc);
  if (ghUrl) srcUrl = ghUrl;
  return renderReviewPage({
    title: r.document.title, owner: r.document.owner || null, srcName: r.document.source, srcUrl, docPath: doc, enginePath: ENGINE,
    roles, curatedRoles, reviewerRole: (roles[0] && roles[0].role) || 'General',
    people, canCommit: git.inRepo, gitRemote: git.remote, autoCommit: AUTO_COMMIT, dirty: gitDirty(doc, git), unshared: unsharedComments(doc, git), changes: docChanges(doc),
    canPR: git.inRepo && !!git.remote && ghReady(),
    mdRaw: md, contentHash: ch, wordCount, comments, mode, token, generic: genericSummary,
    renderedAt: 'rendered ' + nowISO(),
  });
}
// true if the review's committable files have uncommitted git changes
function gitDirty(doc, git) {
  if (!git || !git.inRepo) return false;
  try {
    const files = [doc, sidecarPath(doc)]; const sj = summaryFilePath(doc); if (existsSync(sj)) files.push(sj);
    const rel = files.map((f) => { try { return relative(git.root, realpathSync(f)); } catch { return f; } });
    const st = execFileSync('git', ['status', '--porcelain', '--', ...rel], { cwd: git.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return st.trim().length > 0;
  } catch { return false; }
}
// Are there unshared COMMENTS/SUGGESTIONS specifically? The share nudge keys on
// this (not gitDirty, which also lights up for doc/summary edits). True when the
// sidecar (the file holding comments) is either uncommitted OR committed but not
// yet pushed — i.e. reviewers can't see the comments yet. Local-only (no fetch).
function unsharedComments(doc, git) {
  if (!git || !git.inRepo) return false;
  try {
    const G = (args) => execFileSync('git', args, { cwd: git.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    let rel; try { rel = relative(git.root, realpathSync(sidecarPath(doc))); } catch { rel = sidecarPath(doc); }
    if (G(['status', '--porcelain', '--', rel]).length > 0) return true;       // uncommitted comments
    const ahead = parseInt(G(['rev-list', '--count', '@{u}..HEAD']) || '0', 10) || 0;  // committed-but-unpushed
    if (ahead > 0 && G(['diff', '--name-only', '@{u}', 'HEAD', '--', rel]).length > 0) return true;
    return false;
  } catch { return false; }   // no upstream / detached / errors → treat as shared (don't nag)
}
// Fast-forward the local branch to its upstream so a doc edited on GitHub lands
// in the working tree (the serve renders the LOCAL doc). FF-ONLY: never rewrites
// or merges local work — if the branch has diverged or a local change would be
// clobbered, git refuses and we skip. Returns true if the doc actually advanced.
function ffMergeFromUpstream(doc) {
  try {
    const g = gitInfo(dirname(doc));
    if (!g.inRepo || !g.remote) return false;
    const G = (args) => execFileSync('git', args, { cwd: g.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const br = G(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!br || br === 'HEAD') return false;                 // detached → skip
    G(['fetch', 'origin', br]);
    const before = G(['rev-parse', 'HEAD']);
    G(['merge', '--ff-only', `origin/${br}`]);              // aborts (throws) if not a clean fast-forward
    return G(['rev-parse', 'HEAD']) !== before;
  } catch { return false; }
}
function regen(doc, r) {
  if (flag('no-render')) return null;
  const out = htmlPath(doc);
  writeFileSync(out, buildPage(doc, r), 'utf8');
  return out;
}
// Freshly export the review HTML, then zip it with the sidecar + source .md
// (+ summaries) into one attachable archive. Returns { zip|null, dir, files, names }.
// zip===null means the `zip` tool is absent — caller hands back the folder instead.
function makeBundle(doc) {
  const { r } = loadSidecar(doc);
  const htmlFile = htmlPath(doc);
  writeFileSync(htmlFile, buildPage(doc, r, { mode: 'static' }), 'utf8');
  const parts = [htmlFile, doc, sidecarPath(doc)];
  const sj = summaryFilePath(doc); if (existsSync(sj)) parts.push(sj);
  const files = parts.filter((f) => existsSync(f));
  const dir = dirname(realpathSync(doc));
  const base = basename(doc).replace(/\.md$/i, '');
  const zipPath = `${dir}/${base}.review-bundle.zip`;
  const names = files.map((f) => basename(f));
  try {
    try { execFileSync('rm', ['-f', zipPath]); } catch {}
    execFileSync('zip', ['-j', '-q', zipPath, ...files], { cwd: dir });
    return { zip: zipPath, dir, files, names };
  } catch {
    return { zip: null, dir, files, names };
  }
}
function maybeOpen(htmlFile) {
  if (!htmlFile || !flag('open')) return;
  if (!isTTY) { console.error(`open: ${pathToFileURL(htmlFile).href}`); return; }
  const cmd = process.platform === 'darwin' ? ['open', [htmlFile]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', htmlFile]]
    : ['xdg-open', [htmlFile]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); }
  catch { console.error(`could not open; file at ${pathToFileURL(htmlFile).href}`); }
}
// Reveal a file in the OS file manager (Finder / Explorer / default), selected
// where the platform supports it. macOS: `open -R`; Windows: `explorer /select,`;
// Linux has no portable "select", so open the containing folder.
// Build an https GitHub blob URL for the doc from the origin remote + current branch,
// so the page can link the filename to GitHub. Returns null for non-GitHub repos.
function githubBlobUrl(git, doc) {
  if (!git || !git.inRepo || !git.remote || !git.root) return null;
  const m = git.remote.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/i);
  if (!m) return null;
  let branch = 'HEAD';
  try { branch = execFileSync('git', ['-C', git.root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim() || 'HEAD'; } catch { /* detached/no-commits → HEAD */ }
  let rel; try { rel = relative(git.root, realpathSync(doc)); } catch { rel = relative(git.root, doc); }
  rel = rel.split('\\').join('/');
  return `https://github.com/${m[1]}/blob/${encodeURIComponent(branch)}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

function revealInFileManager(file) {
  let abs = file; try { abs = realpathSync(file); } catch {}
  const cmd = process.platform === 'darwin' ? ['open', ['-R', abs]]
    : process.platform === 'win32' ? ['explorer', ['/select,' + abs]]
    : ['xdg-open', [dirname(abs)]];
  spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
}
function out(obj) { console.log(JSON.stringify(obj)); }

// ---- gitignore the derived html on init -----------------------------------
function ensureGitignore(doc) {
  const dir = dirname(realpathSync(doc));
  let root = dir;
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).trim(); } catch {}
  const gi = root + '/.gitignore';
  // *.review.html = derived view; *.seal.notify.json = holds webhook URLs/secrets;
  // *.seal.baseline.md = local "doc as of the last brief" snapshot for the Change Brief.
  const lines = ['*.review.html', '*.seal.notify.json', '*.seal.requests.jsonl', '*.seal.baseline.md'];
  let body = ''; try { body = readFileSync(gi, 'utf8'); } catch {}
  const have = new Set(body.split('\n').map((l) => l.trim()));
  const add = lines.filter((l) => !have.has(l));
  if (!add.length) return false;
  appendFileSync(gi, (body && !body.endsWith('\n') ? '\n' : '') + add.join('\n') + '\n');
  return gi;
}

// Build a notify-prefs object from setup flags and persist it (gitignored).
// Channels: comma list in --notify (git|slack|teams|email). Secrets live here
// or in env; the document only records the non-secret channel choice + owner.
function writeNotifyPrefs(doc, channels) {
  const prefs = {
    channels,
    slack_webhook: arg('slack-webhook') || null,
    teams_webhook: arg('teams-webhook') || null,
    email_to: arg('email-to') || null,
    email_from: arg('email-from') || null,
    digest_interval: parseInt(arg('digest-interval') || '0', 10) || 0,
    note: 'Secrets (webhook URLs, email) — gitignored. Resend key via SEAL_RESEND_KEY env. Edit freely.',
  };
  const p = notifyPrefsPath(doc);
  writeFileSync(p, JSON.stringify(prefs, null, 2));
  return p;
}

// ===========================================================================
// Commands
// ===========================================================================
// Create the sidecar. Owner defaults to git user.name (so "according to git"),
// overridable with --owner. Returns details; throws nothing if already exists.
function initSidecar(doc, { force = false } = {}) {
  const sp = sidecarPath(doc);
  if (existsSync(sp) && !force) return { sp, created: false };
  const md = normalizeMarkdown(readDoc(doc));
  const h = contentHash(md);
  const now = nowISO();
  const source = basename(doc);
  const h1 = md.match(/^#\s+(.+?)\s*$/m);
  const git = gitInfo(dirname(doc));
  const ownerFlag = arg('owner');
  const da = docAuthor(md);                                  // the doc's author = publisher
  const owner = ownerFlag || da || git.name || undefined;    // explicit > doc author > git user
  const ownerSrc = ownerFlag ? 'flag' : (da ? 'doc' : (git.name ? 'git' : 'none'));
  const channels = (arg('notify') || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const r = {
    document: {
      kind: 'document', seal_schema_version: SCHEMA_VERSION, normalization_version: NORM_VERSION,
      source, title: arg('title') || (h1 ? h1[1].replace(/[*_`]/g, '').trim() : source.replace(/\.md$/i, '')),
      owner, notify: channels.length ? channels : undefined,
      created_at: now,
    },
    state: { kind: 'state', status: 'draft', content_hash: h, updated_at: now },
    comments: [], approvals: [],
  };
  writeSidecar(sp, r);
  try { writeFileSync(baselinePath(doc), readDoc(doc)); } catch {}   // Change Brief baseline = doc at review start
  const gi = ensureGitignore(doc);
  const notifyFile = channels.length ? writeNotifyPrefs(doc, channels) : null;
  return { sp, r, created: true, owner, ownerSource: ownerSrc, channels, notifyFile, contentHash: h, gitignore: gi, git };
}
function cmdInit() {
  const doc = docPath();
  const sp = sidecarPath(doc);
  if (existsSync(sp) && !flag('force')) die(`sidecar already exists: ${sp} (use --force to overwrite)`);
  const res = initSidecar(doc, { force: flag('force') });
  const html = regen(doc, res.r); maybeOpen(html);
  out({ ok: true, action: 'init', sidecar: res.sp, content_hash: res.contentHash, owner: res.owner || null, owner_source: res.ownerSource, notify: res.channels, notify_file: res.notifyFile, gitignore: res.gitignore || 'already-ignored', html });
}
// `start <doc.md>` — the one simple command: init if needed (owner from git),
// warn about git shareability, then open the live review.
function cmdStart() {
  const doc = docPath();
  const sp = sidecarPath(doc);
  const git = gitInfo(dirname(doc));
  let initRes = null;
  if (!existsSync(sp)) initRes = initSidecar(doc, {});
  const { r } = loadSidecar(doc);
  const owner = r.document.owner;
  // shareability guidance (the agent reads stderr; surfaces to the user)
  if (!git.inRepo) console.error('⚠  Not a git repo — this review is LOCAL ONLY (not shareable). `git init`, then commit doc.md + the .seal.md so others can view it.');
  else console.error(`✓  git repo${git.remote ? ' (' + git.remote + ')' : ''} — commit ${basename(doc)} + ${basename(sp)} so collaborators can view the review.`);
  if (!owner) console.error('⚠  No owner set, and git has no user.name. Set one: `--owner "Name"` (or `git config user.name`). The owner is the doc author / notify target.');
  else console.error(`👤 Owner: ${owner}${initRes ? ` (from ${initRes.ownerSource})` : ''}.`);
  START_OPEN = true;
  cmdServe();
}

// ---- mutation cores (no argv, no stdout; throw on error) -------------------
// Shared by the CLI wrappers and the `serve` HTTP handlers so a browser POST
// goes through the exact same fail-loud sidecar logic the CLI uses.
function findComment(r, id) { const cm = r.comments.find((x) => x.id === id); if (!cm) throw new Error(`no comment with id ${id}`); return cm; }

// `externalRef` + `origin` tag a comment that came FROM an external system (the GitHub PR,
// via `seal pull`) so re-pulls dedupe and the outbound mirror skips it (no echo back).
function coreComment(doc, { author, body, anchor, suggestion, mention, externalRef, origin }) {
  if (!body) throw new Error('body is required');
  const { sp, r } = loadSidecar(doc);
  const md = normalizeMarkdown(readDoc(doc));
  if (suggestion != null && !anchor) throw new Error('a suggestion needs an anchor (the span it replaces)');
  const people = readPeople(doc);
  const explicit = Array.isArray(mention) ? mention : (mention ? [mention] : []);
  const mentions = resolveMentions(people, body, explicit);  // [{name,handle,email,slack}]
  const cm = {
    kind: 'comment', id: rid('c'), author: author || gitUser(dirname(doc)) || 'anonymous',
    anchor: anchor ? makeAnchor(md, anchor) : null,
    suggestion: suggestion != null ? suggestion : undefined,
    mentions: mentions.length ? mentions.map((m) => ({ name: m.name, handle: m.handle, email: m.email || undefined })) : undefined,
    body,
    status: 'open', content_hash: contentHash(md), created_at: nowISO(), thread: [],
    origin: origin || undefined,
    external_ref: externalRef || undefined,
  };
  r.comments.push(cm);
  writeSidecar(sp, r);
  return { cm, sp, r, mentions };
}
function coreReply(doc, { id, author, body, externalRef }) {
  if (!id) throw new Error('id is required');
  if (!body) throw new Error('body is required');
  const { sp, r } = loadSidecar(doc);
  const cm = findComment(r, id);
  // external_ref pins a GitHub reply id so a re-pull dedupes it (thread entries are serialized
  // whole, so the extra field persists without a KEY_ORDER entry).
  cm.thread.push({ author: author || gitUser(dirname(doc)) || 'anonymous', body, created_at: nowISO(), external_ref: externalRef || undefined });
  writeSidecar(sp, r);
  return { cm, sp, r };
}
function coreSetStatus(doc, { id, status }) {
  if (!id) throw new Error('id is required');
  const { sp, r } = loadSidecar(doc);
  const cm = findComment(r, id);
  cm.status = status;
  writeSidecar(sp, r);
  return { cm, sp, r };
}
// Accept a suggestion: apply its replacement to the DOC (doc.md) and resolve it.
// Edits the markdown file — the content hash changes and anchored comments re-resolve.
function coreAccept(doc, { id }) {
  const { sp, r } = loadSidecar(doc);
  const cm = findComment(r, id);
  if (cm.suggestion == null) throw new Error('not a suggestion');
  if (!cm.anchor) throw new Error('suggestion has no anchor to replace');
  const raw = readDoc(doc);
  const q = cm.anchor.quote;
  let newRaw;
  const first = raw.indexOf(q);
  if (first === -1) throw new Error('could not find the original text in the doc — edit it manually');
  if (raw.indexOf(q, first + 1) === -1) {
    newRaw = raw.slice(0, first) + cm.suggestion + raw.slice(first + q.length);
  } else {
    // ambiguous: disambiguate with the stored prefix/suffix context
    const probe = (cm.anchor.prefix || '') + q + (cm.anchor.suffix || '');
    const at = raw.indexOf(probe);
    if (at === -1 || raw.indexOf(probe, at + 1) !== -1) throw new Error('the text appears multiple times — accept by editing manually');
    newRaw = raw.slice(0, at) + (cm.anchor.prefix || '') + cm.suggestion + (cm.anchor.suffix || '') + raw.slice(at + probe.length);
  }
  writeFileSync(doc, newRaw);
  cm.status = 'resolved';
  cm.accepted = true;
  writeSidecar(sp, r);
  return { cm, sp, r };
}

// Owner edit: overwrite doc.md with new markdown (e.g. from the Markdown editor).
function coreSaveDoc(doc, { markdown }) {
  if (typeof markdown !== 'string' || !markdown.trim()) throw new Error('refusing to write empty markdown');
  const tmp = doc + '.tmp';
  writeFileSync(tmp, markdown);
  renameSync(tmp, doc);
  return { content_hash: contentHash(markdown) };
}

// ---- CLI wrappers ----------------------------------------------------------
function cmdComment() {
  const doc = docPath();
  const mention = (arg('mention') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const { cm, sp, r } = coreComment(doc, { author: arg('author'), body: arg('body'), anchor: arg('anchor'), suggestion: arg('suggest'), mention });
  const html = regen(doc, r); maybeOpen(html);
  out({ ok: true, action: cm.suggestion != null ? 'suggest' : 'comment', id: cm.id, anchored: !!cm.anchor, mentions: cm.mentions || [], sidecar: sp, html });
}
function cmdReply() {
  const doc = docPath();
  const { cm, r } = coreReply(doc, { id: arg('id'), author: arg('author'), body: arg('body') });
  const html = regen(doc, r); maybeOpen(html);
  out({ ok: true, action: 'reply', id: cm.id, html });
}
function cmdSetStatus(status) {
  const doc = docPath();
  const { cm, r } = coreSetStatus(doc, { id: arg('id'), status });
  const html = regen(doc, r); maybeOpen(html);
  out({ ok: true, action: status === 'resolved' ? 'resolve' : 'reopen', id: cm.id, html });
}
function cmdAccept() {
  const doc = docPath();
  const { cm, r } = coreAccept(doc, { id: arg('id') });
  const html = regen(doc, r); maybeOpen(html);
  out({ ok: true, action: 'accept', id: cm.id, content_hash: liveHash(doc), html });
}
function cmdRender() {
  const doc = docPath();
  const { r } = loadSidecar(doc);
  const html = regen(doc, r); // respects --out
  maybeOpen(html);
  out({ ok: true, action: 'render', html, content_hash: liveHash(doc) });
}

function cmdHash() { out({ ok: true, action: 'hash', content_hash: liveHash(docPath()) }); }

// List every top-level block with its blk-N id, so a summary author can cite the
// exact jump target (src) for each key_decision / relevant_section. Headings only
// by default (the useful anchors); --all includes paragraphs/tables/etc.
function cmdBlocks() {
  const doc = docPath();
  const all = markdownBlocks(readDoc(doc));
  const blocks = arg('all') != null ? all : all.filter((b) => /^h[1-6]$/.test(b.tag));
  out({ ok: true, action: 'blocks', count: blocks.length, blocks: blocks.map((b) => ({ src: b.blk, tag: b.tag, text: b.text.slice(0, 120) })) });
}

// One-shot: add src="blk-N" to existing summary points that lack it, matching
// each point's section/label to a heading block. For role summaries written
// before the flow emitted jump targets. Only fills missing src; never overwrites.
function cmdBackfill() {
  const doc = docPath();
  const heads = markdownBlocks(readDoc(doc)).filter((b) => /^h[1-6]$/.test(b.tag));
  // strip leading "§N." / "#" / numbering + punctuation so "§3 Risks" ~ "Risks".
  const norm = (s) => String(s || '').toLowerCase()
    .replace(/^[\s§#*]*\d+(\.\d+)*\.?\s*/, '').replace(/[^a-z0-9 ]+/g, '').trim();
  const match = (label) => {
    const l = norm(label); if (!l) return null;
    let h = heads.find((b) => norm(b.text) === l);                                  // exact
    if (!h) h = heads.find((b) => { const t = norm(b.text); return t && (t.includes(l) || l.includes(t)); }); // contains
    return h ? h.blk : null;
  };
  const roles = readSummaryRoles(doc);
  if (!roles.length) { out({ ok: true, action: 'backfill', filled: 0, roles: 0, note: 'no summaries' }); return; }
  let filled = 0;
  for (const r of roles) {
    for (const o of (r.relevant_sections || [])) if (o && typeof o === 'object' && !o.src) { const b = match(o.section || o.label); if (b) { o.src = b; filled++; } }
    for (const o of (r.key_decisions || [])) if (o && typeof o === 'object' && !o.src) { const b = match(o.label); if (b) { o.src = b; filled++; } }
  }
  const sp = summaryFilePath(doc), tmp = sp + '.tmp';
  writeFileSync(tmp, JSON.stringify({ roles }, null, 2)); renameSync(tmp, sp);
  try { const { r } = loadSidecar(doc); regen(doc, r); } catch {} // refresh static page
  out({ ok: true, action: 'backfill', filled, roles: roles.length, file: sp });
}

// Stage the review's committable files (doc + review file + role summaries) and
// commit — the shareable artifacts. Never touches the gitignored derived/secret
// files. Core (throws); used by the CLI and the serve /api/commit endpoint.
function coreCommit(doc, { message, push, resetBaseline } = {}) {
  const git = gitInfo(dirname(doc));
  if (!git.inRepo) throw new Error('not a git repo — this review is local-only / not shareable. Run `git init` first.');
  const sp = sidecarPath(doc);
  if (!existsSync(sp)) throw new Error('no review file — run init first');
  const files = [doc, sp];
  const sj = summaryFilePath(doc); if (existsSync(sj)) files.push(sj);
  const rel = files.map((f) => { try { return relative(git.root, realpathSync(f)); } catch { return f; } });
  const G = (args) => execFileSync('git', args, { cwd: git.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  G(['add', '--', ...rel]);
  const msg = message || `seal: review ${basename(doc)}`;
  let committed = false;
  try { G(['commit', '-m', msg]); committed = true; } catch { /* nothing to commit */ }
  let pushed = false, pushError = null;
  if (committed && push) { try { G(['push']); pushed = true; } catch (e) { pushError = String(e.message || e).split('\n')[0]; } }
  // explicit share = the reviewer has caught up with the current doc → reset the
  // Change Brief baseline. (Per-comment auto-commit passes resetBaseline=false.)
  if (committed && resetBaseline) { try { writeFileSync(baselinePath(doc), readDoc(doc)); } catch {} }
  return { committed, pushed, pushError, files: rel, message: committed ? msg : null, remote: git.remote };
}
function cmdCommit() {
  const doc = docPath();
  const dashM = (() => { const i = process.argv.indexOf('-m'); return i !== -1 ? process.argv[i + 1] : null; })();
  const r = coreCommit(doc, { message: arg('message') || arg('m') || dashM, push: flag('push'), resetBaseline: true });
  out({ ok: true, action: 'commit', ...r, push_error: r.pushError, note: r.committed ? null : 'nothing to commit (no changes since last commit)' });
}

// Resolve the gh binary. A background `serve` may inherit a thin PATH that omits
// ~/.local/bin or Homebrew, so probe common locations, not just bare `gh`. Cached.
let _ghBin;
function ghBin() {
  if (_ghBin !== undefined) return _ghBin;
  const home = process.env.HOME || '';
  const cands = ['gh', `${home}/.local/bin/gh`, '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh'];
  for (const c of cands) {
    try { execFileSync(c, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] }); _ghBin = c; return c; }
    catch { /* try next */ }
  }
  _ghBin = null; return null;
}
// gh CLI available + authenticated? Cached. Lets us offer "commit & open PR"
// with no MCP server — the local gh login does the GitHub write.
let _ghReady;
function ghReady() {
  if (_ghReady !== undefined) return _ghReady;
  const bin = ghBin();
  if (!bin) { _ghReady = false; return false; }
  try { execFileSync(bin, ['auth', 'status'], { stdio: ['ignore', 'ignore', 'ignore'] }); _ghReady = true; }
  catch { _ghReady = false; }
  return _ghReady;
}

// The 1-based line in `docText` an anchor points at: locate prefix+quote (the prefix
// disambiguates repeated quotes), else the bare quote. null if neither is found.
export function anchorDocLine(docText, anchor = {}) {
  const q = anchor.quote || '';
  if (!q) return null; // no quote = degenerate anchor; a prefix match must not place it on line 1
  const pre = anchor.prefix || '';
  let off = -1;
  if (pre) { const i = docText.indexOf(pre + q); if (i >= 0) off = i + pre.length; }
  if (off < 0) { const i = docText.indexOf(q); if (i < 0 || !q) return null; off = i; }
  return docText.slice(0, off).split('\n').length;
}

// RIGHT-side line numbers that are actually part of the PR diff for `rel`. GitHub only
// accepts a review comment on a line in the diff; a file unchanged on the branch yields
// an empty set (→ every comment falls back to the summary).
export function changedRightLines(G, base, head, rel) {
  let diff = '';
  try { diff = G(['diff', `${base}...${head}`, '--unified=0', '--', rel]); } catch { return new Set(); }
  const set = new Set();
  for (const line of diff.split('\n')) {
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const start = +m[1];
    const count = m[2] === undefined ? 1 : +m[2];
    for (let i = 0; i < count; i++) set.add(start + i);
  }
  return set;
}

// Mirror the sidecar's OPEN comments onto a GitHub PR. Comments whose anchor line is in
// the PR diff become inline review comments; the rest collapse into one summary comment.
// Idempotent: inline comments carry a `seal:c=<id>` marker (skipped if already posted) and
// the summary comment carries `seal:pr-comments` (its prior copy is deleted before repost).
// Best-effort + throws nothing the caller cares about — corePR wraps it. Returns counts.
// Body for a mirrored review comment. A suggestion becomes a NATIVE GitHub
// ```suggestion block (author gets one-click "Commit suggestion") — but only when
// native:true (the comment sits inline on the diff line it replaces) and the
// replacement holds no ``` fence (which would break the block). Otherwise it
// degrades to plain `_Suggested:_` text (used for the non-inline summary path).
export function formatReviewComment(c, { native = false } = {}) {
  const who = c.author ? `**${c.author}**: ` : '';
  const thread = (c.thread || []).map((t) => `\n\n↳ **${t.author || '?'}**: ${t.body || ''}`).join('');
  let sug = '';
  if (c.suggestion != null) {
    const s = String(c.suggestion);
    sug = native && !s.includes('```')
      ? `\n\n\`\`\`suggestion\n${s}\n\`\`\``
      : `\n\n_Suggested:_ \`${s.replace(/`/g, '​`')}\``;
  }
  return `${who}${c.body || ''}${sug}${thread}`;
}

function corePostReviewComments(doc, git, { prUrl, head, base }) {
  const GHB = ghBin();
  if (!GHB || !git?.inRepo) return { inline: 0, summary: 0, skipped: 0 };
  const repo = (() => { try { return execFileSync(GHB, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: git.root, encoding: 'utf8' }).trim(); } catch { return null; } })();
  const n = (prUrl && (prUrl.match(/\/pull\/(\d+)/) || [])[1]) || null;
  if (!repo || !n) return { inline: 0, summary: 0, skipped: 0 };

  const G = (args) => execFileSync('git', args, { cwd: git.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const ghApi = (args, input) => execFileSync(GHB, ['api', ...args], { cwd: git.root, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const ghJSON = (path) => { try { return JSON.parse(ghApi([path, '--paginate']) || '[]'); } catch { return []; } };

  // Skip comments that came FROM GitHub (origin==='github', via `seal pull`) — re-posting
  // them would echo a reviewer's own PR comment back onto the PR.
  const open = loadSidecar(doc).r.comments.filter((c) => (c.status || 'open') === 'open' && c.origin !== 'github');
  if (!open.length) return { inline: 0, summary: 0, skipped: 0 };

  const docText = readDoc(doc);
  const rel = (() => { try { return relative(git.root, realpathSync(doc)); } catch { return basename(doc); } })().split('\\').join('/');
  const commitId = (() => { try { return G(['rev-parse', head]); } catch { return null; } })();
  const diffLines = changedRightLines(G, base, head, rel);

  // Already-posted inline ids (dedupe across re-runs / PR reuse).
  const posted = new Set(ghJSON(`repos/${repo}/pulls/${n}/comments`).filter((c) => /seal:c=/.test(c.body || '')).map((c) => (c.body.match(/seal:c=([^\s>]+)/) || [])[1]));

  const fmt = (c, opts) => formatReviewComment(c, opts);

  let inline = 0, skipped = 0;
  const leftover = [];
  for (const c of open) {
    const line = anchorDocLine(docText, c.anchor || {});
    if (commitId && line && diffLines.has(line)) {
      if (posted.has(c.id)) { skipped++; continue; }
      try {
        ghApi(['--method', 'POST', `repos/${repo}/pulls/${n}/comments`, '--input', '-'],
          JSON.stringify({ body: `<!-- seal:c=${c.id} -->\n${fmt(c, { native: true })}`, commit_id: commitId, path: rel, line, side: 'RIGHT' }));
        inline++;
      } catch { leftover.push({ c, line }); } // e.g. line not resolvable → summary
    } else {
      leftover.push({ c, line });
    }
  }

  // Off-diff comments: one issue comment EACH, carrying a seal:c=<id> marker — so a
  // reviewer can reply to a specific comment and a `seal pull` threads that reply
  // under the right parent (a single bulk summary couldn't be replied-to per item).
  let summary = 0;
  if (leftover.length) {
    const existing = ghJSON(`repos/${repo}/issues/${n}/comments`);
    // retire the old single bulk summary if a prior version posted one
    for (const ic of existing) {
      if (/^<!--\s*seal:pr-comments/m.test(ic.body || '')) { try { ghApi(['--method', 'DELETE', `repos/${repo}/issues/comments/${ic.id}`]); } catch { /* ignore */ } }
    }
    const issuePosted = new Set(existing.map((ic) => (String(ic.body || '').match(/^<!--\s*seal:c=([^\s>]+)/m) || [])[1]).filter(Boolean));
    for (const { c, line } of leftover) {
      if (issuePosted.has(c.id)) { skipped++; continue; }
      const loc = line ? `line ${line}` : 'the document';
      const q = (c.anchor || {}).quote ? ` · on “${c.anchor.quote.slice(0, 80)}${c.anchor.quote.length > 80 ? '…' : ''}”` : '';
      const head = `<!-- seal:c=${c.id} -->\n🦭 **Seal review** · _${loc}_${q}`;
      try { ghApi(['--method', 'POST', `repos/${repo}/issues/${n}/comments`, '--input', '-'], JSON.stringify({ body: `${head}\n\n${fmt(c)}` })); summary++; } catch { /* ignore */ }
    }
  }
  return { inline, summary, skipped };
}

// Commit the review artifacts onto a feature branch, push, and open (or reuse) a
// GitHub PR via `gh` — no MCP needed, the local gh login does the write. Core
// (throws); used by the CLI `pr` command and the serve /api/pr endpoint.
function corePR(doc, { title, body, branch } = {}) {
  const git = gitInfo(dirname(doc));
  if (!git.inRepo) throw new Error('not a git repo — run `git init` first');
  if (!git.remote) throw new Error('no git remote — add one: git remote add origin <url>');
  if (!ghReady()) throw new Error('GitHub CLI not ready — install `gh` and run `gh auth login`');
  const G = (args) => execFileSync('git', args, { cwd: git.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const GHB = ghBin();
  const GH = (args) => execFileSync(GHB, args, { cwd: git.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  // PR base = repo default branch (ask gh, fall back to origin/HEAD, then main)
  let base = null;
  try { base = GH(['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name']); } catch {}
  if (!base) { try { base = G(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).replace(/^origin\//, ''); } catch {} }
  base = base || 'main';
  const cur = (() => { try { return G(['rev-parse', '--abbrev-ref', 'HEAD']); } catch { return base; } })();
  // on the base branch (or detached) → cut a feature branch so the PR has a diff
  let head = cur;
  if (cur === base || cur === 'HEAD') {
    head = branch || `seal/review-${basename(doc).replace(/\.md$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '-')}`;
    try { G(['rev-parse', '--verify', head]); G(['checkout', head]); }   // exists → switch
    catch { G(['checkout', '-b', head]); }                               // else create
  }
  // stage + commit the review files on this branch (no push — we push the branch)
  const ttl = title || `Seal review: ${basename(doc).replace(/\.md$/i, '')}`;
  const commit = coreCommit(doc, { message: `seal: ${ttl}`, push: false });
  let pushed = false, pushError = null;
  try { G(['push', '-u', 'origin', head]); pushed = true; } catch (e) { pushError = String(e.message || e).split('\n')[0]; }
  // open the PR, or return the existing one for this branch
  let url = null, created = false;
  try { url = GH(['pr', 'view', head, '--json', 'url', '-q', '.url']); } catch {}
  if (!url) {
    url = GH(['pr', 'create', '--base', base, '--head', head, '--title', ttl,
      '--body', body || `Seal review of \`${basename(doc)}\`.`]);
    created = true;
  }
  // Mirror the review comments onto the PR (inline where the diff allows, else a summary).
  // Best-effort: a comment-posting hiccup must never fail an otherwise-open PR.
  let comments = null;
  try { comments = corePostReviewComments(doc, git, { prUrl: url, head, base }); } catch { /* advisory: never fail an open PR over comment mirroring */ }
  return { url, head, base, created, committed: commit.committed, pushed, pushError, remote: git.remote, comments };
}
function cmdPR() {
  const doc = docPath();
  const r = corePR(doc, { title: arg('title'), body: arg('body'), branch: arg('branch') });
  out({ ok: true, action: 'pr', ...r, push_error: r.pushError });
}

// Inbound half of two-way GitHub sync (Phase 2): pull NEW comments from the doc's PR back
// into the sidecar. Skips Seal's OWN posted comments (seal:c= / seal:pr-comments markers) and
// anything already imported (external_ref `gh:<id>`). Each import is anchored to the quoted
// line, names the GitHub author + section in the body, and mentions the doc OWNER — the local
// notify target. (The plugin has no role→person map, so the hosted "tag the section's role
// reviewer" degrades to the owner here; section-reviewer routing is a sealmd.net feature.)
// Drop the quoted block a GitHub "quote reply" prepends (lines starting with `>`),
// leaving just the reply text. Collapses the blank-line gap the quote leaves behind.
export function stripGithubQuote(s) {
  return String(s || '').split('\n').filter((l) => !/^\s*>/.test(l)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
// The seal:c=<id> a quote-reply carries names the local comment it replies to.
export function sealCommentRef(s) { const m = String(s || '').match(/seal:c=([^\s>)]+)/); return m ? m[1] : null; }

function corePull(doc, { prUrl } = {}) {
  const git = gitInfo(dirname(doc));
  if (!git.inRepo) throw new Error('not a git repo — run `git init` first');
  const GHB = ghBin();
  if (!GHB || !ghReady()) throw new Error('GitHub CLI not ready — install `gh` and run `gh auth login`');
  const repo = (() => { try { return execFileSync(GHB, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd: git.root, encoding: 'utf8' }).trim(); } catch { return null; } })();
  let url = prUrl;
  if (!url) { try { url = execFileSync(GHB, ['pr', 'view', '--json', 'url', '-q', '.url'], { cwd: git.root, encoding: 'utf8' }).trim(); } catch { /* no PR for branch */ } }
  const n = (url && (url.match(/\/pull\/(\d+)/) || [])[1]) || null;
  if (!repo || !n) throw new Error('no PR found for this branch — open one with `seal pr` first (or pass --pr <url>)');

  const ghApi = (args) => execFileSync(GHB, ['api', ...args], { cwd: git.root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const ghJSON = (p) => { try { return JSON.parse(ghApi([p, '--paginate']) || '[]'); } catch { return []; } };

  const { r } = loadSidecar(doc);
  const owner = r.document.owner || null;
  const roles = readSummaryRoles(doc);   // role → relevant_sections, for section→role routing
  const people = readPeople(doc);         // name → { handle, email, role? }, for role→person email
  const rel = (() => { try { return relative(git.root, realpathSync(doc)); } catch { return basename(doc); } })().split('\\').join('/');
  // A PR comment's line indexes the doc AT THE PR HEAD COMMIT, which can differ from the working
  // tree. Read the head version of the file for the quote/section the reviewer actually saw, then
  // anchor that quote into the CURRENT doc (coreComment) — if it still exists it anchors, else it
  // degrades to doc-level. Fall back to the working tree if the head blob can't be read.
  const G = (args) => execFileSync('git', args, { cwd: git.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let docLines;
  try {
    const headSha = execFileSync(GHB, ['pr', 'view', n, '--json', 'headRefOid', '-q', '.headRefOid'], { cwd: git.root, encoding: 'utf8' }).trim();
    docLines = G(['show', `${headSha}:${rel}`]).split('\n');
  } catch { docLines = readDoc(doc).split('\n'); }
  // Dedup across roots AND thread replies; ext→root-id lets a GitHub reply thread under its parent.
  const have = new Set();
  const extToId = new Map();
  for (const c of r.comments) {
    if (c.external_ref) { have.add(c.external_ref); extToId.set(c.external_ref, c.id); }
    for (const t of (c.thread || [])) if (t.external_ref) have.add(t.external_ref);
  }
  // OUR posts carry the marker at the START of a line. A reviewer's "quote reply"
  // pastes our comment too, but quoted (lines prefixed with `> `) — so match the
  // marker only when it's NOT inside a quote, else we'd skip the human's reply.
  const isOurs = (b) => /^<!--\s*seal:(c=|pr-comments)/m.test(b || '');
  const stripQuote = stripGithubQuote;
  const sealParentOf = sealCommentRef;
  // Nearest heading at or above a 1-based line — used to name the section in the imported body.
  const sectionFor = (ln) => {
    for (let i = Math.min(ln, docLines.length) - 1; i >= 0; i--) {
      const m = (docLines[i] || '').match(/^#{1,6}\s+(.+?)\s*#*$/);
      if (m) return m[1].trim();
    }
    return null;
  };

  let imported = 0, skipped = 0;
  const add = (ghId, login, rawText, ln, inReplyTo) => {
    const ext = `gh:${ghId}`;
    if (have.has(ext)) { skipped++; return; }
    const text = stripQuote(rawText);   // just the reply, not the quoted comment
    if (!text) { skipped++; return; }   // pure quote, nothing new
    // Thread under a parent: a GitHub review reply (in_reply_to) we already mirrored,
    // OR a quote-reply whose quoted text carries our seal:c=<localId> marker.
    const markerId = sealParentOf(rawText);
    const parentId = (inReplyTo ? extToId.get(`gh:${inReplyTo}`) : null)
      || (markerId && r.comments.some((c) => c.id === markerId) ? markerId : null);
    if (parentId) {
      coreReply(doc, { id: parentId, author: login, body: `**@${login}** replied on the GitHub PR:\n\n${text}`, externalRef: ext });
      have.add(ext); imported++;
      return;
    }
    const lt = ln ? String(docLines[ln - 1] || '').trim() : '';
    const sec = ln ? sectionFor(ln) : null;
    // Route to the section's reviewer: section → role (from the summaries) → a person with that
    // role (mentioned by email). Fall back to the doc owner. Name both role + section in the body.
    const role = roleForSection(roles, sec);
    const person = personForRole(people, role);
    const mentionTarget = person ? person.name : (owner || null);
    const forWhom = role ? ` — for the **${role}** reviewer` : '';
    const body = `**@${login}** on the GitHub PR${forWhom}${sec ? ` (§ ${sec})` : ''}:\n\n${text}`;
    const opts = { author: login, body, mention: mentionTarget ? [mentionTarget] : [], externalRef: ext, origin: 'github' };
    // makeAnchor throws if the line isn't found verbatim or is ambiguous in the (possibly
    // changed) doc — degrade to a doc-level comment rather than failing the whole pull.
    let cm;
    try { ({ cm } = coreComment(doc, { ...opts, anchor: lt || undefined })); }
    catch { ({ cm } = coreComment(doc, { ...opts, anchor: undefined })); }
    extToId.set(ext, cm.id); have.add(ext); imported++;
  };

  // Inline review comments (anchored to a line of OUR doc); then general PR comments (doc-level).
  // Roots before replies so a reply's parent is already in extToId.
  // Skip our own posts, bot noise (Vercel/CI deploy comments, etc.), and — for
  // review comments — anything not anchored to OUR doc. Keeps the import to the
  // human review of this document.
  const human = (c) => !isOurs(c.body) && (c.user?.type || 'User') !== 'Bot';
  const review = ghJSON(`repos/${repo}/pulls/${n}/comments`).filter((c) => human(c) && (!c.path || c.path.split('\\').join('/') === rel));
  const issue = ghJSON(`repos/${repo}/issues/${n}/comments`).filter(human);
  // Every external_ref still present on the PR — anything we imported but that's now absent was
  // deleted on GitHub.
  const present = new Set([...review, ...issue].map((c) => `gh:${c.id}`));
  for (const c of review.filter((c) => c.in_reply_to_id == null)) add(c.id, c.user?.login || 'unknown', c.body || '', c.line ?? c.original_line ?? null, null);
  for (const c of review.filter((c) => c.in_reply_to_id != null)) add(c.id, c.user?.login || 'unknown', c.body || '', c.line ?? c.original_line ?? null, c.in_reply_to_id);
  for (const c of issue) add(c.id, c.user?.login || 'unknown', c.body || '', null, null);

  // Archive (resolve) previously-imported ROOT comments deleted on GitHub. Never hard-delete —
  // matches Seal's never-delete rule. ponytail: thread-reply deletes + body edits don't sync in
  // the plugin's pull model (hosted gets both via webhooks); a stale body is the known trade-off.
  let resolved = 0;
  const { r: r2 } = loadSidecar(doc);
  for (const c of r2.comments) {
    if (c.origin === 'github' && c.external_ref && !present.has(c.external_ref) && (c.status || 'open') === 'open') {
      coreSetStatus(doc, { id: c.id, status: 'resolved' }); resolved++;
    }
  }
  const { r: r3 } = loadSidecar(doc); // reload after any resolves for render
  return { url, repo, pr: Number(n), imported, skipped, resolved, r: r3 };
}
function cmdPull() {
  const doc = docPath();
  const r = corePull(doc, { prUrl: arg('pr') });
  const html = regen(doc, r.r); maybeOpen(html);
  out({ ok: true, action: 'pull', url: r.url, pr: r.pr, imported: r.imported, skipped: r.skipped, resolved: r.resolved, html });
}

// Role summaries the live page requested but that don't exist yet. The agent
// drains this (generate each + `seal summary`) — works even if it missed the
// live SEAL_EVENT (e.g. wasn't watching the background task at that instant).
function cmdPending() {
  const doc = docPath();
  const rp = requestsPath(doc);
  const roles = readSummaryRoles(doc);
  const pending = []; const seen = new Set();
  if (existsSync(rp)) {
    for (const line of readFileSync(rp, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let q; try { q = JSON.parse(line); } catch { continue; }
      const role = (q.role || '').trim(); if (!role) continue;
      const k = role.toLowerCase(); if (seen.has(k)) continue; seen.add(k);
      if (!findRole(roles, role)) pending.push(role);     // not yet generated (fuzzy)
    }
  }
  out({ ok: true, action: 'pending', pending, doc });
}

// Write/replace a role-tailored summary into <doc>.seal.summary.json. The AI
// console calls this in response to a `summary_request` event (or proactively).
// Reads the summary body from --file <json>, --json '<inline>', or stdin.
function cmdSummary() {
  const doc = docPath();
  const role = arg('role'); if (!role) die('--role "<label>" is required');
  let raw = arg('json');
  if (!raw && arg('file')) raw = readFileSync(arg('file'), 'utf8');
  if (!raw && !process.stdin.isTTY) { try { raw = readFileSync(0, 'utf8'); } catch {} }
  if (!raw) die('provide the summary as --file <json>, --json "<...>", or on stdin');
  let body; try { body = JSON.parse(raw); } catch (e) { die(`summary JSON invalid: ${e.message}`); }
  const roleObj = {
    role, lead: body.lead || body.role_lead || '',
    key_decisions: body.key_decisions || [],
    relevant_sections: body.relevant_sections || body.sections || [],
    needs_attention: body.needs_attention || body.needs_your_judgment || [],
    source_hash: liveHash(doc),   // the doc version this summary was written for (drift detection)
  };
  const sp = upsertSummaryRole(doc, roleObj);
  // re-render so the static page reflects the new role too
  let html = null; try { const { r } = loadSidecar(doc); html = regen(doc, r); } catch {}
  out({ ok: true, action: 'summary', role, file: sp, html });
}

// ---- serve: loopback live review (the page writes the sidecar) -------------
// Binds to 127.0.0.1 ONLY (never a public interface). The page POSTs each
// comment/suggestion/decision; the same fail-loud cores append to the .seal.md.
// Every mutation is also emitted as a one-line EVENT to stdout — so when the AI
// console (Claude Code) launches `serve` as a background task, it is notified of
// each human action and can act, with no polling. Optional --notify-cmd runs an
// external command per event (e.g. a `claude -p` headless triage).
function emitEvent(ev) {
  process.stdout.write('SEAL_EVENT ' + JSON.stringify(ev) + '\n');
  const nc = arg('notify-cmd');
  if (nc) { try { spawn(nc, { shell: true, stdio: 'ignore', env: { ...process.env, SEAL_EVENT: JSON.stringify(ev) } }).unref(); } catch {} }
}
export function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
    req.on('close', () => resolve({})); // destroy() (over-cap) never fires 'end' — first resolve wins
    req.on('error', () => resolve({}));
  });
}
function cmdServe() {
  const doc = docPath();
  const r0 = loadSidecar(doc).r; // validate up front (fail loud before binding)
  const port = parseInt(arg('port') || '4317', 10);
  // notifications: peers (@mentions) + owner via Slack/Teams/email, optionally batched.
  const ncfg = buildNotifyCfg(doc);
  const reviewUrl = `http://127.0.0.1:${port}/`;
  const ownerPerson = r0.document.owner ? resolvePerson(readPeople(doc), r0.document.owner) : null;
  async function sendBatch(evs) {
    if (!evs.length) return;
    const text = evs.length === 1 ? formatEvent(evs[0], reviewUrl)
      : `📋 ${evs.length} review updates on *${r0.document.title}*\n` + evs.map((e) => '• ' + formatEvent(e, '').split('\n')[0]).join('\n') + `\n${reviewUrl}`;
    const emails = new Set(); if (ncfg.email.to) emails.add(ncfg.email.to);
    if (ownerPerson && ownerPerson.email) emails.add(ownerPerson.email);
    for (const e of evs) { for (const m of e.mentions || []) if (m.email) emails.add(m.email); for (const x of e.extraEmails || []) emails.add(x); }
    const jobs = [];
    if (ncfg.slack) jobs.push(sendSlack(ncfg.slack, text));
    if (ncfg.teams) jobs.push(sendTeams(ncfg.teams, text));
    if (ncfg.email.resendKey) for (const to of emails) jobs.push(sendEmail({ ...ncfg.email, to }, `Seal review · ${r0.document.title}`, text));
    try { await Promise.all(jobs); } catch {}
  }
  const digest = makeDigest(ncfg, sendBatch);
  const notify = (ev) => { if (notifyEnabled(ncfg)) digest.add({ ...ev, docTitle: r0.document.title }); };
  AUTO_COMMIT = flag('auto-commit');
  // best-effort commit+push after a mutation when auto-commit is on
  const autoCommitFire = () => {
    if (!AUTO_COMMIT) return;
    try { const r = coreCommit(doc, { push: true }); if (r.committed) emitEvent({ type: 'committed', pushed: r.pushed, doc }); } catch {}
  };
  const J = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  // SECURITY: the loopback bind is NOT an auth boundary — any web page the reviewer
  // has open can POST to 127.0.0.1, and DNS-rebinding defeats the bind. So: reject a
  // foreign Host (rebind), reject a cross-site Origin/Sec-Fetch (CSRF), and require a
  // per-session token (minted here, injected into the page) on every mutation. The
  // token is unguessable and same-origin-policy keeps a hostile page from reading it.
  const SESSION_TOKEN = randomBytes(18).toString('base64url');
  // Presence: the page polls /api/state every ~10s, so a recent poll means a browser
  // is open. Used to gate doc auto-pull + the brief-refresh loop to "only when viewed".
  let lastClientPollMs = 0;
  const pageOpen = () => lastClientPollMs > 0 && (Date.now() - lastClientPollMs) < 20000;
  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
  const hostOk = (req) => LOOPBACK.has((req.headers.host || '').replace(/:\d+$/, ''));
  const originOk = (req) => { const o = req.headers.origin; if (!o) return true; try { return LOOPBACK.has(new URL(o).hostname); } catch { return false; } };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const sfs = req.headers['sec-fetch-site'];
      if (!hostOk(req)) return J(res, 403, { ok: false, error: 'forbidden host' });
      if (!originOk(req) || (sfs && sfs !== 'same-origin' && sfs !== 'none')) return J(res, 403, { ok: false, error: 'cross-site request blocked' });
      if (req.method !== 'GET' && req.headers['x-seal-token'] !== SESSION_TOKEN) return J(res, 403, { ok: false, error: 'missing or invalid session token' });
      if (req.method === 'GET' && url.pathname === '/') {
        const { r } = loadSidecar(doc);
        const html = buildPage(doc, r, { mode: 'serve', token: SESSION_TOKEN });
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return;
      }
      // presence probe (does NOT count as a view — only the page's /api/state does)
      if (req.method === 'GET' && url.pathname === '/api/presence') {
        return J(res, 200, { ok: true, open: pageOpen(), since_ms: lastClientPollMs ? Date.now() - lastClientPollMs : null });
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        lastClientPollMs = Date.now();   // the page is polling → it's open
        const { r } = loadSidecar(doc);
        // summary_sig changes when a role brief is (re)generated, so the page reloads
        // to show it even though the DOC hash is unchanged.
        const sumSig = (() => { try { return contentHash(readFileSync(summaryFilePath(doc), 'utf8')); } catch { return ''; } })();
        return J(res, 200, { ok: true, comments: r.comments.length, auto_commit: AUTO_COMMIT, hash: liveHash(doc), summary_sig: sumSig });
      }
      // commit + push the review from the page
      if (req.method === 'POST' && url.pathname === '/api/commit') {
        const b = await readBody(req);
        const r = coreCommit(doc, { message: b.message, push: b.push !== false, resetBaseline: true });
        emitEvent({ type: 'committed', committed: r.committed, pushed: r.pushed, doc });
        return J(res, 200, { ok: true, ...r, push_error: r.pushError });
      }
      // commit the review onto a branch + open a GitHub PR via `gh` (no MCP)
      if (req.method === 'POST' && url.pathname === '/api/pr') {
        const b = await readBody(req);
        try {
          const pr = corePR(doc, { title: b.title, body: b.body, branch: b.branch });
          emitEvent({ type: 'pr_opened', url: pr.url, head: pr.head, base: pr.base, created: pr.created, doc });
          return J(res, 200, { ok: true, ...pr, push_error: pr.pushError });
        } catch (e) { return J(res, 200, { ok: false, error: String(e.message || e) }); }
      }
      // toggle auto-commit (commit+push after each comment/suggestion)
      if (req.method === 'POST' && url.pathname === '/api/autocommit') {
        const b = await readBody(req);
        AUTO_COMMIT = !!b.on;
        return J(res, 200, { ok: true, auto_commit: AUTO_COMMIT });
      }
      // browser is closing — tell the AI console the commit/share status
      if (req.method === 'POST' && url.pathname === '/api/closing') {
        const git = gitInfo(dirname(doc));
        const uncommitted = gitDirty(doc, git);
        let hint;
        if (!git.remote) hint = 'review browser closed. No git remote — the review is saved on disk (local-only). To share it, connect a repo and run `seal commit --push`.';
        else if (uncommitted) hint = `the reviewer left with UNCOMMITTED changes — run: seal commit ${doc} --push`;
        else hint = 'review browser closed; everything is committed & pushed.';
        emitEvent({ type: 'browser_closed', uncommitted, has_remote: !!git.remote, doc, hint });
        return J(res, 200, { ok: true, uncommitted, has_remote: !!git.remote });
      }
      // export a portable, self-contained static review file to share (the
      // loopback URL only works on this machine; the HTML file does not).
      // reveal the exported review file in the OS file manager (Finder/Explorer).
      // Path is recomputed server-side — never taken from the client.
      if (req.method === 'POST' && url.pathname === '/api/reveal') {
        const outFile = htmlPath(doc);
        if (!existsSync(outFile)) return J(res, 404, { ok: false, error: 'file not exported yet' });
        try { revealInFileManager(outFile); return J(res, 200, { ok: true, file: outFile }); }
        catch (e) { return J(res, 500, { ok: false, error: String(e.message || e) }); }
      }
      // reveal the SOURCE doc.md in the OS file manager — what the filename chip clicks
      // when the repo isn't on GitHub. Path recomputed server-side.
      if (req.method === 'POST' && url.pathname === '/api/reveal-doc') {
        if (!existsSync(doc)) return J(res, 404, { ok: false, error: 'doc not found' });
        try { revealInFileManager(doc); return J(res, 200, { ok: true, file: doc }); }
        catch (e) { return J(res, 500, { ok: false, error: String(e.message || e) }); }
      }
      // bundle all shareable files (review.html + sidecar + source .md + summaries)
      // into ONE zip for the user to attach. Falls back to the folder path if the
      // `zip` tool isn't present. Paths recomputed server-side.
      if (req.method === 'POST' && url.pathname === '/api/bundle') {
        const bnd = makeBundle(doc);
        if (bnd.zip) emitEvent({ type: 'bundle_ready', zip: bnd.zip, files: bnd.names, doc });
        return J(res, 200, { ok: true, zip: bnd.zip, dir: bnd.dir, files: bnd.names });
      }
      // download the bundle straight from the browser: build fresh, stream as a
      // zip attachment so the browser saves it (no folder reveal needed).
      if (req.method === 'GET' && url.pathname === '/api/bundle.zip') {
        const bnd = makeBundle(doc);
        if (!bnd.zip) return J(res, 501, { ok: false, error: 'the `zip` tool is not available on this machine' });
        const data = readFileSync(bnd.zip);
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${basename(bnd.zip)}"`,
          'content-length': data.length,
        });
        res.end(data); return;
      }
      // actually SEND the review by email via Resend (SEAL_RESEND_KEY), with the
      // bundle attached. Returns { sent:false, reason } when not configured so the
      // page can fall back to opening a local mail draft.
      if (req.method === 'POST' && url.pathname === '/api/send-email') {
        const b = await readBody(req);
        const ncfg = buildNotifyCfg(doc);
        const to = (Array.isArray(b.to) ? b.to : String(b.to || '').split(',')).map((s) => String(s).trim()).filter(Boolean);
        if (!ncfg.email.resendKey) return J(res, 200, { ok: true, sent: false, reason: 'no-resend-key' });
        if (!to.length) return J(res, 200, { ok: true, sent: false, reason: 'no-recipients' });
        const bnd = makeBundle(doc);
        const attachments = bnd.zip
          ? [{ filename: basename(bnd.zip), content: readFileSync(bnd.zip).toString('base64') }] : [];
        const r = await sendEmailRich(ncfg.email, { to, subject: b.subject || 'Seal review', text: b.body || '', attachments });
        if (r.ok) { emitEvent({ type: 'email_sent', to, doc, attached: attachments.length > 0 }); return J(res, 200, { ok: true, sent: true, to, attached: attachments.length > 0 }); }
        return J(res, 200, { ok: true, sent: false, reason: r.error || 'send-failed' });
      }
      // reveal an arbitrary review artifact (zip / folder) — POST { what:'zip'|'dir' }
      if (req.method === 'POST' && url.pathname === '/api/reveal-bundle') {
        const b = await readBody(req);
        const dir = dirname(realpathSync(doc));
        const base = basename(doc).replace(/\.md$/i, '');
        const target = b.what === 'zip' ? `${dir}/${base}.review-bundle.zip` : dir;
        if (!existsSync(target)) return J(res, 404, { ok: false, error: 'not found — bundle first' });
        try { revealInFileManager(target); return J(res, 200, { ok: true, file: target }); }
        catch (e) { return J(res, 500, { ok: false, error: String(e.message || e) }); }
      }
      // role-tailored summary: poll for a role (exact or nearest) — generated on demand
      if (req.method === 'GET' && url.pathname === '/api/summary') {
        const roles = readSummaryRoles(doc);
        const want = url.searchParams.get('role') || '';
        const hit = findRole(roles, want);
        return J(res, 200, hit ? { ok: true, status: 'ready', role: hit.role, summary: hit }
          : { ok: true, status: 'none', role: want, available: roles.map((r) => r.role) });
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        // ponytail: no sidecar lock — every core* mutator is synchronous (load→mutate→
        // writeSidecar with no await between), so the event loop serializes concurrent
        // POSTs and writeSidecar's tmp+rename is atomic. Keep mutators sync; if one ever
        // gains an await mid-mutation, add a per-doc lock or it races (lost update).
        let result;
        if (url.pathname === '/api/comment') {
          const { cm } = coreComment(doc, { author: body.author, body: body.body, anchor: body.anchor, suggestion: body.suggestion, mention: body.mention });
          result = { ok: true, id: cm.id, anchored: !!cm.anchor, suggestion: cm.suggestion != null, mentions: cm.mentions || [] };
          const ev = { type: cm.suggestion != null ? 'suggestion' : 'comment', id: cm.id, author: cm.author, anchor: cm.anchor ? cm.anchor.quote : null, body: cm.body, suggestion: cm.suggestion ?? null, mentions: cm.mentions || [], extraEmails: body.email ? String(body.email).split(',').map((s) => s.trim()).filter(Boolean) : [], doc };
          emitEvent(ev); notify(ev); autoCommitFire();
        } else if (url.pathname === '/api/reply') {
          const { cm } = coreReply(doc, body); result = { ok: true, id: cm.id };
          const ev = { type: 'reply', id: cm.id, author: body.author, body: body.body, doc };
          emitEvent(ev); notify(ev); autoCommitFire();
        } else if (url.pathname === '/api/resolve' || url.pathname === '/api/dismiss') {
          const { cm } = coreSetStatus(doc, { id: body.id, status: 'resolved' }); result = { ok: true, id: cm.id };
          emitEvent({ type: 'dismiss', id: cm.id, doc }); autoCommitFire();
        } else if (url.pathname === '/api/reopen') {
          const { cm } = coreSetStatus(doc, { id: body.id, status: 'open' }); result = { ok: true, id: cm.id };
          emitEvent({ type: 'reopen', id: cm.id, doc }); autoCommitFire();
        } else if (url.pathname === '/api/accept') {
          const { cm } = coreAccept(doc, { id: body.id });
          result = { ok: true, id: cm.id, content_hash: liveHash(doc) };
          emitEvent({ type: 'accept', id: cm.id, doc, hint: 'a suggestion was applied to the doc — content hash changed' }); autoCommitFire();
        } else if (url.pathname === '/api/doc') {
          const { content_hash } = coreSaveDoc(doc, { markdown: body.markdown });
          result = { ok: true, content_hash };
          // defer_commit: autosave-while-typing writes the file but skips the
          // per-save commit/push (the editor fires one commit on exit instead).
          emitEvent({ type: 'doc_edited', doc, content_hash, hint: 'owner edited the document' });
          if (!body.defer_commit) autoCommitFire();
        } else if (url.pathname === '/api/summary') {
          // request a role-tailored summary; if not present, ask the AI console (event) to generate it
          const roles = readSummaryRoles(doc);
          const want = (body.role || '').trim();
          const hit = findRole(roles, want);
          // regenerate: doc drifted, so re-ask the agent to rewrite an EXISTING role's brief
          if (hit && body.regenerate) {
            try { appendFileSync(requestsPath(doc), JSON.stringify({ role: hit.role, at: nowISO(), regenerate: true }) + '\n'); } catch {}
            emitEvent({ type: 'summary_request', role: hit.role, doc, regenerate: true, hint: `ACTION: the doc changed — regenerate the "${hit.role}" brief and run: seal summary --in ${doc} --role "${hit.role}" --file <json>` });
            return J(res, 200, { ok: true, status: 'generating', role: hit.role });
          }
          if (hit) return J(res, 200, { ok: true, status: 'ready', role: hit.role, summary: hit });
          // durable queue so the agent can fulfil it even if it missed the live event
          try { appendFileSync(requestsPath(doc), JSON.stringify({ role: want, at: nowISO() }) + '\n'); } catch {}
          emitEvent({ type: 'summary_request', role: want, doc, hint: `ACTION: generate a role-tailored summary for "${want}" and run: seal summary --in ${doc} --role "${want}" --file <json>` });
          return J(res, 200, { ok: true, status: 'generating', role: want });
        } else { return J(res, 404, { ok: false, error: 'unknown route' }); }
        return J(res, 200, result);
      }
      J(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      J(res, 400, { ok: false, error: String(e.message || e) });
    }
  });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { digest.stop(); } catch {} process.exit(0); });
  server.listen(port, '127.0.0.1', () => {
    const u = `http://127.0.0.1:${port}/`;
    console.error(`seal serve — live review at ${u}  (loopback only; Ctrl-C to stop)`);
    console.error(`Posts write ${sidecarPath(doc)} via the same fail-loud engine. Events stream to stdout for the AI console.`);
    if (notifyEnabled(ncfg)) console.error(`Notifications ON → ${[ncfg.slack && 'slack', ncfg.teams && 'teams', ncfg.email.resendKey && 'email'].filter(Boolean).join(', ')}${ncfg.digestInterval ? ` (digest every ${ncfg.digestInterval}s)` : ''}`);
    emitEvent({ type: 'serve_started', url: u, doc });
    // Auto-pull GitHub PR replies back into the sidecar so the live page reflects
    // them with no manual `seal pull`. Best-effort: silent when there's no PR /
    // gh isn't ready. `--pull-interval 0` disables. ponytail: corePull is sync
    // (blocking gh calls) like autoCommit already is — fine at a 45s cadence; move
    // to async if a serve ever needs sub-second responsiveness during a pull.
    const pullSecs = parseInt(arg('pull-interval') || '45', 10);
    if (pullSecs > 0 && ghReady()) {
      let pulling = false;
      const pullTick = () => {
        if (pulling) return;
        if (!pageOpen()) return;   // only sync while someone's viewing the review
        pulling = true;
        // 1) fast-forward the DOC from GitHub (edits made on github.com land locally)
        try {
          if (ffMergeFromUpstream(doc)) {
            const h = liveHash(doc);
            emitEvent({ type: 'doc_synced', doc, content_hash: h, hint: 'doc updated from GitHub — the role summary/brief is now stale; regenerate with `seal summary` (or /seal-role)' });
          }
        } catch { /* skip */ }
        // 2) pull the PR COMMENTS into the sidecar
        try { const r = corePull(doc, {}); if (r.imported || r.resolved) emitEvent({ type: 'pr_synced', imported: r.imported, resolved: r.resolved, pr: r.pr, doc, hint: 'pulled new GitHub PR comments into the review' }); }
        catch { /* no PR yet / transient — retry next tick */ }
        finally { pulling = false; }
      };
      const iv = setInterval(pullTick, pullSecs * 1000); iv.unref && iv.unref();
      const kick = setTimeout(pullTick, 3000); kick.unref && kick.unref();
    }
    if (flag('open') || START_OPEN) {
      const cmd = process.platform === 'darwin' ? ['open', [u]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]] : ['xdg-open', [u]];
      try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); } catch {}
    }
  });
}

function cmdStatus() {
  const doc = docPath();
  const { r } = loadSidecar(doc);
  const md = normalizeMarkdown(readDoc(doc));
  const live = contentHash(md);
  const comments = r.comments.map((cm) => ({ ...cm, anchor_status: resolveAnchor(cm.anchor, md) }));
  const open = comments.filter((cm) => cm.status === 'open');
  const unanchored = comments.filter((cm) => cm.anchor && cm.anchor_status !== 'here');
  const summary = {
    ok: true, action: 'status', title: r.document.title, source: r.document.source,
    content_hash: live,
    comments: { total: comments.length, open: open.length, resolved: comments.length - open.length },
    unanchored_comments: unanchored.length,
    html: htmlPath(doc),
  };
  if (flag('json')) { out(summary); return; }
  const L = [];
  L.push(`${c('1', '📄 ' + summary.title)}  ${c('2', '(' + summary.source + ')')}`);
  L.push(`   hash ${c('2', SHORT(live))}`);
  L.push(`   comments: ${c('1', open.length)} open / ${comments.length} total`);
  for (const cm of open) {
    const tag = cm.anchor_status === 'unanchored' ? c('33', '⚠ context changed') : cm.anchor ? c('32', 'anchored') : c('2', 'doc-level');
    L.push(`     ${c('2', cm.id)} [${cm.author}] ${tag}  ${cm.body.replace(/\n/g, ' ').slice(0, 56)}${cm.body.length > 56 ? '…' : ''}`);
  }
  if (unanchored.length) L.push(c('33', `   ⚠ ${unanchored.length} comment(s) lost their anchor (the quoted text is gone)`));
  L.push('');
  L.push(`   ${c('2', 'review page:')} ${htmlPath(doc)}`);
  L.push(`   ${c('2', 'open it:')} seal render --in ${doc} --open`);
  console.log(L.join('\n'));
}

function cmdDoctor() {
  const doc = docPath();
  const sp = sidecarPath(doc);
  if (!existsSync(sp)) die(`no sidecar at ${sp}`);
  // parseSidecar already fails loud on any structural problem; reaching here = OK.
  const r = parseSidecar(readFileSync(sp, 'utf8'), sp);
  const res = { ok: true, action: 'doctor', sidecar: sp, records: { comments: r.comments.length }, valid: true };
  if (flag('json')) { out(res); return; }
  console.log(c('32', `✓ ${sp} is well-formed`) + ` · ${r.comments.length} comment(s)`);
}

// ===========================================================================
const USAGE = `seal-review — fully local, two-file document review (doc.md + doc.seal.md).

Usage: node seal.mjs <command> --in <doc.md> [opts]

  init      create the sidecar + notification setup
            [--title T] [--owner "Name"] [--notify git,slack,teams,email]
            [--slack-webhook URL] [--teams-webhook URL] [--email-to ADDR] [--digest-interval SECS] [--force]
  status    comments + anchors      [--json]
  start     <doc.md>   the one command: init if needed (owner from git) + open live review
  comment   --body B [--author A] [--anchor "exact span"] [--suggest "replacement"] [--mention name,name]
  reply     --id ID --body B [--author A]
  resolve   --id ID            reopen --id ID
  render    [--out f.html] [--summary s.json] [--open]
  serve     live local review — the page writes the sidecar  [--port N] [--open] [--notify-cmd CMD]
  summary   write a role-tailored summary  --role "Label" [--file j.json | --json '…' | stdin]
  pending   list role summaries the live page requested but that don't exist yet  [--json]
  commit    stage + commit the review (doc + .seal.md + summaries) to git  [-m "msg"] [--push]
  pr        open/reuse a GitHub PR for the review + mirror the comments onto it
  pull      pull NEW comments from the PR back into the review  [--pr URL]
  hash      print bare-hex content hash
  doctor    validate the sidecar (read-only)               [--json]

Flow: comment / suggest / resolve on the doc locally. To get approval, open a PR
(\`seal pr\`) and have the team approve or merge it on GitHub — Seal does not track
approval state locally. Mutating commands auto-render unless --no-render.
Sidecar defaults to <doc>.seal.md.`;

function run() {
  const cmd0 = process.argv[2];
  // `seal <doc.md>` (bare path) is shorthand for `start`.
  const cmd = (cmd0 && /\.md$/i.test(cmd0) && !cmd0.startsWith('-')) ? 'start' : cmd0;
  try {
    switch (cmd) {
      case 'start': cmdStart(); break;
      case 'init': cmdInit(); break;
      case 'status': cmdStatus(); break;
      case 'comment': cmdComment(); break;
      case 'reply': cmdReply(); break;
      case 'resolve': case 'dismiss': cmdSetStatus('resolved'); break;
      case 'reopen': cmdSetStatus('open'); break;
      case 'accept': cmdAccept(); break;
      case 'render': cmdRender(); break;
      case 'serve': cmdServe(); break;
      case 'summary': cmdSummary(); break;
      case 'pending': cmdPending(); break;
      case 'commit': cmdCommit(); break;
      case 'pr': cmdPR(); break;
      case 'pull': cmdPull(); break;
      case 'hash': cmdHash(); break;
      case 'blocks': cmdBlocks(); break;
      case 'backfill-src': cmdBackfill(); break;
      case 'doctor': cmdDoctor(); break;
      default:
        console.error(USAGE);
        process.exit(cmd ? 1 : 0);
    }
  } catch (e) { die(String(e.message || e)); }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) run();
