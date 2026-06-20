// ============================================================================
// sealmd — render core. Markdown -> self-contained, zero-network HTML.
//
// High-fidelity visual + behavioral port of the production sealmd.net review
// page (packages/core/review-page.mjs). Calm paper, single Mercury-indigo
// accent, wax-seal mark, 760px doc + 312px rail, light+dark token swap.
//
// Production parity:
//   - production token set (light+dark, :root[data-theme]) verbatim
//   - chrome -> modebanner (underline view tabs) -> workspace(pagecol + rail)
//   - .rolebar role switcher: .lensin + <datalist> + .lensgo + .lenspills (+N more)
//   - summary surface: stag "written for <role>", lead, key decisions,
//     "What this means for you" (relevant_sections), "Your call to make"
//   - .railseg (Change Brief / Comments / Ask) with .railpane toggling
//   - cards in the production .card / .sg suggestion style
//   - bidirectional anchor<->comment focus via <mark class="cmt-hl" data-anchor>
//     + client-side wrapFirst() + Google-Docs alignCards() in Full doc
//   - SERVE mode role generation: skeleton -> POST/poll /api/summary
//
// sealmd extras production lacks (kept, restyled native):
//   - select-text -> Comment composer (.selcompose) + serve POST /api/comment
//     vs static "copy for agent" fallback
//   - view/scroll/role persistence across the post-save location.reload()
//
// Zero dependencies, pure ESM, self-contained (inline CSS/JS, no network refs).
// system-ui font stack (Roboto first if locally installed; no webfont fetch).
// ============================================================================

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const SAFE_URL = /^(https?:|mailto:|#|\/|\.\/|\.\.\/|[^:]*$)/i;
function safeUrl(url) { return SAFE_URL.test(url.trim()) ? url : '#blocked-unsafe-url'; }

export function renderInline(text) {
  const codeSpans = [];
  let out = text.replace(/(`+)([^`]|[^`].*?[^`])\1(?!`)/g, (m, ticks, code) => {
    const token = ` CODE${codeSpans.length} `;
    codeSpans.push(`<code>${escapeHtml(code.trim())}</code>`);
    return token;
  });
  out = escapeHtml(out);
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (m, alt, src) => `<img src="${escapeHtml(safeUrl(src))}" alt="${alt}">`);
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
    (m, label, url) => `<a href="${escapeHtml(safeUrl(url))}">${label}</a>`);
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__(.+?)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_\w])_([^_\s][^_]*?)_(?![\w])/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+?)~~/g, '<del>$1</del>');
  out = out.replace(/ CODE(\d+) /g, (m, i) => codeSpans[+i]);
  return out;
}

export function renderMarkdown(md) {
  const lines = md.split('\n');
  const html = [];
  let i = 0;
  const isBlank = (l) => l.trim() === '';
  function parseTableRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    const cells = []; let cur = ''; let codeTicks = 0;
    for (let k = 0; k < s.length; k++) {
      if (s[k] === '`') {
        let run = 1; while (s[k + run] === '`') run++;
        if (codeTicks === 0) codeTicks = run; else if (run === codeTicks) codeTicks = 0;
        cur += s.slice(k, k + run); k += run - 1; continue;
      }
      if (codeTicks === 0 && s[k] === '\\' && s[k + 1] === '|') { cur += '|'; k++; continue; }
      if (codeTicks === 0 && s[k] === '|') { cells.push(cur); cur = ''; continue; }
      cur += s[k];
    }
    cells.push(cur); return cells.map((c) => c.trim());
  }
  function isTableSeparator(line) {
    const s = line.trim();
    if (!/[|]/.test(s) && !/^:?-+:?$/.test(s)) return false;
    const cells = parseTableRow(s);
    if (cells.length === 0) return false;
    return cells.every((c) => /^:?-{1,}:?$/.test(c.replace(/\s/g, '')) && c.includes('-'));
  }
  function parseList(start) {
    const listItemRe = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    const baseMatch = lines[start].match(listItemRe);
    const baseIndent = baseMatch[1].length;
    const ordered = /\d/.test(baseMatch[2]);
    const tag = ordered ? 'ol' : 'ul';
    let out = `<${tag}>`; let j = start;
    while (j < lines.length) {
      const line = lines[j];
      if (isBlank(line)) {
        let k = j + 1; while (k < lines.length && isBlank(lines[k])) k++;
        if (k < lines.length && listItemRe.test(lines[k])) {
          const ni = lines[k].match(listItemRe)[1].length;
          if (ni >= baseIndent) { j = k; continue; }
        }
        break;
      }
      const m = line.match(listItemRe);
      if (!m) break;
      const indent = m[1].length;
      if (indent < baseIndent) break;
      if (indent > baseIndent) { const nested = parseList(j); out = out.replace(/<\/li>$/, nested.html + '</li>'); j = nested.next; continue; }
      out += `<li>${renderInline(m[3])}</li>`; j++;
    }
    out += `</${tag}>`; return { html: out, next: j };
  }
  while (i < lines.length) {
    let line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const fence = line.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const marker = fence[2][0]; const fenceLen = fence[2].length; const lang = fence[3].trim();
      const code = []; i++;
      while (i < lines.length) {
        const close = lines[i].match(/^(\s*)(`{3,}|~{3,})\s*$/);
        if (close && close[2][0] === marker && close[2].length >= fenceLen) { i++; break; }
        code.push(lines[i]); i++;
      }
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      html.push(`<pre><code${cls}>${escapeHtml(code.join('\n'))}</code></pre>`); continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) { html.push(`<h${heading[1].length}>${renderInline(heading[2])}</h${heading[1].length}>`); i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { html.push('<hr>'); i++; continue; }
    if (/^\s*>\s?/.test(line)) {
      const quoted = [];
      while (i < lines.length && (/^\s*>\s?/.test(lines[i]) || (!isBlank(lines[i]) && quoted.length))) {
        if (isBlank(lines[i])) break;
        quoted.push(lines[i].replace(/^\s*>\s?/, '')); i++;
      }
      html.push(`<blockquote>${renderMarkdown(quoted.join('\n'))}</blockquote>`); continue;
    }
    if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const header = parseTableRow(line);
      const aligns = parseTableRow(lines[i + 1]).map((cell) => {
        const s = cell.replace(/\s/g, ''); const left = s.startsWith(':'); const right = s.endsWith(':');
        if (left && right) return 'center'; if (right) return 'right'; if (left) return 'left'; return '';
      });
      i += 2; const rows = [];
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) { rows.push(parseTableRow(lines[i])); i++; }
      let t = '<table><thead><tr>';
      header.forEach((h, cidx) => { const a = aligns[cidx] ? ` style="text-align:${aligns[cidx]}"` : ''; t += `<th${a}>${renderInline(h)}</th>`; });
      t += '</tr></thead><tbody>';
      for (const r of rows) { t += '<tr>'; for (let cc = 0; cc < header.length; cc++) { const a = aligns[cc] ? ` style="text-align:${aligns[cc]}"` : ''; t += `<td${a}>${renderInline(r[cc] !== undefined ? r[cc] : '')}</td>`; } t += '</tr>'; }
      t += '</tbody></table>'; html.push(t); continue;
    }
    if (/^(\s*)([-*+]|\d+[.)])\s+/.test(line)) { const { html: lh, next } = parseList(i); html.push(lh); i = next; continue; }
    const para = [];
    while (i < lines.length && !isBlank(lines[i])) {
      const l = lines[i];
      if (/^(#{1,6})\s+/.test(l)) break;
      if (/^(\s*)(`{3,}|~{3,})/.test(l)) break;
      if (/^\s*>\s?/.test(l)) break;
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) break;
      if (/^(\s*)([-*+]|\d+[.)])\s+/.test(l)) break;
      if (l.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) break;
      para.push(l); i++;
    }
    if (para.length) {
      const joined = para.map((p) => p.replace(/ {2,}$/, ' BR ')).join('\n');
      html.push(`<p>${renderInline(joined).replace(/ BR \n/g, '<br>\n')}</p>`);
    }
  }
  // Give every top-level block an id (blk-N) so anchors can scroll to them.
  return html.map((b, n) => addBlockId(b, n)).join('\n');
}

// Inject id="blk-N" into the first tag of a top-level rendered block.
function addBlockId(block, n) {
  return block.replace(/^(\s*)<([a-z0-9]+)(\s|>)/i, (m, ws, tag, rest) =>
    `${ws}<${tag} id="blk-${n}"${rest === '>' ? '>' : rest}`);
}

export function deriveSummary(md, wordCount) {
  const lines = md.split('\n');
  let lead = '';
  for (const raw of lines) {
    const l = raw.trim();
    if (!l || /^#{1,6}\s/.test(l) || /^[-*+]\s/.test(l) || /^\d+[.)]\s/.test(l)) continue;
    if (l.startsWith('>') || l.startsWith('|') || l.startsWith('```')) continue;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) continue;
    lead = l.replace(/^#{1,6}\s+/, ''); break;
  }
  if (!lead) lead = 'Document ready for review.';
  const key_decisions = [];
  const relevant_sections = [];
  for (const l of lines) {
    const m = l.match(/^##\s+(.*?)\s*#*\s*$/);
    if (m) {
      const label = m[1].replace(/[*_`]/g, '').trim();
      if (label) { key_decisions.push({ label: 'Section', value: label }); relevant_sections.push({ section: label, detail: 'See the Full doc for this section.' }); }
    }
    if (key_decisions.length >= 8) break;
  }
  if (key_decisions.length === 0) key_decisions.push({ label: 'Length', value: `${wordCount} words` });
  return {
    role_lead: lead, lead,
    key_decisions,
    relevant_sections: relevant_sections.slice(0, 6),
    needs_your_judgment: [`Auto-derived summary. Full document is ${wordCount} words — open "Full doc" to verify nothing material is missing.`],
    needs_attention: [`Auto-derived summary. Full document is ${wordCount} words — open "Full doc" to verify nothing material is missing.`],
  };
}

// ---- role slugging (mirrors ai/summary.mjs slugifyRole) --------------------
function slugifyRole(input) {
  return String(input == null ? '' : input)
    .trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

// ---- ICONS (verbatim from production ICONS map) ----------------------------
const ICONS = {
  spark: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/></svg>',
  arrow: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  check: '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5L20 7"/></svg>',
};

// ---- the canonical summary inner-HTML for ONE role -------------------------
// Accepts the role object the caller passes: { role, lead|role_lead,
// key_decisions:[{label,value}], needs_attention|needs_your_judgment:[...],
// relevant_sections?:[{section,detail}] }. Produces the READY-state markup
// AFTER the .lenspills (lead / key decisions / what-this-means / your-call).
function summaryReadyInner(summary, wordCount) {
  const lead = String(summary.role_lead || summary.lead || '');
  // drop blank entries so a partial summary never renders an empty header / row
  const kds = (summary.key_decisions || []).filter((k) => k && (String(k.label || '').trim() || String(k.value || '').trim()));
  const secs = (summary.relevant_sections || []).filter((s) => s && (String(s.section || '').trim() || String(s.detail || '').trim()));
  const judg = (summary.needs_your_judgment || summary.needs_attention || []).filter((n) => String(n || '').trim());
  const keys = kds
    .map((k) => `<li><span class="kk">${escapeHtml(k.label || '')}</span><span class="vv">${renderInline(String(k.value || ''))}</span></li>`).join('\n');
  const rsecs = secs
    .map((s) => `<div class="rsec"><div class="rsh">${escapeHtml(s.section || '')}</div><div class="rsd">${renderInline(String(s.detail || ''))}</div></div>`).join('\n');
  const judges = judg
    .map((n) => `<div class="judge"><span class="ji"></span><span>${renderInline(String(n))}</span></div>`).join('\n');
  return `<p class="lead">${renderInline(lead)}</p>
${kds.length ? `<h3>Key decisions</h3><ul class="keys">${keys}</ul>` : ''}
${secs.length ? `<h3>What this means for you</h3><div class="rsecs">${rsecs}</div>` : ''}
${judg.length ? `<h3>Your call to make</h3>${judges}` : ''}
<div class="meta2"><span>Full document: <b>${wordCount.toLocaleString()} words</b></span><span class="sep">·</span><span>written for your role</span><span class="sep">·</span><span>open “Full doc” for everything</span></div>`;
}

function avInitials(name) { return escapeHtml(String(name || '?').split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase()); }

// ---- one comment / suggestion card -----------------------------------------
// data-anchor + data-quote drive the client-side wrapFirst() highlight and
// the bidirectional focus. Suggestions use the production .sg card shape.
function cardActions(c) {
  // owner actions (shown only in serve mode via body.can-edit). Accept applies a
  // suggestion to the doc; Dismiss resolves the comment.
  if (c.status === 'resolved') return c.accepted ? '<div class="cacc">✓ applied to the document</div>' : '';
  const accept = c.suggestion != null ? `<button class="btn primary tiny" data-accept="${escapeHtml(c.id)}">Accept</button>` : '';
  return `<div class="cactions owneract">${accept}<button class="btn ghost tiny" data-dismiss="${escapeHtml(c.id)}">Dismiss</button></div>`;
}
function card(c) {
  const isSug = c.suggestion != null;
  const disposed = c.status === 'resolved';
  const anchor = c.anchor && c.anchor_status === 'here' ? c.id : '';
  const anchorAttrs = anchor
    ? ` data-anchor="${escapeHtml(anchor)}" data-quote="${escapeHtml(c.anchor.quote)}"`
    : '';
  const thread = (c.thread || []).map((t) =>
    `<div class="reply"><span class="rav">${avInitials(t.author)}</span><div class="rb"><div class="rn">${escapeHtml(t.author)}</div><div>${renderInline(t.body)}</div></div></div>`).join('');
  const threadHtml = thread ? `<div class="thread">${thread}</div>` : '';

  if (isSug) {
    const badge = disposed ? '<span class="sg-badge no">resolved</span>' : '<span class="sg-badge open">open</span>';
    const old = c.anchor ? c.anchor.quote : '';
    return `<div class="card sg${disposed ? ' disposed' : ''}" id="card-${escapeHtml(c.id)}" data-cmt-id="${escapeHtml(c.id)}"${anchorAttrs}>
  <div class="chead"><span class="av agent">${avInitials(c.author)}</span>
    <div style="min-width:0"><div class="who-name">${escapeHtml(c.author)}</div><div class="who-sub">suggestion</div></div>
    ${badge}</div>
  ${old ? `<div class="sg-q">${renderInline(old)}</div>` : ''}
  <div class="sg-prop"><span class="sg-arrow">→</span>${renderInline(c.suggestion)}</div>
  ${c.body ? `<div class="sg-disp">${renderInline(c.body)}</div>` : ''}
  ${threadHtml}${cardActions(c)}</div>`;
  }

  const quoted = c.anchor
    ? `<div class="quoted">Marked on “${escapeHtml(c.anchor.quote.slice(0, 80))}${c.anchor.quote.length > 80 ? '…' : ''}”</div>`
    : '';
  return `<div class="card${disposed ? ' disposed' : ''}" id="card-${escapeHtml(c.id)}" data-cmt-id="${escapeHtml(c.id)}"${anchorAttrs}>
  <div class="chead"><span class="av">${avInitials(c.author)}</span>
    <div style="min-width:0"><div class="who-name">${escapeHtml(c.author)}</div><div class="who-sub">${escapeHtml(c.status)}</div></div>
    <span class="ctype">comment</span></div>
  ${quoted}<div class="ctext">${renderInline(c.body)}</div>${threadHtml}${cardActions(c)}</div>`;
}

function statusBadge(review) {
  if (!review) return { cls: '', label: 'review' };
  const s = review.status;
  if (s === 'approved' && review.approved_for_current_version) return { cls: 'ok', label: `Approved · ${review.approves}/${review.quorum}` };
  if (s === 'approved') return { cls: 'amber', label: 'Approved (superseded)' };
  if (s === 'changes_requested') return { cls: 'amber', label: 'Changes requested' };
  if (s === 'in_review') return { cls: 'seal', label: `In review · ${review.approves}/${review.quorum}` };
  return { cls: '', label: 'Draft' };
}

function approvalsPanel(review) {
  if (!review || (review.status === 'draft' && review.approvals.length === 0)) return '';
  const cards = review.approvals.map((a) => {
    const ok = a.decision === 'approved';
    const tag = !a.current ? '<span class="ctype">superseded</span>' : a.valid_now ? '<span class="ctype suggest">current</span>' : '<span class="ctype">stale</span>';
    return `<div class="card"><div class="chead"><span class="av ${ok ? 'pm' : 'agent'}">${avInitials(a.approver)}</span>
      <div style="min-width:0"><div class="who-name">${escapeHtml(a.approver)}</div><div class="who-sub">${ok ? 'approved' : 'requested changes'} · <code>${escapeHtml((a.content_hash || '').slice(0, 10))}</code></div></div>${tag}</div>
      ${a.note ? `<div class="body">${renderInline(a.note)}</div>` : ''}</div>`;
  }).join('\n');
  return `<h2 class="railhdr" style="margin-top:18px">Approvals · ${review.approves}/${review.quorum}${review.doc_edited_after_submit ? ' · <span style="color:var(--amber)">stale</span>' : ''}</h2><div class="cards">${cards}</div>`;
}

const SEAL_SVG = `<svg viewBox="0 0 80 64" fill="none" stroke="currentColor" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M40 6 C41.74 6, 42.87 13.56, 45.21 14.25 C47.55 14.94, 52.6 9.19, 54.06 10.13 C55.52 11.07, 52.38 18.04, 53.98 19.89 C55.58 21.73, 62.93 19.62, 63.65 21.2 C64.37 22.78, 57.96 26.95, 58.31 29.37 C58.66 31.78, 65.98 33.98, 65.74 35.7 C65.49 37.42, 57.84 37.46, 56.83 39.69 C55.81 41.91, 60.79 47.71, 59.65 49.03 C58.51 50.34, 52.06 46.24, 50 47.56 C47.95 48.88, 48.99 56.46, 47.33 56.95 C45.66 57.44, 42.44 50.5, 40 50.5 C37.56 50.5, 34.34 57.44, 32.67 56.95 C31.01 56.46, 32.05 48.88, 30 47.56 C27.94 46.24, 21.49 50.34, 20.35 49.03 C19.21 47.71, 24.19 41.91, 23.17 39.69 C22.16 37.46, 14.51 37.42, 14.26 35.7 C14.02 33.98, 21.34 31.78, 21.69 29.37 C22.04 26.95, 15.63 22.78, 16.35 21.2 C17.07 19.62, 24.42 21.73, 26.02 19.89 C27.62 18.04, 24.48 11.07, 25.94 10.13 C27.4 9.19, 32.45 14.94, 34.79 14.25 C37.13 13.56, 38.26 6, 40 6 Z"/><circle cx="40" cy="32" r="13"/><path d="M33.5 32.5 L38 37 L47.5 26"/></svg>`;

export function renderReviewPage({
  title, srcName, srcUrl, docPath = '', enginePath = 'seal', roles = [],
  curatedRoles = [], reviewerRole = '', people = [], mcp = [],
  canCommit = false, gitRemote = null, autoCommit = false, dirty = false, canPR = false,
  mdRaw, contentHash, wordCount, comments = [], review = null, renderedAt = '', mode = 'static',
}) {
  if (!roles.length) roles = [{ role: 'General', ...deriveSummary(mdRaw, wordCount) }];

  const comms = comments.map((c) => ({ ...c, anchor_status: c.anchor_status || (c.anchor ? 'unanchored' : 'none') }));
  const here = comms.filter((c) => c.anchor_status === 'here');
  const unanchored = comms.filter((c) => c.anchor && c.anchor_status !== 'here');
  const suggestions = comms.filter((c) => c.suggestion != null);
  const plainComments = comms.filter((c) => c.suggestion == null);

  const fullHtml = renderMarkdown(mdRaw);

  const srcChip = srcUrl
    ? `<a class="src" href="${escapeHtml(srcUrl)}" title="Open the source file">${escapeHtml(srcName)}</a>`
    : `<span class="src">${escapeHtml(srcName)}</span>`;
  const badge = statusBadge(review);
  const verChip = `v·${escapeHtml(contentHash.slice(0, 7))}`;

  // ---- role data: key everything by slug(label) -----------------------------
  const roleMap = {};   // slug -> ready inner html
  const roleLabels = {}; // slug -> human label
  for (const r of roles) {
    const slug = slugifyRole(r.role) || 'general';
    roleMap[slug] = summaryReadyInner(r, wordCount);
    roleLabels[slug] = r.role;
  }
  const defaultLabel = reviewerRole || roles[0].role;
  const defaultSlug = slugifyRole(defaultLabel) || slugifyRole(roles[0].role) || 'general';

  // Curated taxonomy (objects {value,label}) — matches sealmd.net's role picker.
  // Fall back to deriving from the pre-generated role labels if not supplied.
  const taxonomy = (Array.isArray(curatedRoles) && curatedRoles.length && typeof curatedRoles[0] === 'object')
    ? curatedRoles.map((c) => ({ slug: c.value, label: c.label }))
    : roles.map((r) => ({ slug: slugifyRole(r.role) || 'general', label: r.role }));
  // datalist = taxonomy labels (+ any extra pre-generated role labels not in it)
  const optLabels = []; const seen = new Set();
  for (const lbl of [...taxonomy.map((t) => t.label), ...roles.map((r) => r.role)]) {
    const k = String(lbl || '').toLowerCase();
    if (!lbl || seen.has(k)) continue; seen.add(k); optLabels.push(lbl);
  }
  const datalist = optLabels.map((l) => `<option value="${escapeHtml(l)}"></option>`).join('');

  // ensure every taxonomy slug has a label for client-side labelFor()
  for (const t of taxonomy) if (!roleLabels[t.slug]) roleLabels[t.slug] = t.label;

  // Pills are rendered CLIENT-side from a sticky, user-editable set (localStorage).
  // The ▼ dropdown opens the full taxonomy to add a role; each added pill has an ×.
  const summaryHtml = `<div class="stag">${ICONS.spark} Seal summary · written for <b>${escapeHtml(defaultLabel)}</b></div>
<div class="rolebar">
  <form class="lensbox" id="lensForm" autocomplete="off">
    <input id="roleInput" class="lensin" value="${escapeHtml(defaultLabel)} summary" placeholder="Summary for… type any role" aria-label="Summary role" spellcheck="false">
    <button class="lensgo" type="submit" aria-label="Apply">${ICONS.arrow}</button>
    <button class="lensdrop" id="lensMore" type="button" aria-label="Browse roles" title="Browse roles">▾</button>
  </form>
  <span class="rl-hint">type any role, or ▾ to pick · pills stay — × to remove</span>
</div>
<div class="lensmenu" id="lensMenu" hidden></div>
<div class="lenspills" id="lensPills"></div>
<div id="sumReady">${roleMap[defaultSlug]}</div>`;

  // ---- rail: comments + suggestions -----------------------------------------
  const suggestionsHtml = suggestions.length
    ? `<div class="sg-sec">${suggestions.map(card).join('\n')}</div>`
    : '';
  const cardsHtml = plainComments.map(card).join('\n');
  const cmtCount = plainComments.length;
  const sugCount = suggestions.length;
  const totalCount = comms.length;

  const railEmpty = totalCount === 0
    ? `<div class="rail-empty" id="railEmpty">No comments or suggestions yet. Add one above, or select text in the <b>Full doc</b> to pin a comment.</div>`
    : '';
  const unanchoredNote = unanchored.length
    ? `<div class="rolenote" style="margin-top:10px"><span>⚠ ${unanchored.length} comment(s) lost their anchor — the marked text is no longer in the document.</span></div>`
    : '';

  // ---- client data ----------------------------------------------------------
  const SEAL_JS_DATA = JSON.stringify({
    summaries: roleMap, labels: roleLabels, defaultSlug, title: title || srcName,
    docPath, enginePath, srcName, mode, wordCount,
    people: Array.isArray(people) ? people : [],
    mcp: Array.isArray(mcp) ? mcp : [],
    taxonomy: taxonomy.map((t) => ({ slug: t.slug, label: t.label })),
    canCommit, gitRemote, autoCommit, dirty, canPR,
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html><html lang="en" data-theme="dark"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)} — Seal review</title>
<style>
  :root,:root[data-theme="light"]{
    color-scheme:light;
    --font-sans:'Roboto',system-ui,-apple-system,"Segoe UI","Helvetica Neue",Arial,sans-serif;
    --font-mono:ui-monospace,"SF Mono","Roboto Mono",Menlo,Consolas,monospace;
    --app:#f0f1f6;--paper:#ffffff;--panel:#f4f5f9;--panel-2:#fbfcfd;--panel-hover:#eceef4;
    --line:rgba(112,115,147,0.10);--line-strong:rgba(112,115,147,0.16);
    --ink:#1e1e2a;--ink-soft:#363644;--muted:#70707d;--faint:#9d9da8;--ink-press:#0d111c;
    --seal:#5266eb;--seal-ink:#3e4fc9;--seal-soft:#eef0fe;--seal-line:#d2d9f4;--seal-press:#4354c8;
    --ok:#036e43;--ok-line:#bfe3d0;--ok-soft:#e3f1ea;--ok-press:#025a37;
    --amber:#a44200;--amber-soft:#f6ecdd;
    --violet:#5266eb;--violet-soft:#eef0fe;--violet-ring:#b9c3ef;--violet-line:#d2d9f4;
    --sev-high:#b3334c;
    --ins:#036e43;--ins-soft:#e3f1ea;--del:#b3334c;--del-soft:#fbeae6;
    --mark:#f3eccf;--mark-focus:#e9dcaf;
    --fill:rgba(112,115,147,0.10);--fill-strong:rgba(112,115,147,0.16);
    --thumb:#ffffff;--input-fill:#ffffff;--on-accent:#ffffff;--on-ok:#ffffff;
    --w-read:400;--w-interact:500;--w-announce:500;
    --r-paper:8px;--r-sm:4px;--r-md:8px;--r-lg:10px;--r-pill:9999px;
    --ease:cubic-bezier(0.16,1,0.3,1);--t-fast:120ms;--t-base:180ms;--t-slow:260ms;--t-med:.22s;
    --shadow-card:0 0 2px rgba(175,178,206,.56),0 1px 4px rgba(4,4,52,.10);
    --shadow-pop:0 0 2px rgba(175,178,206,.56),0 6px 20px rgba(4,4,52,.12);
    --shadow-soft:0 0 2px rgba(175,178,206,.5);--shadow:var(--shadow-pop);
    --card-border:transparent;--toast-bg:#1e1e2a;--toast-ink:#ffffff;
  }
  :root[data-theme="dark"]{
    color-scheme:dark;
    --app:#10101a;--paper:#1e1e2a;--panel:#272735;--panel-2:#171721;--panel-hover:#30303f;
    --line:rgba(180,183,200,0.12);--line-strong:rgba(180,183,200,0.20);
    --ink:#f4f5f9;--ink-soft:#dddde5;--muted:#9d9da8;--faint:#70707d;--ink-press:#000000;
    --seal:#8da4f5;--seal-ink:#a9bcff;--seal-soft:#23263a;--seal-line:#34385a;--seal-press:#6d86f0;
    --ok:#77c599;--ok-line:#2a4a3a;--ok-soft:#18271f;--ok-press:#5fb083;
    --amber:#f0a868;--amber-soft:#3a2e1c;
    --violet:#8da4f5;--violet-soft:#23263a;--violet-ring:#5266eb;--violet-line:#34385a;
    --sev-high:#ff7a90;
    --ins:#77c599;--ins-soft:#18271f;--del:#ff7a90;--del-soft:rgba(193,67,46,.16);
    --mark:#3f3a26;--mark-focus:#574f30;
    --fill:rgba(180,183,200,0.08);--fill-strong:rgba(180,183,200,0.16);
    --thumb:#272735;--input-fill:rgba(180,183,200,0.08);--on-accent:#ffffff;--on-ok:#10101a;
    --shadow-card:0 0 2px rgba(0,0,0,.40),0 1px 4px rgba(0,0,0,.45);
    --shadow-pop:0 1px 2px rgba(0,0,0,.45),0 8px 24px rgba(0,0,0,.55);
    --shadow-soft:0 0 2px rgba(0,0,0,.4);--shadow:var(--shadow-pop);
    --card-border:var(--line);--toast-bg:#272735;--toast-ink:#f4f5f9;
  }
  *{box-sizing:border-box}
  html,body{height:auto}
  body{margin:0;background:var(--app);color:var(--ink);font-family:var(--font-sans);overflow:visible;line-height:1.5;
    transition:background var(--t-base) var(--ease),color var(--t-base) var(--ease);-webkit-font-smoothing:antialiased;font-weight:400}
  button,input,select,textarea{font-family:inherit}
  a{color:var(--seal)}code{font-family:var(--font-mono)}
  .icon{width:1em;height:1em;display:inline-block;vertical-align:-.12em}
  ::selection{background:var(--violet-soft);color:var(--ink)}
  :root[data-theme="dark"] ::selection{background:#34406e;color:#f4f5f9}
  /* chrome / header / substrip */
  .chrome{position:sticky;top:0;z-index:50;background:var(--panel-2)}
  header.top{background:var(--panel-2);border-bottom:1px solid var(--line);position:relative;z-index:50}
  header.top .row{display:flex;align-items:center;gap:12px;padding:8px 16px;flex-wrap:wrap}
  .logo{display:flex;align-items:center;gap:8px;font-weight:600;font-size:16px;color:var(--ink);letter-spacing:-.01em;text-decoration:none;cursor:pointer}
  .logo:hover{opacity:.8}
  .seal-mark{display:inline-flex;align-items:center;justify-content:center;color:var(--seal)}
  .seal-mark svg{width:28px;height:22px;display:block}
  .titlewrap{display:flex;flex-direction:row;align-items:baseline;gap:7px;min-width:0}
  .doctitle{flex:1;font-weight:600;font-size:18px;color:var(--ink);letter-spacing:-.01em;margin-left:2px;outline:none;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .docver{flex:0 0 auto;font-size:11.5px;font-weight:600;color:var(--muted);background:var(--panel);border-radius:var(--r-sm);padding:2px 6px}
  .readprompt{display:flex;align-items:center;gap:12px;min-width:0;flex-wrap:wrap}
  #liveTag{display:inline-flex;align-items:center;gap:6px;color:var(--muted);font-weight:500;font-size:11px}
  #liveTag::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--seal);box-shadow:0 0 0 3px var(--seal-soft);flex-shrink:0}
  .spacer{flex:1}
  .src{font-family:var(--font-mono);font-size:11.5px;color:var(--muted);background:var(--fill);padding:2px 8px;border-radius:var(--r-sm);text-decoration:none}
  a.src:hover{background:var(--panel-hover)}
  .ghost{border:1px solid var(--line-strong);background:var(--fill);color:var(--ink-soft);border-radius:var(--r-md);padding:6px 11px;font-size:12.5px;cursor:pointer;font-family:inherit;font-weight:500}
  .ghost:hover{background:var(--panel-hover)}
  .substrip{display:flex;align-items:center;gap:8px;padding:0 16px 8px 16px;font-size:12px;color:var(--muted);flex-wrap:wrap}
  .badge{font-size:11.5px;font-weight:600;border-radius:var(--r-pill);padding:3px 10px;border:1px solid var(--line-strong);background:var(--fill);color:var(--muted)}
  .badge.ok{color:var(--ok);background:var(--ok-soft);border-color:var(--ok-line)}
  .badge.amber{color:var(--amber);background:var(--amber-soft);border-color:#e7d3b0}
  .badge.seal{color:var(--seal);background:var(--seal-soft);border-color:var(--seal-line)}
  /* mode banner (underline view tabs) */
  .modebanner{font-size:12px;padding:0 10px;display:flex;align-items:center;gap:4px;
    border-bottom:1px solid var(--line);background:var(--panel-2);color:var(--muted);position:relative;z-index:46}
  .modebanner b{color:var(--ink-soft);font-weight:500}
  .modebanner #viewSeg{margin-right:auto;align-self:stretch;background:transparent;border:0;border-radius:0;padding:0;gap:2px;display:inline-flex}
  .modebanner #viewSeg button{font-size:14px;font-weight:600;padding:11px 16px 9px;border-radius:0;color:var(--muted);
    background:transparent;box-shadow:none;border:0;border-bottom:2px solid transparent;cursor:pointer;font-family:inherit}
  .modebanner #viewSeg button:hover{color:var(--ink-soft);background:var(--fill)}
  .modebanner #viewSeg button.on{color:var(--ink);font-weight:700;background:transparent;box-shadow:none;border-bottom-color:var(--seal)}
  .mb-desc{min-width:0;max-width:640px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--muted);padding:9px 0}
  /* workspace / columns */
  .workspace{position:static;top:auto;overflow-y:visible}
  .canvas-area{display:flex;justify-content:center;gap:32px;padding:32px 24px 150px;min-height:100%;max-width:1160px;margin:0 auto}
  .pagecol{width:760px;max-width:100%;flex-shrink:1;min-width:0}
  .summary{display:none;background:var(--paper);border:1px solid var(--line);border-radius:var(--r-lg);box-shadow:var(--shadow-card);padding:32px}
  body.view-summary .summary{display:block}
  .page{display:none;background:var(--paper);border:1px solid var(--card-border);border-radius:var(--r-lg);box-shadow:var(--shadow-card);padding:56px 72px;min-height:880px;position:relative;color:var(--ink-soft)}
  body.view-full .page{display:block}
  .docmd{display:none;background:var(--paper);border:1px solid var(--card-border);border-radius:var(--r-lg);box-shadow:var(--shadow-card);
    padding:32px 36px;margin:0;font-family:var(--font-mono);font-size:13px;line-height:1.65;color:var(--ink-soft);white-space:pre-wrap;word-break:break-word;overflow-x:auto}
  body.view-md .docmd{display:block}
  body.view-md .summary,body.view-md .page{display:none !important}
  .rail{width:312px;flex-shrink:0;position:relative}
  .railhdr{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:0 0 10px;font-weight:600}
  /* document typography */
  .page :is(h1,h2,h3,h4,p,li,td,th){font-family:var(--font-sans)}
  .page h1{font-size:28px;font-weight:500;margin:0 0 6px;color:var(--ink);letter-spacing:-.02em;line-height:1.25}
  .page h2{font-size:19px;font-weight:500;margin:24px 0 8px;color:var(--ink);letter-spacing:-.01em;line-height:1.3}
  .page h3{font-size:15px;font-weight:500;margin:16px 0 4px;color:var(--ink)}
  .page h4{font-size:13.5px;font-weight:600;margin:14px 0 4px;color:var(--ink-soft)}
  .page p{font-size:16px;line-height:1.7;color:var(--ink-soft);margin:8px 0;max-width:70ch}
  .page strong{color:var(--ink);font-weight:600}
  .page ul,.page ol{margin:8px 0;padding-left:24px}
  .page li{font-size:16px;line-height:1.7;color:var(--ink-soft);margin:4px 0;max-width:70ch}
  .page table{border-collapse:collapse;width:100%;margin:12px 0;font-size:13px}
  .page th,.page td{border:1px solid var(--line);padding:8px 12px;text-align:left;vertical-align:top}
  .page th{background:var(--panel);font-weight:600;font-size:12px;color:var(--ink)}
  .page blockquote{border-left:3px solid var(--seal-line);background:var(--seal-soft);margin:12px 0;padding:8px 16px;color:var(--ink-soft);border-radius:0 var(--r-sm) var(--r-sm) 0}
  .page hr{border:0;border-top:1px solid var(--line);margin:24px 0}
  .page code{font-size:13px;background:var(--panel);padding:1px 5px;border-radius:var(--r-sm);color:var(--seal-ink)}
  .page pre{background:var(--panel);color:var(--ink-soft);border-radius:var(--r-md);padding:16px 18px;overflow-x:auto;font-size:13px;border:1px solid var(--line)}
  .page pre code{background:transparent;color:inherit;padding:0}
  /* in-doc anchor highlight */
  mark.cmt-hl{background:var(--amber-soft,#fdf0d0);border-bottom:2px solid #e7b54d;border-radius:2px;padding:0 1px;cursor:pointer;color:inherit;transition:background var(--t-fast,.15s) ease}
  mark.cmt-hl:hover,mark.cmt-hl.active{background:#f7d98a}
  :root[data-theme="dark"] mark.cmt-hl{background:#5a4a1e;border-bottom-color:#caa23f;color:#f4f5f9}
  :root[data-theme="dark"] mark.cmt-hl:hover,:root[data-theme="dark"] mark.cmt-hl.active{background:#7a6526}
  .anchor{scroll-margin-top:120px}.blk{position:relative}
  .page [id^="blk-"]{scroll-margin-top:120px}
  /* summary surface */
  .summary .stag{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:500;color:var(--ink-soft);background:var(--panel);border:1px solid var(--line);border-radius:var(--r-sm);padding:6px 12px}
  .summary .stag .icon{width:14px;height:14px;color:var(--ink-soft)}
  .summary .stag b{font-weight:600;color:var(--ink)}
  .summary .lead{font-size:18px;line-height:1.55;color:var(--ink);margin:16px 0 0;font-weight:400}
  .summary .lead b,.summary .lead strong{font-weight:600}
  .summary h3{font-size:11px;text-transform:uppercase;letter-spacing:.06em;font-weight:600;color:var(--muted);margin:24px 0 4px}
  .summary ul.keys{list-style:none;padding:0;margin:8px 0 0}
  .summary ul.keys li{display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid var(--line);font-size:15px}
  .summary ul.keys li .kk{color:var(--muted);min-width:152px;font-size:13px;padding-top:2px}
  .summary ul.keys li .vv{color:var(--ink)}
  .summary ul.keys li .vv b,.summary ul.keys li .vv strong{color:var(--ink);font-weight:600}
  .summary .judge{background:var(--panel);border:0;border-left:2px solid var(--sev-high);border-radius:var(--r-sm);padding:12px 14px;margin-top:14px;color:var(--ink-soft);font-size:14px;line-height:1.55;display:flex;gap:10px;align-items:flex-start}
  .summary .judge .ji{flex-shrink:0;width:7px;height:7px;border-radius:50%;background:var(--sev-high);margin-top:7px}
  .summary .judge b,.summary .judge strong{color:var(--ink);font-weight:600}
  .summary .meta2{font-size:12px;color:var(--muted);margin-top:24px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .summary .meta2 .sep{color:var(--line-strong)}
  .rsecs{margin-top:4px}
  .rsec{padding:9px 0;border-bottom:1px dashed var(--line)}
  .rsh{font-weight:650;font-size:14px;color:var(--ink)}
  .rsd{font-size:14px;color:var(--ink-soft);margin-top:2px;line-height:1.5}
  .rsd b,.rsd strong{color:var(--ink);font-weight:600}
  /* role switcher */
  .rolebar{display:flex;align-items:center;gap:9px;margin:14px 0 2px;flex-wrap:wrap}
  .lensbox{display:flex;align-items:center;gap:6px;flex:1;min-width:0;max-width:340px}
  .lensin{flex:1;min-width:0;font-size:13px;font-weight:600;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:6px 10px;background:var(--panel)}
  .lensin:focus{outline:none;border-color:var(--seal);box-shadow:0 0 0 3px var(--seal-soft)}
  .lensin::placeholder{color:var(--muted);font-weight:500}
  .lensgo{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:30px;height:30px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--muted);cursor:pointer}
  .lensgo:hover{color:var(--seal);border-color:var(--seal)}
  .lensgo .icon{width:16px;height:16px}
  .rl-hint{font-size:12px;color:var(--muted)}
  .lenspills{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 2px}
  .lenspill{display:inline-flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:var(--muted);background:transparent;border:1px solid var(--line);border-radius:999px;padding:4px 11px;cursor:pointer;line-height:1.4}
  .lenspill:hover{color:var(--ink);border-color:var(--ink)}
  .lenspill.on{color:#fff;background:var(--seal);border-color:var(--seal)}
  .lenspill .pillx{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;font-size:13px;line-height:1;opacity:.55;margin-right:-3px}
  .lenspill .pillx:hover{opacity:1;background:rgba(255,255,255,.18)}
  .lenspill.on .pillx{color:#fff}
  .lensdrop{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;width:30px;height:30px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--muted);cursor:pointer;font-size:12px}
  .lensdrop:hover{color:var(--seal);border-color:var(--seal)}
  .lensmenu{position:fixed;z-index:96;min-width:210px;max-height:300px;overflow:auto;background:var(--paper);border:1px solid var(--line-strong);border-radius:var(--r-md);box-shadow:var(--shadow-pop);padding:4px}
  .lensmenu[hidden]{display:none}
  .lensmenu .mi{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 10px;border-radius:var(--r-sm);cursor:pointer;font-size:13px;color:var(--ink)}
  .lensmenu .mi:hover{background:var(--panel-hover)}
  .lensmenu .mi.added{color:var(--muted)}
  .lensmenu .mi .tick{color:var(--seal);font-size:12px}
  .lensmenu .mhd{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);padding:6px 10px 3px}
  .rolenote{background:var(--amber-soft);color:var(--amber);border-radius:8px;padding:7px 11px;font-size:12.5px;margin:8px 0;display:flex;align-items:center;gap:8px}
  .rolenote b{font-weight:600}
  .rolenote .copycmd{white-space:nowrap;flex-shrink:0}
  .rolenote .copycmd code{background:rgba(0,0,0,.18);padding:0 4px;border-radius:3px}
  .rolenote{flex-wrap:wrap}
  .rolenote .pastecmd{font-family:var(--mono,ui-monospace,SFMono-Regular,Menlo,monospace);background:rgba(0,0,0,.22);color:var(--ink,#fff);padding:2px 7px;border-radius:5px;font-size:12px;white-space:nowrap}
  .rolenote .sk-spin{width:13px;height:13px;border:2px solid color-mix(in srgb,var(--amber) 30%,transparent);border-top-color:var(--amber);border-radius:50%;animation:sk-spin .7s linear infinite;flex-shrink:0}
  /* skeleton */
  .summary .prep-tag{display:inline-flex;align-items:center;gap:8px;font-size:18px;line-height:1.55;color:var(--ink);margin:16px 0 0;font-weight:400}
  .summary .prep-tag .sk-spin{width:14px;height:14px;border:2px solid var(--line-strong);border-top-color:var(--muted);border-radius:50%;animation:sk-spin .7s linear infinite;flex-shrink:0}
  @keyframes sk-spin{to{transform:rotate(360deg)}}
  .sk-summary{margin-top:20px;display:flex;flex-direction:column;gap:10px}
  .sk-summary .sk-line,.sk-summary .sk-h{border-radius:var(--r-sm);background:linear-gradient(90deg,var(--fill) 25%,var(--fill-strong) 37%,var(--fill) 63%);background-size:400% 100%;animation:sk-shimmer 1.4s ease infinite}
  .sk-summary .sk-line{height:13px}
  .sk-summary .sk-h{height:15px;width:34%;margin-top:10px}
  .sk-summary .sk-w80{width:80%}.sk-summary .sk-w60{width:60%}
  @keyframes sk-shimmer{0%{background-position:100% 0}100%{background-position:0 0}}
  @media (prefers-reduced-motion:reduce){
    .rolenote .sk-spin,.summary .prep-tag .sk-spin{animation:none}
    .sk-summary .sk-line,.sk-summary .sk-h{animation:none;background:var(--fill)}
  }
  /* rail seg + panes */
  .railseg{display:inline-flex;background:var(--fill);border:1px solid var(--line);border-radius:var(--r-md);padding:3px;width:100%;margin-bottom:12px}
  .railseg button{flex:1;border:0;background:transparent;padding:8px;border-radius:var(--r-md);font-size:13px;color:var(--ink-soft);cursor:pointer;font-weight:500;display:flex;align-items:center;justify-content:center;gap:6px}
  .railseg button.on{background:var(--thumb);color:var(--ink);box-shadow:var(--shadow-soft);font-weight:500}
  .railseg .cnt{font-size:10px;font-weight:600;background:var(--muted);color:var(--paper);border-radius:var(--r-sm);padding:0 6px;min-width:16px;text-align:center}
  .railseg button.on .cnt{background:var(--ink)}
  .railseg button.on .cnt.muted{background:var(--muted)}
  .railpane{display:none}
  .railpane.on{display:block}
  .brief{background:var(--paper);border:1px solid var(--card-border);border-radius:var(--r-lg);padding:16px;margin-bottom:12px;box-shadow:var(--shadow-card)}
  .brief .bh{margin-bottom:16px}
  .brief .k{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px}
  .brief .t{font-size:14px;font-weight:500;color:var(--ink);margin-bottom:4px}
  .brief .s{font-size:11px;color:var(--muted)}
  .brief .bbody{font-size:13px;color:var(--ink-soft);line-height:1.55}
  .brieffoot{font-size:11px;color:var(--muted);padding:0 16px 12px;text-align:center}
  .ask{display:flex;flex-direction:column;background:var(--paper);border:1px solid var(--card-border);border-radius:var(--r-lg);min-height:300px;overflow:hidden;box-shadow:var(--shadow-card)}
  .ask .ah{padding:16px;border-bottom:1px solid var(--line)}
  .ask .ah .k{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:4px}
  .ask .ah .s{font-size:11px;color:var(--muted)}
  .askgate{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px 16px;text-align:center}
  .askgate .ag-head{font-size:14px;font-weight:600;color:var(--ink);margin-bottom:6px}
  .askgate .ag-sub{font-size:12px;color:var(--muted);line-height:1.5;max-width:240px}
  .cmt-compose{margin-bottom:12px}
  .cmt-quote{display:flex;align-items:flex-start;gap:6px;background:var(--panel);border-left:2px solid var(--seal);padding:8px 12px;margin-bottom:8px;border-radius:var(--r-sm);font-size:12px;color:var(--ink-soft)}
  .cmt-quote[hidden]{display:none}
  .cmt-quote .cq-text{flex:1;min-width:0}
  .cmt-quote .cq-x{border:0;background:none;color:var(--muted);cursor:pointer;font-size:15px;line-height:1}
  #cmtInput{width:100%;border:1px solid var(--line);border-radius:8px;padding:8px 12px;font-size:13px;font-family:inherit;resize:vertical;min-height:60px;outline:none;color:var(--ink);background:var(--input-fill)}
  #cmtInput:focus{border-color:var(--seal);box-shadow:0 0 0 2px var(--seal-soft)}
  #cmtAuthor{width:100%;border:1px solid var(--line);border-radius:8px;padding:7px 12px;font-size:12.5px;font-family:inherit;outline:none;color:var(--ink);background:var(--input-fill);margin-top:8px}
  #cmtAuthor:focus{border-color:var(--seal)}
  .cmt-compose-row{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:8px;font-size:12px}
  .cmt-hint{color:var(--muted);flex:1}
  .cmt-out{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-sm);padding:9px 11px;font-family:var(--font-mono);font-size:11px;color:var(--ink-soft);white-space:pre-wrap;word-break:break-all;margin-top:8px;display:none}
  .cmt-filter{display:flex;gap:6px;margin-bottom:12px}
  /* cards */
  .cards{display:flex;flex-direction:column;gap:12px}
  .sg-sec{margin-bottom:12px;display:flex;flex-direction:column;gap:12px}
  .rail-empty{font-size:13px;color:var(--muted);padding:16px;text-align:center;line-height:1.5}
  .card{background:var(--paper);border:1px solid var(--card-border);border-radius:var(--r-lg);box-shadow:var(--shadow-card);padding:12px;cursor:pointer;transition:box-shadow var(--t-fast) var(--ease),border-color var(--t-fast) var(--ease);position:relative}
  .card.focus,.card.cur{border-color:var(--violet);box-shadow:0 0 0 2px var(--violet-soft),var(--shadow-card)}
  .card.disposed{opacity:.6}
  .card .chead{display:flex;align-items:center;gap:8px;margin-bottom:8px}
  .card .av{width:26px;height:26px;border-radius:50%;background:var(--ink-soft);color:var(--paper);font-size:10px;font-weight:500;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .card .av.agent{background:var(--violet)}.card .av.pm{background:var(--ok)}
  .card .who-name{font-size:13px;font-weight:600;color:var(--ink)}
  .card .who-sub{font-size:11px;color:var(--muted)}
  .card .ctype{margin-left:auto;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;padding:2px 8px;border-radius:var(--r-sm);background:var(--panel);color:var(--muted)}
  .card .ctype.suggest{background:var(--seal-soft);color:var(--seal)}
  .card .quoted{font-size:11px;color:var(--muted);border-left:2px solid var(--line);padding:2px 0 2px 8px;margin:4px 0 8px;line-height:1.4;max-height:48px;overflow:hidden}
  .card .ctext{font-size:13px;color:var(--ink-soft);line-height:1.55}
  .card .body{font-size:13px;color:var(--ink-soft);line-height:1.5}
  .thread{margin-top:8px;display:flex;flex-direction:column;gap:8px}
  .reply{display:flex;gap:8px}
  .reply .rav{width:22px;height:22px;border-radius:50%;background:var(--muted);color:var(--paper);font-size:9px;font-weight:500;display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .reply .rb{font-size:13px;color:var(--ink-soft);line-height:1.45}
  .reply .rb .rn{font-weight:600;color:var(--ink);font-size:12px;margin-bottom:1px}
  /* suggestion card */
  .card.sg{border-left:3px solid var(--violet)}
  .card.sg.disposed{opacity:.72}
  .sg-badge{font-size:10.5px;font-weight:700;border-radius:999px;padding:1px 7px;margin-left:auto}
  .sg-badge.open{background:var(--violet-soft);color:var(--violet)}
  .sg-badge.no{background:#fbeae6;color:#c1432e}
  .sg-q{font-size:12px;color:var(--muted);text-decoration:line-through;border-left:2px solid var(--line);padding-left:8px;margin:6px 0 3px}
  .sg-prop{font-size:14px;color:var(--ink);background:var(--violet-soft);border-radius:7px;padding:7px 10px}
  .sg-arrow{color:var(--violet);font-weight:700;margin-right:4px}
  .sg-disp{font-size:12.5px;color:var(--ink-soft);margin-top:6px}
  /* full-doc Google-Docs margin notes */
  body.view-full #paneComments .cmt-compose,body.view-full #paneComments #railEmpty{display:none}
  body.view-full #paneComments .sg-sec{position:relative;z-index:7;margin-bottom:10px}
  body.view-full #cards{position:relative;padding:6px 0}
  body.view-full #cards>.card[data-anchor]{position:absolute;left:0;right:0;margin:0;box-shadow:var(--shadow-card);transition:top .16s ease,box-shadow var(--t-fast) ease}
  body.view-full #cards>.card.cur{z-index:6;box-shadow:0 0 0 2px var(--seal),var(--shadow-pop)}
  .card.flash{animation:cardflash 1s ease}
  @keyframes cardflash{0%,100%{box-shadow:var(--shadow-card)}25%{box-shadow:0 0 0 2px var(--seal)}}
  /* footer / jump / toast / composer */
  .footbanner{position:fixed;left:0;right:0;bottom:0;background:var(--panel-2);border-top:1px solid var(--line);box-shadow:var(--shadow-card);z-index:40;padding:10px 16px;display:flex;align-items:center;gap:10px;font-size:12px;color:var(--ink-soft)}
  .footbanner .fb-ic{display:inline-flex;color:var(--muted)}
  .footbanner b{color:var(--ink);font-weight:600}
  .footbanner code{font-family:var(--font-mono);font-size:11px;background:var(--panel);padding:1px 5px;border-radius:var(--r-sm)}
  .footbanner .fb-pill{margin-left:auto;background:var(--panel);color:var(--muted);border:1px solid var(--line);border-radius:var(--r-sm);padding:3px 10px;font-size:11px;font-weight:500;white-space:nowrap}
  .railjump{position:fixed;right:16px;bottom:64px;z-index:81;display:none;align-items:center;gap:7px;background:var(--ink);color:var(--paper);padding:8px 12px;border-radius:var(--r-pill);font-size:12px;font-weight:600;text-decoration:none;box-shadow:var(--shadow-pop);cursor:pointer}
  .railjump:hover{background:var(--ink-press)}
  .railjump .rj-count{background:var(--paper);color:var(--ink);border-radius:999px;font-size:11px;font-weight:600;min-width:18px;height:18px;display:inline-flex;align-items:center;justify-content:center;padding:0 5px}
  .toast{position:fixed;bottom:64px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--toast-bg);color:var(--toast-ink);padding:12px 16px;border-radius:var(--r-lg);font-size:13px;font-weight:500;box-shadow:var(--shadow-pop);z-index:90;opacity:0;pointer-events:none;border:1px solid var(--card-border);transition:opacity var(--t-slow) var(--ease),transform var(--t-slow) var(--ease);display:flex;align-items:center;gap:9px;max-width:90%}
  .toast.on{opacity:1;transform:translateX(-50%) translateY(0)}
  .toast .ts{width:24px;height:24px;border-radius:50%;background:var(--ok);display:flex;align-items:center;justify-content:center;flex-shrink:0}
  .toast .ts .icon{width:14px;height:14px;color:#fff}
  .selcompose{position:fixed;z-index:85;width:300px;max-width:calc(100vw - 24px);background:var(--paper);border:1px solid var(--line-strong);border-radius:var(--r-md);box-shadow:var(--shadow-pop);padding:10px;animation:pop var(--t-fast) var(--ease)}
  .selcompose[hidden]{display:none}
  .sc-modetabs{display:inline-flex;background:var(--fill);border:1px solid var(--line);border-radius:var(--r-md);padding:2px;margin-bottom:8px}
  .sc-modetabs button{border:0;background:transparent;padding:4px 11px;border-radius:var(--r-sm);font-size:12px;cursor:pointer;color:var(--ink-soft);font-family:inherit;font-weight:500}
  .sc-modetabs button.on{background:var(--thumb);color:var(--ink);box-shadow:var(--shadow-soft)}
  .sc-quote{font-size:11.5px;font-style:italic;color:var(--muted);border-left:2px solid var(--seal);padding:2px 0 2px 8px;margin-bottom:7px;max-height:42px;overflow:hidden;line-height:1.4}
  .selcompose textarea,.selcompose input{width:100%;border:1px solid var(--line);border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;resize:vertical;outline:none;color:var(--ink);background:var(--input-fill);margin-bottom:7px}
  .selcompose textarea{min-height:46px}
  /* @-mention picker + will-notify chips */
  .mentionmenu{position:fixed;z-index:95;min-width:180px;max-width:260px;background:var(--paper);border:1px solid var(--line-strong);border-radius:var(--r-md);box-shadow:var(--shadow-pop);padding:4px;max-height:220px;overflow:auto}
  .mentionmenu[hidden]{display:none}
  .mentionmenu .mi{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:var(--r-sm);cursor:pointer;font-size:13px}
  .mentionmenu .mi.sel,.mentionmenu .mi:hover{background:var(--panel-hover)}
  .mentionmenu .mav{width:20px;height:20px;border-radius:50%;background:var(--seal);color:#fff;font-size:9px;font-weight:600;display:flex;align-items:center;justify-content:center}
  .mentionmenu .mh{color:var(--muted);font-size:11px}
  .willnotify{display:flex;flex-wrap:wrap;gap:4px;margin:2px 0 7px;font-size:11px;color:var(--muted);align-items:center}
  .willnotify .nchip{background:var(--seal-soft);color:var(--seal-ink);border:1px solid var(--seal-line);border-radius:var(--r-pill);padding:1px 8px;font-weight:600}
  /* owner actions */
  .owneract{display:none}
  body.can-edit .owneract{display:inline-flex}
  .cactions{gap:6px;margin-top:9px}
  body.can-edit .cactions{display:flex}
  .cacc{font-size:11px;color:var(--ins);margin-top:8px;font-weight:600}
  .editbar{position:fixed;left:0;right:0;bottom:0;z-index:110;display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--panel-2);border-top:1px solid var(--line-strong);box-shadow:var(--shadow-pop)}
  .editbar[hidden]{display:none}
  .editbar .ebnote{font-size:12.5px;color:var(--muted)}
  .docmd.editing{outline:2px solid var(--seal);outline-offset:2px;background:#0d1018;cursor:text;min-height:50vh}
  .sc-email{width:100%;border:1px solid var(--line);border-radius:8px;padding:7px 10px;font:inherit;font-size:13px;outline:none;color:var(--ink);background:var(--input-fill);margin-bottom:7px}
  .sc-email:focus{border-color:var(--seal);box-shadow:0 0 0 2px var(--seal-soft)}
  .sc-email.autofilled{border-color:var(--seal-line);background:var(--seal-soft)}
  /* share dialog: send kit */
  .sharebtns{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;align-items:center}
  #bundleRow .filepath{margin:8px 0 6px}
  .sharefiles{list-style:none;margin:6px 0 10px;padding:0;display:flex;flex-direction:column;gap:5px}
  .sharefiles li{display:flex;align-items:baseline;gap:8px;font-size:12.5px}
  .sharefiles code{background:var(--input-fill,rgba(0,0,0,.06));border:1px solid var(--line);border-radius:5px;padding:1px 6px;color:var(--ink);white-space:nowrap}
  .sharefiles .fnote{color:var(--muted);font-size:11.5px}
  .copyblock{margin:8px 0;border:1px solid var(--line);border-radius:var(--r-md);overflow:hidden;background:var(--panel)}
  .copyblock .cbhd{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 9px;font-size:11.5px;font-weight:600;color:var(--ink-soft);background:var(--fill);border-bottom:1px solid var(--line)}
  .copyblock textarea.copytext{width:100%;box-sizing:border-box;border:0;outline:none;resize:vertical;padding:9px 10px;font:inherit;font-size:12px;line-height:1.5;color:var(--ink);background:transparent;white-space:pre-wrap}
  /* share dialog channels (legacy, unused) */
  .sharechans{display:flex;flex-direction:column;gap:7px;margin:4px 0 10px}
  .chanopt{display:flex;align-items:center;gap:9px;border:1px solid var(--line);border-radius:var(--r-md);padding:9px 11px;cursor:pointer;font-size:13px}
  .chanopt:hover{background:var(--panel-hover)}
  .chanopt.on{border-color:var(--seal);background:var(--seal-soft)}
  .chanopt input{accent-color:var(--seal);width:15px;height:15px}
  .chanopt .ci{font-size:15px}
  .sharerecip{width:100%;border:1px solid var(--line-strong);border-radius:8px;padding:8px 10px;font:inherit;font-size:13px;outline:none;color:var(--ink);background:var(--input-fill);margin-bottom:10px}
  .nomcp{font-size:12.5px;color:var(--muted);background:var(--panel);border:1px dashed var(--line-strong);border-radius:var(--r-md);padding:9px 11px;margin-bottom:10px;line-height:1.5}
  .sharedlg{position:fixed;inset:0;z-index:120;background:rgba(16,16,26,.4);display:flex;align-items:center;justify-content:center}
  .sharedlg[hidden]{display:none}
  .sharecard{background:var(--paper);border:1px solid var(--line-strong);border-radius:var(--r-lg);box-shadow:var(--shadow-pop);padding:18px 20px;width:440px;max-width:calc(100vw - 32px)}
  .sharehd{display:flex;align-items:center;justify-content:space-between;font-weight:600;font-size:15px;margin-bottom:10px}
  .sharecard .opt{border:1px solid var(--line);border-radius:var(--r-md);padding:11px 13px;margin-bottom:9px}
  .sharecard .opt b{font-size:13px}.sharecard .opt p{margin:3px 0 0;font-size:12.5px;color:var(--muted);line-height:1.5}
  .sharecard .opt code{font-size:11.5px;background:var(--panel);padding:1px 5px;border-radius:4px;word-break:break-all}
  .sharecard .opt .btn{margin-top:8px}
  .sharecard .opt .filepath{margin:6px 0 0}.sharecard .opt .filepath code{display:block;padding:5px 7px;word-break:break-all}
  .sharecard .opt .filebtns{display:flex;gap:6px;flex-wrap:wrap}
  .selcompose textarea:focus,.selcompose input:focus{border-color:var(--seal);box-shadow:0 0 0 2px var(--seal-soft)}
  .sc-out{background:var(--panel);border:1px solid var(--line);border-radius:var(--r-sm);padding:8px 10px;font-family:var(--font-mono);font-size:11px;color:var(--ink-soft);white-space:pre-wrap;word-break:break-all;margin-bottom:7px;display:none}
  .sc-row{display:flex;justify-content:flex-end;gap:7px;margin-top:4px;align-items:center}
  .sc-hint{font-size:11px;color:var(--muted);flex:1;line-height:1.35}
  #selbtn{position:absolute;display:none;z-index:84;gap:4px}
  #selbtn button{border:1px solid var(--line-strong);background:var(--paper);color:var(--ink);border-radius:var(--r-md);padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;box-shadow:var(--shadow-pop);font-family:inherit}
  #selbtn button:hover{background:var(--panel-hover)}
  .btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--line-strong);background:var(--fill);color:var(--ink-soft);border-radius:var(--r-md);padding:7px 13px;font-size:13px;font-weight:600;cursor:pointer;font-family:inherit}
  .btn.primary{background:var(--seal);color:var(--on-accent);border-color:var(--seal)}
  .btn.primary:hover{background:var(--seal-press)}
  .btn.ghost{background:var(--fill);color:var(--ink-soft)}
  .btn.tiny{padding:5px 10px;font-size:12px}
  .autocommit{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;color:var(--ink-soft);border:1px solid var(--line-strong);background:var(--fill);border-radius:var(--r-md);padding:6px 10px;cursor:pointer;user-select:none}
  .autocommit input{accent-color:var(--seal);margin:0}
  @keyframes pop{from{transform:translateY(5px) scale(.99);opacity:0}to{transform:none;opacity:1}}
  /* responsive */
  @media (max-width:1100px){
    .canvas-area{flex-direction:column;align-items:center;gap:24px;padding:24px 16px 150px}
    .pagecol{width:100%;max-width:760px}
    .rail{width:100%;max-width:760px}
    .railjump{display:inline-flex}
    body.view-full #cards>.card[data-anchor]{position:relative;left:auto;right:auto;top:auto !important}
  }
  @media (max-width:1024px){.doctitle{max-width:200px}}
  @media (max-width:640px){
    .page{padding:32px 22px;min-height:0}
    .summary{padding:22px}
    .railseg button{min-height:40px}
    header.top .row{gap:8px;padding:8px 12px}
    .doctitle{max-width:120px}
    .readprompt{flex-basis:100%;order:5;gap:10px}
    .canvas-area{padding:16px 8px 150px;gap:16px}
  }
</style></head>
<body class="mode-view view-summary">
<div class="chrome" id="chrome">
  <header class="top">
    <div class="row">
      <a class="logo" href="#" title="Seal"><span class="seal-mark">${SEAL_SVG}</span> Seal</a>
      <div class="titlewrap">
        <div class="doctitle" id="docTitle" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
        <span class="docver" id="sealHandle" title="Document version">${verChip}</span>
      </div>
      <div class="readprompt">
        <span id="liveTag" title="Sealed by content hash">sealed wording</span>
        <span class="badge ${badge.cls}">${badge.label}</span>
      </div>
      <span class="spacer"></span>
      <button class="ghost owneract" id="editBtn" title="Edit the document (writes doc.md)">✎ Edit</button>
      ${(!gitRemote && canCommit) ? `<button class="ghost" id="needRemote" title="This repo has no remote — add one (or paste a repo) to share">↗ Add a repo to share</button>` : ''}
      <button class="ghost" id="shareBtn" title="Share this review">↗ Share</button>
      <button class="ghost" id="themeBtn" title="Toggle theme">◐</button>
      <span class="src" title="zero network calls">🔒 offline</span>
    </div>
    <div class="substrip">
      ${srcChip}
      <span style="margin-left:2px">${escapeHtml(defaultLabel)} view</span>
    </div>
  </header>
  <div class="modebanner" id="modeBanner">
    <div class="seg" id="viewSeg">
      <button data-view="summary" class="on">Summary</button>
      <button data-view="full">Full doc</button>
      <button data-view="md">Markdown</button>
    </div>
    <span class="mb-desc" id="modeBannerDesc">— read-only review.</span>
  </div>
</div>

<div class="workspace" id="workspace">
  <div class="canvas-area">
    <div class="pagecol">
      <section class="summary" id="docSummary">${summaryHtml}</section>
      <article class="page" id="page">${fullHtml}</article>
      <pre class="docmd" id="docMd">${escapeHtml(mdRaw)}</pre>
    </div>
    <aside class="rail">
      <div class="railseg" id="railSeg">
        <button data-pane="brief" class="on">Change Brief</button>
        <button data-pane="comments">Comments <span class="cnt muted" id="cmtCnt"${totalCount ? '' : ' style="display:none"'}>${totalCount}</span></button>
        <button data-pane="ask">Ask</button>
      </div>

      <div class="railpane on" id="paneBrief">
        <div class="brief" id="brief">
          <div class="bh"><div class="k">Change Brief</div>
            <div class="t">What this document asks you to approve</div>
            <div class="s">Tailored to your role.</div></div>
          <div class="bbody">Open <b>Summary</b> for the role-tailored digest, or <b>Full doc</b> to read every section. ${approvalsPanel(review) ? 'Approval state is shown below.' : 'This document has not been submitted for sign-off yet.'}</div>
        </div>
        ${approvalsPanel(review)}
        <div class="brieffoot">Rendered 100% locally · zero network calls.</div>
      </div>

      <div class="railpane" id="paneComments">
        <div class="cmt-compose">
          <div class="cmt-quote" id="cmtQuote" hidden><span class="cq-text" id="cmtQuoteText"></span>
            <button class="cq-x" id="cmtQuoteClear" type="button" aria-label="Remove pin">&times;</button></div>
          <textarea id="cmtInput" placeholder="Add a comment on this document… (type @ to tag)" rows="2"></textarea>
          <input id="cmtAuthor" placeholder="Your name">
          <input id="cmtEmail" class="sc-email" type="text" placeholder="Notify by email — auto-fills when you @tag">
          <div class="cmt-compose-row">
            <span class="spacer"></span>
            <button class="btn ghost tiny" id="cmtCancel" type="button">Cancel</button>
            <button class="btn primary tiny" id="cmtPost" type="button">Save</button>
          </div>
          <pre class="cmt-out" id="cmtOut"></pre>
        </div>
        ${suggestionsHtml}
        <div class="cards" id="cards">${cardsHtml}</div>
        ${unanchoredNote}
        ${railEmpty}
      </div>

      <div class="railpane" id="paneAsk">
        <div class="ask"><div class="ah"><div class="k">Ask</div><div class="s">Grounded in this document.</div></div>
          <div class="askgate" id="askGate">
            <div class="ag-head">Ask is a hosted feature</div>
            <div class="ag-sub">Grounded Q&amp;A runs on sealmd.net. This offline render is read-only.</div>
          </div></div>
      </div>
    </aside>
  </div>
</div>

<a class="railjump" id="railJump" href="#railSeg">Brief &amp; comments${totalCount ? `<span class="rj-count">${totalCount}</span>` : ''}</a>

<div class="footbanner" id="footBanner">
  <span class="fb-ic">🔒</span>
  <span>Rendered 100% locally${renderedAt ? ` · ${escapeHtml(renderedAt)}` : ''} · content hash <code>${escapeHtml(contentHash.slice(0, 8))}…${escapeHtml(contentHash.slice(-3))}</code></span>
  <span class="fb-pill">offline · tamper-evident</span>
</div>

<div class="toast" id="toast"></div>

<div id="selbtn"><button data-act="comment">💬 Comment</button><button data-act="suggest">✎ Suggest</button></div>
<div class="selcompose" id="selCompose" hidden>
  <div class="sc-modetabs" id="scModeTabs"><button data-mode="comment" class="on">Comment</button><button data-mode="suggest">Suggest</button></div>
  <div class="sc-quote" id="scQuote"></div>
  <input id="scSuggest" placeholder="Proposed replacement text" style="display:none">
  <textarea id="scInput" placeholder="Add comment… (type @ to tag)"></textarea>
  <input id="scEmail" class="sc-email" type="text" placeholder="Notify by email — auto-fills when you @tag">
  <pre class="sc-out" id="scOut"></pre>
  <div class="sc-row">
    <span class="spacer"></span>
    <button class="btn ghost tiny" id="scCancel">Cancel</button>
    <button class="btn primary tiny" id="scPost">Comment</button>
  </div>
</div>
<div class="editbar" id="editBar" hidden><span class="ebnote">Editing Markdown — <b>Save</b> writes <code>doc.md</code> (content hash changes, approvals re-open)</span><span class="spacer"></span><button class="btn ghost tiny" id="editCancel">Cancel</button><button class="btn primary tiny" id="editSave">Save to doc.md</button></div>
<div class="mentionmenu" id="mentionMenu" hidden></div>
<div class="sharedlg" id="shareDlg" hidden>
  <div class="sharecard">
    <div class="sharehd">↗ Share this review <button class="btn ghost tiny" id="shareClose">×</button></div>
    <div id="shareBody"></div>
  </div>
</div>

<script>
const SEAL = ${SEAL_JS_DATA};
const root=document.documentElement, tk='seal-theme';
try{const s=localStorage.getItem(tk); if(s) root.setAttribute('data-theme',s);}catch(e){}
document.getElementById('themeBtn').onclick=()=>{const n=root.getAttribute('data-theme')==='dark'?'light':'dark';root.setAttribute('data-theme',n);try{localStorage.setItem(tk,n)}catch(e){}};

var body=document.body, page=document.getElementById('page'),
    cardsEl=document.getElementById('cards'), workspace=document.getElementById('workspace');

// ---- view toggle (persist so post-save reload doesn't jump to Summary) ----
function setView(v){
  document.querySelectorAll('#viewSeg button').forEach(x=>x.classList.toggle('on',x.dataset.view===v));
  body.classList.remove('view-summary','view-full','view-md');body.classList.add('view-'+v);
  try{sessionStorage.setItem('seal-view',v)}catch(e){}
  if(v==='full'){highlightAnchors();scheduleAlign();}
}
document.getElementById('viewSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(b)setView(b.dataset.view);});

// ---- rail pane toggle ----
function setPane(name){
  document.querySelectorAll('#railSeg button').forEach(b=>b.classList.toggle('on',b.dataset.pane===name));
  document.querySelectorAll('.railpane').forEach(p=>p.classList.toggle('on',p.id==='pane'+name[0].toUpperCase()+name.slice(1)));
  if(name==='comments')scheduleAlign();
}
document.getElementById('railSeg').addEventListener('click',e=>{const b=e.target.closest('button');if(b)setPane(b.dataset.pane);});

// ---- role switcher ----
function slugifyRole(s){return String(s==null?'':s).toLowerCase().trim().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'').slice(0,64);}
function nearestRole(input){
  const want=slugifyRole(input); const keys=Object.keys(SEAL.summaries);
  if(SEAL.summaries[want]) return {hit:want,exact:true};
  let best=null,score=0;
  for(const k of keys){const a=k.split('_'),b=want.split('_');const ov=a.filter(x=>b.includes(x)).length;if(ov>score){score=ov;best=k;}}
  return {hit:best||keys[0],exact:false};
}
function labelFor(slug){return SEAL.labels[slug]||slug.replace(/_/g,' ').replace(/\\b\\w/g,c=>c.toUpperCase());}
function clearAfterPills(){
  const host=document.getElementById('docSummary');const pills=host.querySelector('.lenspills');
  let n=pills.nextSibling;while(n){const x=n;n=n.nextSibling;x.remove();}
  return {host,pills};
}
function setStag(label){const b=document.querySelector('#docSummary .stag b');if(b)b.textContent=label;}
function setLensValue(label){const i=document.getElementById('roleInput');if(i)i.value=label+' summary';}
function escapeAttr(s){return escapeText(s).replace(/"/g,'&quot;');}
// ---- sticky, user-editable role pills (persisted per doc) ----
const PILLS_KEY='seal-pills3:'+(SEAL.docPath||'');
function defaultPills(){const out=[],seen=new Set();
  // ONLY roles that actually have a generated summary, plus General. We do NOT
  // seed the full role taxonomy — typing a new role hands you a paste command
  // (it doesn't auto-generate a pill). Users still prune with ×.
  ['general',SEAL.defaultSlug].concat(Object.keys(SEAL.summaries))
    .forEach(x=>{if(x&&!seen.has(x)){seen.add(x);out.push(x);}});return out;}
function loadPills(){try{const v=JSON.parse(localStorage.getItem(PILLS_KEY));if(Array.isArray(v)&&v.length)return v;}catch(e){}return defaultPills();}
let pillSlugs=loadPills();
function savePills(){try{localStorage.setItem(PILLS_KEY,JSON.stringify(pillSlugs))}catch(e){}}
function ensurePill(slug){if(slug&&!pillSlugs.includes(slug)){pillSlugs.push(slug);savePills();}}
function renderPills(active){
  const host=document.getElementById('lensPills');if(!host)return;
  host.innerHTML=pillSlugs.map(slug=>{const label=labelFor(slug);const rm=slug!=='general';
    return '<button type="button" class="lenspill'+(slug===active?' on':'')+'" data-role="'+slug+'" data-label="'+escapeAttr(label)+'">'+escapeText(label)+(rm?'<span class="pillx" data-remove="'+slug+'" title="Remove">×</span>':'')+'</button>';}).join('');
}
function activeSlug(){const a=document.querySelector('#docSummary .lenspill.on');return a?a.dataset.role:null;}
function removePill(slug){const wasActive=activeSlug()===slug;pillSlugs=pillSlugs.filter(s=>s!==slug);savePills();
  if(wasActive)applyRole(pillSlugs.includes('general')?'general':(pillSlugs[0]||'general'));else renderPills(activeSlug());}
function applyRole(slug){
  const {pills}=clearAfterPills();
  const wrap=document.createElement('div');wrap.id='sumReady';wrap.innerHTML=SEAL.summaries[slug]||'';
  pills.parentNode.appendChild(wrap);
  ensurePill(slug);renderPills(slug);setStag(labelFor(slug));setLensValue(labelFor(slug));
  try{sessionStorage.setItem('seal-role',slug)}catch(e){}
}
// ---- ▾ dropdown: browse the full taxonomy, add a role as a pill ----
const lensMenu=document.getElementById('lensMenu');
function renderMenu(){
  const tax=SEAL.taxonomy||[];
  lensMenu.innerHTML='<div class="mhd">Add a role</div>'+tax.map(t=>{const added=pillSlugs.includes(t.slug);
    return '<div class="mi'+(added?' added':'')+'" data-add="'+t.slug+'" data-label="'+escapeAttr(t.label)+'">'+escapeText(t.label)+(added?'<span class="tick">✓ added</span>':'')+'</div>';}).join('');
}
document.getElementById('lensMore').addEventListener('click',e=>{e.stopPropagation();
  if(lensMenu.hidden){renderMenu();const r=e.currentTarget.getBoundingClientRect();
    lensMenu.style.left=Math.max(8,Math.min(r.right-210,window.innerWidth-220))+'px';lensMenu.style.top=(r.bottom+4)+'px';lensMenu.hidden=false;}
  else lensMenu.hidden=true;});
document.addEventListener('click',e=>{if(!lensMenu.hidden&&!e.target.closest('#lensMenu')&&!e.target.closest('#lensMore'))lensMenu.hidden=true;});
lensMenu.addEventListener('click',e=>{const it=e.target.closest('.mi');if(!it)return;lensMenu.hidden=true;
  const slug=it.dataset.add,label=it.dataset.label;ensurePill(slug);
  if(SEAL.summaries[slug])applyRole(slug);else gotoRole(label);});
// No live generation, no spinner, no polling: hand the user the EXACT command to
// paste into their AI session. The tailored summary appears here after they run
// it and the page re-renders. Show the nearest baked summary meanwhile.
function showPasteCommand(label,near){
  const {pills}=clearAfterPills();
  const cmd='/seal-role "'+label+'"';
  const note=document.createElement('div');note.className='rolenote';
  note.innerHTML='<span>No <b>'+escapeText(label)+'</b> summary yet. Paste this into your AI session (Claude Code) to generate one — it shows up here after you run it. Meanwhile you\\'re seeing <b>'+escapeText(labelFor(near))+'</b>.</span>'+
    '<code class="pastecmd">'+escapeText(cmd)+'</code>'+
    '<button class="btn ghost tiny copycmd" data-copycmd="'+escapeAttr(cmd)+'">Copy</button>';
  pills.after(note);
  const wrap=document.createElement('div');wrap.id='sumReady';wrap.innerHTML=SEAL.summaries[near]||'';
  pills.parentNode.appendChild(wrap);
  setStag(label);setLensValue(label);
}
function escapeText(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

function gotoRole(raw){
  const label=raw.trim();if(!label)return;
  const {hit,exact}=nearestRole(label);
  if(exact){applyRole(hit);return;}
  // Unknown role: no auto-generation. Hand over the paste command (both serve
  // and static) and show the nearest baked summary meanwhile.
  showPasteCommand(label,hit);
}
document.getElementById('docSummary').addEventListener('submit',e=>{
  if(!e.target.closest('#lensForm'))return;e.preventDefault();
  const raw=document.getElementById('roleInput').value.replace(/\\s+summary$/i,'').trim();
  gotoRole(raw);
});
document.getElementById('docSummary').addEventListener('click',e=>{
  const rm=e.target.closest('.pillx');
  if(rm){e.stopPropagation();removePill(rm.dataset.remove);return;}
  const pill=e.target.closest('.lenspill');
  if(pill&&!pill.classList.contains('on')){
    const slug=pill.dataset.role, label=pill.dataset.label||labelFor(slug);
    if(SEAL.summaries[slug]) applyRole(slug);   // pre-generated -> instant
    else gotoRole(label);                        // taxonomy role -> generate (serve) / nearest (static)
    return;
  }
});
// initial pill render
renderPills(SEAL.defaultSlug);

// ---- bidirectional anchor <-> comment focus ----
function cleanQuote(s){return String(s||'').replace(/[*_\`]/g,'').replace(/\\s+/g,' ').trim();}
function anchorEl(anchor){if(!anchor||!page)return null;return page.querySelector('mark.cmt-hl[data-anchor="'+CSS.escape(anchor)+'"]');}
function wrapFirst(root,quote,anchor){
  var q=cleanQuote(quote);if(q.length<2)return null;
  var tries=[q,q.slice(0,48),q.slice(0,24)];
  var walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT,null),node;
  while((node=walker.nextNode())){
    if(node.parentNode&&node.parentNode.closest&&node.parentNode.closest('mark.cmt-hl,pre,code'))continue;
    var txt=node.nodeValue;if(!txt||txt.trim().length<1)continue;
    for(var t=0;t<tries.length;t++){var needle=tries[t];if(needle.length<2)continue;
      var idx=txt.indexOf(needle);if(idx<0)continue;
      try{var range=document.createRange();range.setStart(node,idx);range.setEnd(node,Math.min(idx+needle.length,txt.length));
        var mark=document.createElement('mark');mark.className='cmt-hl';if(anchor)mark.setAttribute('data-anchor',anchor);
        range.surroundContents(mark);return mark;}catch(_){return null;}}
  }
  return null;
}
function highlightAnchors(){
  if(!cardsEl||!page)return;
  cardsEl.querySelectorAll('.card[data-anchor]').forEach(function(c){
    if(c.getAttribute('data-hl')==='1')return;c.setAttribute('data-hl','1');
    var anchor=c.getAttribute('data-anchor');var quote=c.getAttribute('data-quote');
    if(anchor&&quote)wrapFirst(page,quote,anchor);
  });
}
function alignCards(){
  if(!cardsEl)return;
  var topCards=[];var k=cardsEl.children;
  for(var i=0;i<k.length;i++){if(k[i].classList&&k[i].classList.contains('card')&&k[i].getAttribute('data-anchor')&&k[i].offsetParent!==null)topCards.push(k[i]);}
  if(!body.classList.contains('view-full')){cardsEl.style.minHeight='';for(var z=0;z<k.length;z++)if(k[z].style)k[z].style.top='';return;}
  var base=cardsEl.getBoundingClientRect().top;
  var items=topCards.map(function(c){var a=c.getAttribute('data-anchor');var el=a?anchorEl(a):null;
    return {c:c,want:el?(el.getBoundingClientRect().top-base):-1};});
  items.sort(function(x,y){return (x.want<0?-1e9:x.want)-(y.want<0?-1e9:y.want);});
  var cursor=0;
  for(var n=0;n<items.length;n++){var t=Math.max(items[n].want<0?0:items[n].want,cursor);
    items[n].c.style.top=t+'px';cursor=t+items[n].c.offsetHeight+10;}
  cardsEl.style.minHeight=Math.max(cursor,page?page.offsetHeight:0)+'px';
}
var relayTimer=null;function scheduleAlign(){clearTimeout(relayTimer);relayTimer=setTimeout(alignCards,60);}
function activate(anchor){
  if(!anchor)return;
  if(!body.classList.contains('view-full'))setView('full');
  setPane('comments');
  var el=anchorEl(anchor);
  var card=cardsEl&&cardsEl.querySelector('.card[data-anchor="'+CSS.escape(anchor)+'"]');
  (cardsEl?cardsEl.querySelectorAll('.card'):[]).forEach(c=>c.classList.remove('cur'));
  if(card)card.classList.add('cur');
  if(el){el.classList.add('active');setTimeout(()=>el.classList.remove('active'),1400);
    if(el.scrollIntoView)el.scrollIntoView({behavior:'smooth',block:'center'});}
  scheduleAlign();
}
if(page)page.addEventListener('click',function(e){var m=e.target.closest('mark.cmt-hl');if(m){activate(m.getAttribute('data-anchor'));}});
if(cardsEl)cardsEl.addEventListener('click',function(e){
  if(e.target.closest('button,input,textarea,a'))return;
  var card=e.target.closest('.card[data-anchor]');if(card)activate(card.getAttribute('data-anchor'));
});
var alignRaf=0;
function alignOnScroll(){if(alignRaf)return;alignRaf=requestAnimationFrame(function(){alignRaf=0;alignCards();});}
window.addEventListener('scroll',alignOnScroll);
window.addEventListener('resize',scheduleAlign);
window.addEventListener('load',function(){highlightAnchors();alignCards();});
setTimeout(function(){highlightAnchors();alignCards();},300);
setTimeout(alignCards,800);

// ---- selection composer (sealmd extra) ----
const selbtn=document.getElementById('selbtn'),sc=document.getElementById('selCompose'),
  scQuote=document.getElementById('scQuote'),scInput=document.getElementById('scInput'),
  scSuggest=document.getElementById('scSuggest'),scOut=document.getElementById('scOut'),
  scPost=document.getElementById('scPost');
let curQuote='',curMode='comment',cAuthor='';
try{cAuthor=localStorage.getItem('seal-author')||''}catch(e){}
const isServe=SEAL.mode==='serve';
scPost.textContent=isServe?'Save':'Copy for agent';
function shq(s){return '"'+String(s).replace(/"/g,'\\\\"')+'"';}
function inDoc(node){return page&&page.contains(node);}
document.addEventListener('mouseup',e=>{
  if(sc&&!sc.hidden)return;
  if(!body.classList.contains('view-full')){selbtn.style.display='none';return;}
  const s=window.getSelection();const t=s&&s.toString().trim();
  if(t&&t.length>1&&s.anchorNode&&inDoc(s.anchorNode)){
    const r=s.getRangeAt(0).getBoundingClientRect();
    selbtn.style.display='flex';selbtn.style.left=(window.scrollX+r.left)+'px';selbtn.style.top=(window.scrollY+r.bottom+6)+'px';curQuote=t;
  }else selbtn.style.display='none';
});
function placeCompose(){const m=Math.max(12,Math.min(window.innerWidth-312,window.innerWidth/2-150));sc.style.left=m+'px';sc.style.top=Math.min(window.innerHeight-260,120)+'px';}
function openComp(mode){
  curMode=mode;selbtn.style.display='none';sc.hidden=false;placeCompose();
  scQuote.textContent=curQuote||'(no text selected — document-level)';
  scSuggest.style.display=mode==='suggest'?'block':'none';
  document.querySelectorAll('#scModeTabs button').forEach(b=>b.classList.toggle('on',b.dataset.mode===mode));
  scPost.textContent=isServe?'Save':'Copy for agent';scOut.style.display='none';scInput.focus();
  if(mode==='suggest'&&!scSuggest.value)scSuggest.value=curQuote;
}
selbtn.addEventListener('click',e=>{const b=e.target.closest('button');if(b)openComp(b.dataset.act);});
document.getElementById('scModeTabs').addEventListener('click',e=>{const b=e.target.closest('button');if(b)openComp(b.dataset.mode);});
document.getElementById('scCancel').onclick=()=>{sc.hidden=true;};
function buildAgent(){const who=cAuthor||'me';const q=curQuote?(' on "'+curQuote.slice(0,80)+(curQuote.length>80?'…':'')+'"'):'';
  if(curMode==='suggest')return 'seal-review: suggest changing'+q+' → "'+scSuggest.value.trim()+'" — '+(scInput.value.trim()||'(no note)')+' (by '+who+')';
  return 'seal-review: comment'+q+' — "'+(scInput.value.trim()||'')+'" (by '+who+')';}
function buildCli(){const a=['comment','--in',shq(SEAL.docPath),'--author',shq(cAuthor||'me')];if(curQuote)a.push('--anchor',shq(curQuote));if(curMode==='suggest')a.push('--suggest',shq(scSuggest.value.trim()));a.push('--body',shq(scInput.value.trim()));return 'node '+shq(SEAL.enginePath)+' '+a.join(' ');}
const TOAST_CHECK=${JSON.stringify(ICONS.check)};
function toast(m,spin){const t=document.getElementById('toast');t.innerHTML=(spin?'<span class="sk-spin"></span>':'<span class="ts">'+TOAST_CHECK+'</span>')+'<span>'+escapeText(m)+'</span>';t.classList.add('on');setTimeout(()=>t.classList.remove('on'),1900);}
scPost.onclick=async()=>{
  try{localStorage.setItem('seal-author',cAuthor)}catch(e){}
  if(isServe){
    const scEmail=document.getElementById('scEmail');
    const payload={author:cAuthor||'me',body:scInput.value.trim(),anchor:curQuote||null,suggestion:curMode==='suggest'?scSuggest.value.trim():undefined,email:(scEmail&&scEmail.value.trim())||undefined};
    try{const res=await fetch('/api/comment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const j=await res.json();
      if(j.ok){toast('Comment saved');sc.hidden=true;scInput.value='';scSuggest.value='';
        try{sessionStorage.setItem('seal-scroll',window.scrollY)}catch(e){}setTimeout(()=>location.reload(),650);}
      else toast('Error: '+(j.error||'unknown'));}
    catch(e){toast('Server error: '+e.message);}
    return;
  }
  const txt=buildAgent();
  try{await navigator.clipboard.writeText(txt);toast('Copied — paste into your AI console');}
  catch(e){scOut.textContent=txt;scOut.style.display='block';toast('Copy failed — select below');}
};

// ---- rail comment compose (document-level, mirrors selection composer) ----
const cmtInput=document.getElementById('cmtInput'),cmtAuthor=document.getElementById('cmtAuthor'),
  cmtPost=document.getElementById('cmtPost'),cmtOut=document.getElementById('cmtOut'),cmtCancel=document.getElementById('cmtCancel');
try{if(cmtAuthor)cmtAuthor.value=localStorage.getItem('seal-author')||''}catch(e){}
if(cmtCancel)cmtCancel.onclick=()=>{cmtInput.value='';if(cmtOut)cmtOut.style.display='none';};
if(cmtPost){
  cmtPost.textContent=isServe?'Save':'Copy for agent';
  cmtPost.onclick=async()=>{
    const who=(cmtAuthor&&cmtAuthor.value.trim())||'me';
    try{localStorage.setItem('seal-author',who)}catch(e){}
    const bodyTxt=cmtInput.value.trim();if(!bodyTxt){cmtInput.focus();return;}
    if(isServe){
      const cmtEmail=document.getElementById('cmtEmail');
      try{const res=await fetch('/api/comment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({author:who,body:bodyTxt,anchor:null,email:(cmtEmail&&cmtEmail.value.trim())||undefined})});const j=await res.json();
        if(j.ok){toast('Comment saved');cmtInput.value='';try{sessionStorage.setItem('seal-scroll',window.scrollY);sessionStorage.setItem('seal-pane','comments')}catch(e){}setTimeout(()=>location.reload(),650);}
        else toast('Error: '+(j.error||'unknown'));}
      catch(e){toast('Server error: '+e.message);}
      return;
    }
    const txt='seal-review: comment — "'+bodyTxt+'" (by '+who+')';
    try{await navigator.clipboard.writeText(txt);toast('Copied — paste into your AI console');}
    catch(e){cmtOut.textContent=txt;cmtOut.style.display='block';toast('Copy failed — select below');}
  };
}

// ---- @-mention picker + will-notify chips ----
const PEOPLE=SEAL.people||[];
const mm=document.getElementById('mentionMenu');
let mmTarget=null, mmItems=[], mmSel=0, mmStart=-1;
function mmInitials(n){return String(n||'?').split(/\\s+/).map(w=>w[0]).join('').slice(0,2).toUpperCase();}
function closeMenu(){mm.hidden=true;mmTarget=null;mmItems=[];}
function openMenu(ta,frag,start){
  const q=frag.toLowerCase();
  mmItems=PEOPLE.filter(p=>p.name.toLowerCase().includes(q)||(p.handle||'').toLowerCase().includes(q)).slice(0,8);
  if(!mmItems.length){closeMenu();return;}
  mmTarget=ta;mmStart=start;mmSel=0;
  mm.innerHTML=mmItems.map((p,i)=>'<div class="mi'+(i===0?' sel':'')+'" data-i="'+i+'"><span class="mav">'+mmInitials(p.name)+'</span><span>'+escapeText(p.name)+'</span><span class="mh">@'+escapeText(p.handle||p.name)+'</span></div>').join('');
  const r=ta.getBoundingClientRect();mm.style.left=Math.min(r.left,window.innerWidth-270)+'px';mm.style.top=(r.bottom+4)+'px';mm.hidden=false;
}
function pickMention(i){
  if(!mmTarget||!mmItems[i])return;
  const p=mmItems[i], v=mmTarget.value, caret=mmTarget.selectionStart;
  mmTarget.value=v.slice(0,mmStart)+'@'+p.name+' '+v.slice(caret);
  const np=mmStart+p.name.length+2;mmTarget.setSelectionRange(np,np);
  closeMenu();mmTarget.focus();updateNotify(mmTarget);
}
mm.addEventListener('mousedown',e=>{const it=e.target.closest('.mi');if(it){e.preventDefault();pickMention(+it.dataset.i);}});
function onMentionKey(e){
  if(mm.hidden)return;
  if(e.key==='ArrowDown'){e.preventDefault();mmSel=(mmSel+1)%mmItems.length;}
  else if(e.key==='ArrowUp'){e.preventDefault();mmSel=(mmSel-1+mmItems.length)%mmItems.length;}
  else if(e.key==='Enter'||e.key==='Tab'){e.preventDefault();pickMention(mmSel);return;}
  else if(e.key==='Escape'){closeMenu();return;}
  else return;
  mm.querySelectorAll('.mi').forEach((el,i)=>el.classList.toggle('sel',i===mmSel));
}
function emailFieldFor(ta){
  // the email input is the sibling right after the textarea (sc) or after author (rail)
  if(ta.id==='scInput')return document.getElementById('scEmail');
  if(ta.id==='cmtInput')return document.getElementById('cmtEmail');
  return null;
}
function updateNotify(ta){
  const box=ta.parentNode.querySelector('.willnotify');
  const names=(ta.value.match(/@([a-z0-9._-]+)/gi)||[]).map(s=>s.slice(1).toLowerCase());
  const hit=PEOPLE.filter(p=>names.some(n=>p.name.toLowerCase()===n||(p.handle||'').toLowerCase()===n||p.name.toLowerCase().split(' ')[0]===n));
  if(box)box.innerHTML=hit.length?'will notify: '+hit.map(p=>'<span class="nchip">@'+escapeText(p.handle||p.name)+'</span>').join(''):'';
  // auto-fill the always-visible email field with the tagged people's emails
  const ef=emailFieldFor(ta);if(ef&&!ef.dataset.touched){
    const emails=[...new Set(hit.map(p=>p.email).filter(Boolean))];
    if(emails.length){ef.value=emails.join(', ');ef.classList.add('autofilled');}
    else{ef.value='';ef.classList.remove('autofilled');}
  }
}
function attachMentions(ta){
  if(!ta||!PEOPLE.length)return;
  const wn=document.createElement('div');wn.className='willnotify';ta.after(wn);
  ta.addEventListener('input',()=>{
    const c=ta.selectionStart,pre=ta.value.slice(0,c),m=pre.match(/@([a-z0-9._-]*)$/i);
    if(m)openMenu(ta,m[1],c-m[1].length-1);else closeMenu();
    updateNotify(ta);
  });
  ta.addEventListener('keydown',onMentionKey);
  ta.addEventListener('blur',()=>setTimeout(closeMenu,150));
  const ef=emailFieldFor(ta);
  if(ef)ef.addEventListener('input',()=>{ef.dataset.touched=ef.value.trim()?'1':'';if(!ef.value.trim())ef.classList.remove('autofilled');});
}
attachMentions(scInput);attachMentions(cmtInput);

// ---- Share (every supported path shown; no "how do you want to share?") ----
const shareDlg=document.getElementById('shareDlg');
document.getElementById('shareClose').onclick=()=>shareDlg.hidden=true;
shareDlg.addEventListener('click',e=>{if(e.target===shareDlg)shareDlg.hidden=true;});
function renderShare(){
  const b=document.getElementById('shareBody');
  let html='';
  // GitHub PR via local gh CLI — no MCP needed. Top of the dialog when available.
  if(isServe&&SEAL.canPR){
    html+='<div class="opt"><b>🐙 Commit &amp; open a Pull Request</b><p>Commits the review onto a branch and opens a GitHub PR via the local <code>gh</code> CLI — no integration to connect.</p><div id="prRow"><button class="btn primary tiny" id="prGo">Commit &amp; open PR</button></div></div>';
  }
  // Send to reviewers — bundle the files into one zip + one copyable message.
  // Direct-send buttons appear for whatever channels the launching agent declared
  // via --mcp (e.g. email, slack). The combined message is captured for copy.
  let combined='';
  if(isServe){
    const T=SEAL.title||SEAL.srcName||'this document';
    const fmd=SEAL.srcName||'doc.md';
    const fhtml=fmd.replace(/\\.md$/,'.review.html');
    const fseal=fmd.replace(/\\.md$/,'.seal.md');
    const zipName=fmd.replace(/\\.md$/,'.review-bundle.zip');
    combined='Please review "'+T+'".\\n\\nOpen '+fhtml+' — self-contained, opens offline, no install. Comment inline; your notes save into '+fseal+' and come straight back to me.\\n\\nAttach: '+fhtml+', '+fseal+', '+fmd+' (or just '+zipName+').';
    const mcp=SEAL.mcp||[];
    const chanBtns=
      (mcp.includes('email')?'<button class="btn ghost tiny" data-sendmcp="email">📧 Send via Email</button>':'')+
      (mcp.includes('slack')?'<button class="btn ghost tiny" data-sendmcp="slack">💬 Send via Slack</button>':'');
    html+='<div class="opt"><b>📤 Send to reviewers</b><p>Bundle the files into one zip, paste the message.</p>'+
      '<div class="sharebtns">'+chanBtns+
        '<button class="btn ghost tiny" id="bundleGo">⬇ Bundle (.zip)</button>'+
        '<button class="btn primary tiny" id="copyMsg">Copy message</button></div>'+
      '<div id="bundleRow"></div></div>';
  }else{
    html+='<div class="opt"><b>📄 Self-contained file</b><p>This page is already the file — send it yourself. Run <code>seal serve</code> for a live link where reviewers comment.</p></div>';
  }
  if(!isServe)html+='<div class="opt"><b>🔗 Live + writable</b><p>Run <code>seal serve</code> for a local link where reviewers comment.</p></div>';
  html+='<div class="opt"><b>🌐 Shared link + verified identity</b><p>A hosted link reviewers open from anywhere with sign-in — the <code>seal publish</code> step.</p></div>';
  b.innerHTML=html;
  const prGo=document.getElementById('prGo');
  if(prGo)prGo.onclick=async()=>{
    prGo.textContent='Opening PR…';prGo.disabled=true;
    try{const j=await(await fetch('/api/pr',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
      if(j.ok&&j.url){document.getElementById('prRow').innerHTML='<p>PR ready: <a href="'+j.url+'" target="_blank" rel="noopener">'+escapeText(j.url)+'</a>'+(j.push_error?' <span style="color:var(--muted)">(push warning: '+escapeText(j.push_error)+')</span>':'')+'</p><button class="btn ghost tiny" id="prCopy">Copy link</button>';
        const pc=document.getElementById('prCopy');if(pc)pc.onclick=()=>navigator.clipboard.writeText(j.url).then(()=>toast('PR link copied'));
        toast(j.created?'PR opened ✓':'PR updated ✓');}
      else{toast('Error: '+(j.error||'PR failed'));prGo.textContent='Commit & open PR';prGo.disabled=false;}}
    catch(e){toast('Error: '+e.message);prGo.textContent='Commit & open PR';prGo.disabled=false;}
  };
  // Copy ONE combined message (no visible text box). Works for email / Slack / DM.
  const copyMsg=document.getElementById('copyMsg');
  if(copyMsg)copyMsg.onclick=()=>{
    const done=()=>{const o=copyMsg.textContent;copyMsg.textContent='Copied ✓';setTimeout(()=>{copyMsg.textContent=o;},1400);toast('Message copied — paste into email / Slack');};
    if(navigator.clipboard){navigator.clipboard.writeText(combined).then(done).catch(()=>{const t=document.createElement('textarea');t.value=combined;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();done();});}
    else{const t=document.createElement('textarea');t.value=combined;document.body.appendChild(t);t.select();document.execCommand('copy');t.remove();done();}
  };
  // Bundle all files into one zip (or hand back the folder path if zip is absent).
  const bundleGo=document.getElementById('bundleGo');
  if(bundleGo)bundleGo.onclick=async()=>{
    bundleGo.disabled=true;const o=bundleGo.textContent;bundleGo.textContent='Bundling…';
    try{const j=await(await fetch('/api/bundle',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).json();
      const row=document.getElementById('bundleRow');
      if(j.ok&&j.zip){row.innerHTML='<p class="filepath"><code>'+escapeText(j.zip)+'</code></p><button class="btn ghost tiny" data-reveal="zip">Show in folder</button>';}
      else if(j.ok){row.innerHTML='<p class="filepath">No <code>zip</code> tool — attach these from <code>'+escapeText(j.dir)+'</code>: '+escapeText((j.files||[]).join(', '))+'</p><button class="btn ghost tiny" data-reveal="dir">Open folder</button>';}
      else{toast('Error: '+(j.error||'bundle failed'));}
      const rv=row.querySelector('[data-reveal]');
      if(rv)rv.onclick=async()=>{try{const rr=await(await fetch('/api/reveal-bundle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({what:rv.dataset.reveal})})).json();toast(rr.ok?'Opened in file manager':'Could not open'+(rr.error?': '+rr.error:''));}catch(e){toast('Error: '+e.message);}};}
    catch(e){toast('Error: '+e.message);}
    bundleGo.disabled=false;bundleGo.textContent=o;
  };
  // Direct send via a connected MCP channel (email / slack) — the agent fulfils it.
  b.querySelectorAll('[data-sendmcp]').forEach(btn=>btn.onclick=async()=>{
    const ch=btn.dataset.sendmcp;const o=btn.textContent;btn.disabled=true;btn.textContent='Sending…';
    const to=(SEAL.people||[]).map(p=>p&&(p.email||p.handle)).filter(Boolean);
    try{const j=await(await fetch('/api/share',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({channels:[ch],to})})).json();
      toast(j.dispatched?('Sent to your agent to deliver via '+ch):'Exported');}
    catch(e){toast('Error: '+e.message);}
    btn.disabled=false;btn.textContent=o;
  });
}
document.getElementById('shareBtn').onclick=()=>{renderShare();shareDlg.hidden=false;};

// ---- owner actions: accept suggestion / dismiss comment / edit the doc ----
if(isServe)document.body.classList.add('can-edit');
async function ownerPost(url,payload,msg){
  try{const j=await(await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)})).json();
    if(j&&j.ok){toast(msg);try{sessionStorage.setItem('seal-scroll',window.scrollY);sessionStorage.setItem('seal-pane','comments')}catch(e){}setTimeout(()=>location.reload(),600);}
    else toast('Error: '+((j&&j.error)||'failed'));}
  catch(e){toast('Server error: '+e.message);}
}
document.addEventListener('click',e=>{
  const ac=e.target.closest('[data-accept]');if(ac){e.preventDefault();e.stopPropagation();ownerPost('/api/accept',{id:ac.dataset.accept},'Suggestion applied to doc.md');return;}
  const ds=e.target.closest('[data-dismiss]');if(ds){e.preventDefault();e.stopPropagation();ownerPost('/api/dismiss',{id:ds.dataset.dismiss},'Comment dismissed');return;}
},true);
// edit the document (raw Markdown) — Save writes doc.md
const editBtn=document.getElementById('editBtn'),editBar=document.getElementById('editBar'),docMdEl=document.getElementById('docMd');
if(editBtn)editBtn.onclick=()=>{setView('md');docMdEl.contentEditable='true';docMdEl.classList.add('editing');editBar.hidden=false;docMdEl.focus();};
var editCancelB=document.getElementById('editCancel');if(editCancelB)editCancelB.onclick=()=>location.reload();
var editSaveB=document.getElementById('editSave');if(editSaveB)editSaveB.onclick=async()=>{
  const md=docMdEl.innerText;if(!md.trim()){toast('Empty — not saving');return;}
  await ownerPost('/api/doc',{markdown:md},'Saved to doc.md');
};

// ---- copy a /seal-role command to paste into Claude Code ----
document.addEventListener('click',e=>{const b=e.target.closest('[data-copycmd]');if(!b)return;
  e.preventDefault();const cmd=b.getAttribute('data-copycmd');
  (navigator.clipboard?navigator.clipboard.writeText(cmd):Promise.reject()).then(()=>toast('Copied — paste in Claude Code: '+cmd)).catch(()=>{prompt('Copy this into Claude Code:',cmd);});});

// ---- git: commit & push from the SHARE modal + auto-commit + close handling ----
// The commit/auto controls live in the Share dialog (renderShare wires their
// click/change). doCommit looks up the modal button live since it's re-rendered.
async function doCommit(loud){
  const cg=document.getElementById('commitGo');
  if(cg){cg.disabled=true;cg.textContent='Committing…';}
  try{const j=await(await fetch('/api/commit',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({push:true})})).json();
    if(j.ok){SEAL.dirty=false;
      if(loud)toast(j.committed?(j.pushed?'Committed & pushed ✓':'Committed ✓ ('+(j.push_error||'no remote — not pushed')+')'):'Nothing to commit');}
    else if(loud)toast('Error: '+(j.error||'commit failed'));}
  catch(e){if(loud)toast('Commit error: '+e.message);}
  if(cg){cg.disabled=false;cg.textContent='Commit & push now';}
}
// "Add a repo to share" — repo has no remote, so committing wouldn't share anything
const needRemote=document.getElementById('needRemote');
if(needRemote)needRemote.onclick=()=>toast('No git remote — commits would stay on this machine. Ask your agent to connect a repo (git remote add origin <url>), or open the review from a cloned repo to share.');
// before closing: only nag if there's a REMOTE to push to (otherwise the review
// is already saved on disk — committing wouldn't share anything). Always beacon
// the AI console so it knows the browser closed.
window.addEventListener('beforeunload',function(e){
  try{navigator.sendBeacon('/api/closing','{}');}catch(_){}
  if(SEAL.gitRemote&&SEAL.dirty&&!SEAL.autoCommit){e.preventDefault();e.returnValue='You have uncommitted review changes — Commit & push before leaving?';return e.returnValue;}
});

// ---- restore view / pane / role / scroll after reload ----
try{
  const v=sessionStorage.getItem('seal-view');if(v)setView(v);
  const pn=sessionStorage.getItem('seal-pane');if(pn){setPane(pn);sessionStorage.removeItem('seal-pane');}
  const rr=sessionStorage.getItem('seal-role');if(rr&&SEAL.summaries[rr])applyRole(rr);
  const scp=sessionStorage.getItem('seal-scroll');if(scp!==null){window.scrollTo(0,+scp);sessionStorage.removeItem('seal-scroll');}
}catch(e){}
</script>
</body></html>`;
}
