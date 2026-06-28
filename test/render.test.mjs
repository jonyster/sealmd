// Tests for render-core.mjs — markdown -> self-contained HTML.
// Security is the priority: escapeHtml + escaping through renderMarkdown/inline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeHtml, renderInline, renderMarkdown, markdownBlocks, deriveSummary, renderReviewPage,
} from '../skills/seal-review/scripts/render-core.mjs';

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------
test('escapeHtml neutralizes all five dangerous chars', () => {
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml('>'), '&gt;');
  assert.equal(escapeHtml('&'), '&amp;');
  assert.equal(escapeHtml('"'), '&quot;');
  assert.equal(escapeHtml("'"), '&#39;');
});

test('escapeHtml escapes & first so existing entities are not double-broken into raw tags', () => {
  // ampersand must be escaped before <, otherwise &lt; would re-introduce a `<`.
  assert.equal(escapeHtml('a & b < c'), 'a &amp; b &lt; c');
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('escapeHtml neutralizes a full script tag', () => {
  const out = escapeHtml('<script>alert(1)</script>');
  assert.ok(!/<script/i.test(out));
  assert.ok(!out.includes('>'));
  assert.equal(out, '&lt;script&gt;alert(1)&lt;/script&gt;');
});

test('escapeHtml coerces non-strings without throwing', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(null), 'null');
  assert.equal(escapeHtml(undefined), 'undefined');
  assert.equal(escapeHtml(''), '');
});

// ---------------------------------------------------------------------------
// renderInline
// ---------------------------------------------------------------------------
test('renderInline escapes raw HTML text', () => {
  const out = renderInline('<b>x</b> & "q"');
  assert.ok(!out.includes('<b>'));
  assert.ok(out.includes('&lt;b&gt;'));
  assert.ok(out.includes('&amp;'));
  assert.ok(out.includes('&quot;'));
});

test('renderInline bold/italic/strikethrough', () => {
  assert.equal(renderInline('**bold**'), '<strong>bold</strong>');
  assert.equal(renderInline('__bold__'), '<strong>bold</strong>');
  assert.equal(renderInline('a *it* b'), 'a <em>it</em> b');
  assert.equal(renderInline('a _it_ b'), 'a <em>it</em> b');
  assert.equal(renderInline('~~gone~~'), '<del>gone</del>');
});

test('renderInline code span escapes its contents (no raw tag survives)', () => {
  const out = renderInline('`<script>alert(1)</script>`');
  assert.ok(out.startsWith('<code>'));
  assert.ok(out.endsWith('</code>'));
  assert.ok(!/<script/i.test(out));
  assert.ok(out.includes('&lt;script&gt;'));
});

test('renderInline link: label rendered, href escaped', () => {
  const out = renderInline('[Click](https://example.com)');
  assert.equal(out, '<a href="https://example.com">Click</a>');
});

test('renderInline neutralizes javascript: URL in links', () => {
  const out = renderInline('[x](javascript:alert(1))');
  assert.ok(out.includes('#blocked-unsafe-url'));
  assert.ok(!/href="javascript:/i.test(out));
});

test('renderInline image: alt + escaped safe src; unsafe src blocked', () => {
  assert.equal(renderInline('![alt](pic.png)'), '<img src="pic.png" alt="alt">');
  const evil = renderInline('![x](javascript:alert(1))');
  assert.ok(evil.includes('#blocked-unsafe-url'));
});

test('renderInline link href with quote cannot break out of the attribute', () => {
  // a crafted href must not introduce a raw " that escapes the attribute
  const out = renderInline('[x](https://e.com"onmouseover=alert(1))');
  // the dangerous quote, if present, must be escaped to &quot;
  assert.ok(!/href="[^"]*"[^>]*onmouseover/i.test(out));
});

// ---------------------------------------------------------------------------
// renderMarkdown — structure
// ---------------------------------------------------------------------------
test('renderMarkdown headings h1..h6 with block ids', () => {
  const out = renderMarkdown('# H1\n\n## H2\n\n###### H6');
  assert.ok(/<h1 id="blk-0">H1<\/h1>/.test(out));
  assert.ok(/<h2 id="blk-1">H2<\/h2>/.test(out));
  assert.ok(/<h6 id="blk-2">H6<\/h6>/.test(out));
});

test('renderMarkdown unordered + ordered lists', () => {
  const ul = renderMarkdown('- a\n- b');
  assert.ok(ul.includes('<ul'));
  assert.ok(ul.includes('<li>a</li>'));
  assert.ok(ul.includes('<li>b</li>'));
  const ol = renderMarkdown('1. a\n2. b');
  assert.ok(ol.includes('<ol'));
  assert.ok(ol.includes('<li>a</li>'));
});

test('renderMarkdown emphasis inside paragraph', () => {
  const out = renderMarkdown('This is **strong** and *em* text.');
  assert.ok(out.includes('<strong>strong</strong>'));
  assert.ok(out.includes('<em>em</em>'));
  assert.ok(out.includes('<p'));
});

test('renderMarkdown code span and fenced code block', () => {
  const span = renderMarkdown('Use `npm test` now.');
  assert.ok(span.includes('<code>npm test</code>'));
  const block = renderMarkdown('```js\nconst x = 1;\n```');
  // top-level block gets an injected id="blk-N" on its first tag
  assert.ok(/<pre id="blk-0"><code class="language-js">/.test(block));
  assert.ok(block.includes('const x = 1;'));
});

test('renderMarkdown link inside paragraph', () => {
  const out = renderMarkdown('See [docs](https://example.com) here.');
  assert.ok(out.includes('<a href="https://example.com">docs</a>'));
});

test('renderMarkdown blockquote and hr', () => {
  const bq = renderMarkdown('> quoted line');
  assert.ok(/<blockquote id="blk-0">/.test(bq));
  assert.ok(bq.includes('quoted line'));
  const hr = renderMarkdown('---');
  assert.ok(hr.includes('<hr'));
});

test('renderMarkdown table', () => {
  const out = renderMarkdown('| A | B |\n| --- | ---: |\n| 1 | 2 |');
  assert.ok(/<table id="blk-0">/.test(out));
  assert.ok(out.includes('<th>A</th>'));
  assert.ok(out.includes('text-align:right'));
  assert.ok(out.includes('<td>1</td>'));
});

// ---------------------------------------------------------------------------
// renderMarkdown — SECURITY: raw HTML in source is escaped, not passed through
// ---------------------------------------------------------------------------
test('renderMarkdown escapes a <script> tag in a paragraph (no executable tag survives)', () => {
  const out = renderMarkdown('Hello <script>alert(document.cookie)</script> world');
  assert.ok(!/<script/i.test(out), 'raw <script> survived: ' + out);
  assert.ok(out.includes('&lt;script&gt;'));
});

test('renderMarkdown escapes <img onerror> XSS vector', () => {
  const out = renderMarkdown('text <img src=x onerror=alert(1)> more');
  assert.ok(!/<img\s+src=x/i.test(out), 'raw <img> survived: ' + out);
  assert.ok(out.includes('&lt;img'));
  // TIGHTENED (was tautological): assert the whole tag is neutralized — the
  // opening `<` is escaped to &lt; AND the closing `>` is escaped to &gt;, so
  // `onerror=...` is inert text inside a paragraph, never a live attribute.
  assert.ok(!/<img[^>]*onerror/i.test(out), 'live <img onerror> survived: ' + out);
  assert.ok(out.includes('&lt;img src=x onerror=alert(1)&gt;'),
    'img tag not fully escaped: ' + out);
  // there must be no unescaped `>` that could terminate a real tag here.
  assert.ok(!/onerror=alert\(1\)\s*>/.test(out), 'unescaped tag close survived: ' + out);
});

test('renderMarkdown escapes quotes and ampersands in text', () => {
  const out = renderMarkdown('She said "hi" & left <3');
  assert.ok(out.includes('&quot;hi&quot;'));
  assert.ok(out.includes('&amp;'));
  assert.ok(out.includes('&lt;3'));
});

test('renderMarkdown escapes raw HTML inside a heading', () => {
  const out = renderMarkdown('# <iframe src=evil>');
  assert.ok(!/<iframe/i.test(out));
  assert.ok(out.includes('&lt;iframe'));
});

test('renderMarkdown escapes raw HTML inside list items', () => {
  const out = renderMarkdown('- <svg onload=alert(1)>');
  assert.ok(!/<svg/i.test(out));
  assert.ok(out.includes('&lt;svg'));
});

test('renderMarkdown escapes HTML inside fenced code block', () => {
  const out = renderMarkdown('```\n<script>evil()</script>\n```');
  assert.ok(!/<script>evil/i.test(out));
  assert.ok(out.includes('&lt;script&gt;evil()&lt;/script&gt;'));
});

// ---------------------------------------------------------------------------
// renderMarkdown — edge cases
// ---------------------------------------------------------------------------
test('renderMarkdown empty input returns empty string', () => {
  assert.equal(renderMarkdown(''), '');
});

test('renderMarkdown CRLF line endings', () => {
  // \r is not a blank-line separator; the source uses split('\n'), so CRLF
  // leaves a trailing \r on each line. Headings still render.
  const out = renderMarkdown('# Title\r\n\r\nBody text\r\n');
  assert.ok(/<h1 id="blk-0">Title/.test(out));
  assert.ok(out.includes('Body text'));
});

test('renderMarkdown unicode content preserved', () => {
  const out = renderMarkdown('# 日本語 — café ☕ 𝕏');
  assert.ok(out.includes('日本語'));
  assert.ok(out.includes('café'));
  assert.ok(out.includes('☕'));
});

test('renderMarkdown large input does not throw', () => {
  const big = Array.from({ length: 5000 }, (_, i) => `## Section ${i}\n\nParagraph ${i} body.`).join('\n\n');
  assert.doesNotThrow(() => renderMarkdown(big));
  const out = renderMarkdown(big);
  assert.ok(out.includes('Section 0'));
  assert.ok(out.includes('Section 4999'));
});

test('renderMarkdown is deterministic / idempotent across calls', () => {
  const md = '# T\n\n- a\n- b\n\n`code`';
  assert.equal(renderMarkdown(md), renderMarkdown(md));
});

// ---------------------------------------------------------------------------
// deriveSummary — real contract
// ---------------------------------------------------------------------------
test('deriveSummary returns the documented shape', () => {
  const md = '# Title\n\nThe lead paragraph here.\n\n## Goals\n\n## Risks';
  const s = deriveSummary(md, 42);
  assert.equal(typeof s.lead, 'string');
  assert.equal(s.role_lead, s.lead);
  assert.ok(Array.isArray(s.key_decisions));
  assert.ok(Array.isArray(s.relevant_sections));
  assert.ok(Array.isArray(s.needs_your_judgment));
  assert.ok(Array.isArray(s.needs_attention));
});

test('deriveSummary picks first non-structural line as the lead', () => {
  const md = '# Heading\n\n- list item\n\nReal lead sentence.';
  const s = deriveSummary(md, 10);
  assert.equal(s.lead, 'Real lead sentence.');
});

test('deriveSummary collects ## sections into key_decisions and relevant_sections', () => {
  const md = 'Lead.\n\n## Alpha\n\n## Beta\n\n## Gamma';
  const s = deriveSummary(md, 7);
  const labels = s.key_decisions.map((k) => k.value);
  assert.ok(labels.includes('Alpha'));
  assert.ok(labels.includes('Beta'));
  assert.ok(labels.includes('Gamma'));
  assert.equal(s.key_decisions[0].label, 'Section');
  assert.ok(s.relevant_sections.some((r) => r.section === 'Alpha'));
});

test('deriveSummary caps relevant_sections at 6', () => {
  const md = 'Lead.\n\n' + Array.from({ length: 10 }, (_, i) => `## Sec ${i}`).join('\n\n');
  const s = deriveSummary(md, 12);
  assert.ok(s.relevant_sections.length <= 6);
  // key_decisions caps at 8
  assert.ok(s.key_decisions.length <= 8);
});

test('deriveSummary on empty doc uses fallback lead and Length key', () => {
  const s = deriveSummary('', 0);
  assert.equal(s.lead, 'Document ready for review.');
  assert.equal(s.key_decisions.length, 1);
  assert.equal(s.key_decisions[0].label, 'Length');
  assert.equal(s.key_decisions[0].value, '0 words');
});

test('deriveSummary on huge doc does not throw', () => {
  const md = Array.from({ length: 20000 }, (_, i) => `## H${i}\nbody ${i}`).join('\n\n');
  assert.doesNotThrow(() => deriveSummary(md, 99999));
});

test('deriveSummary tags each section with the blk-N of its heading', () => {
  // blocks: blk-0 p(Lead.), blk-1 h2 Alpha, blk-2 p, blk-3 h2 Beta
  const md = 'Lead.\n\n## Alpha\n\nbody a\n\n## Beta';
  const s = deriveSummary(md, 9);
  assert.equal(s.relevant_sections.find((r) => r.section === 'Alpha').src, 'blk-1');
  assert.equal(s.relevant_sections.find((r) => r.section === 'Beta').src, 'blk-3');
  assert.equal(s.key_decisions.find((k) => k.value === 'Alpha').src, 'blk-1');
});

test('deriveSummary ignores a "## ..." line inside a code fence (no false section)', () => {
  const md = 'Lead.\n\n```\n## not a heading\n```\n\n## Real';
  const s = deriveSummary(md, 9);
  const sections = s.relevant_sections.map((r) => r.section);
  assert.deepEqual(sections, ['Real']);
});

// ---------------------------------------------------------------------------
// markdownBlocks — blk-N must line up with renderMarkdown's emitted anchors
// ---------------------------------------------------------------------------
test('markdownBlocks blk ids match the id="blk-N" the renderer emits', () => {
  const md = '# Title\n\nA para.\n\n## Section\n\nMore.';
  const blocks = markdownBlocks(md);
  const html = renderMarkdown(md);
  for (const b of blocks) {
    assert.ok(html.includes(`id="${b.blk}"`), `${b.blk} present in rendered HTML`);
  }
  assert.equal(blocks[0].tag, 'h1');
  assert.equal(blocks[0].text, 'Title');
});

// ---------------------------------------------------------------------------
// renderReviewPage — smoke + security
// ---------------------------------------------------------------------------
test('renderReviewPage renders summary entries given as bare strings (not just objects)', () => {
  // older/other agent output stores key_decisions / relevant_sections as plain
  // strings. The renderer must show them, not drop them into empty rows.
  const html = renderReviewPage(minimalOpts({
    roles: [{
      role: 'PM',
      lead: 'The PM lead.',
      key_decisions: ['Speed never bypasses screening.', 'Ship corridor A first.'],
      relevant_sections: ['§2 Goals — P95 under 30s and full coverage'],
      needs_attention: ['All open questions in §11 are unresolved.'],
    }],
  }));
  assert.ok(html.includes('<h3>Key decisions</h3>'), 'Key decisions header present for string entries');
  assert.ok(html.includes('Speed never bypasses screening.'), 'string key_decision content rendered');
  assert.ok(html.includes('<h3>What this means for you</h3>'), 'relevant_sections header present');
  assert.ok(html.includes('§2 Goals'), 'string relevant_section content rendered');
  assert.ok(html.includes('nolabel'), 'label-less key decision uses the full-width row');
});

function minimalOpts(overrides = {}) {
  return {
    title: 'My Spec',
    srcName: 'spec.md',
    mdRaw: '# My Spec\n\nA paragraph of content.\n\n## Section One\n\nBody.',
    contentHash: 'abcdef0123456789',
    wordCount: 9,
    roles: [],
    curatedRoles: [
      { value: 'engineering', label: 'Engineering' },
      { value: 'general', label: 'General' },
    ],
    comments: [],
    mode: 'static',
    people: [],
    ...overrides,
  };
}

test('renderReviewPage returns a self-contained HTML document', () => {
  const html = renderReviewPage(minimalOpts());
  assert.ok(typeof html === 'string' && html.length > 1000);
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(html.includes('</html>'));
  // self-contained: inline style, no external network refs
  assert.ok(html.includes('<style>'));
  assert.ok(!/<link[^>]+href=["']https?:/i.test(html));
  assert.ok(!/<script[^>]+src=["']https?:/i.test(html));
});

test('renderReviewPage embeds the title and the content hash', () => {
  const html = renderReviewPage(minimalOpts());
  assert.ok(html.includes('My Spec'));
  // version chip uses the first 7 chars of contentHash
  assert.ok(html.includes('abcdef0'));
});

test('renderReviewPage escapes an XSS title', () => {
  const html = renderReviewPage(minimalOpts({ title: '<script>alert(1)</script>' }));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('renderReviewPage escapes raw HTML in the document body', () => {
  const html = renderReviewPage(minimalOpts({
    mdRaw: '# Doc\n\nInline <img src=x onerror=alert(1)> attack.',
  }));
  assert.ok(!/<img\s+src=x\s+onerror/i.test(html));
  assert.ok(html.includes('&lt;img'));
});

test('renderReviewPage escapes a comment body containing HTML', () => {
  const html = renderReviewPage(minimalOpts({
    comments: [{
      id: 'c1',
      author: 'Reviewer',
      body: 'beware <script>alert(document.cookie)</script>',
      status: 'open',
      anchor: null,
    }],
  }));
  // the comment card must render but the script must be neutralized
  assert.ok(html.includes('Reviewer'));
  assert.ok(!/<script>alert\(document\.cookie\)/i.test(html));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('renderReviewPage escapes a malicious comment author name', () => {
  const html = renderReviewPage(minimalOpts({
    comments: [{
      id: 'c2', author: '"><img src=x onerror=alert(1)>', body: 'hi',
      status: 'open', anchor: null,
    }],
  }));
  assert.ok(!/<img src=x onerror=alert\(1\)>/.test(html));
});

test('renderReviewPage renders a suggestion card', () => {
  const html = renderReviewPage(minimalOpts({
    comments: [{
      id: 's1', author: 'Agent', body: 'rationale', status: 'open',
      suggestion: 'use **bold** here', anchor: { quote: 'old text' },
      anchor_status: 'here',
    }],
  }));
  assert.ok(html.includes('class="card sg'));
  assert.ok(html.includes('suggestion'));
});

// Bug #9: a suggestion reopened after accept is {status:'open', accepted:true}.
// It must show the "applied" badge (the doc already carries the edit), NOT a
// second Accept button — re-accepting can't find the replaced original and dead-ends.
test('renderReviewPage: a reopened-after-accept suggestion shows applied, not a fresh Accept', () => {
  const html = renderReviewPage(minimalOpts({
    mode: 'serve',
    comments: [{
      id: 's9', author: 'Agent', body: 'rationale', status: 'open',
      suggestion: 'new text', accepted: true, anchor: { quote: 'old text' },
      anchor_status: 'here',
    }],
  }));
  assert.ok(html.includes('applied to the document'), 'shows the applied badge');
  assert.ok(!html.includes('data-accept="s9"'), 'does not re-offer a broken Accept button');
});

test('renderReviewPage handles empty roles by auto-deriving a General summary', () => {
  const html = renderReviewPage(minimalOpts({ roles: [], wordCount: 9 }));
  // empty roles → honest generic state, NOT a role-tailored ("written for") digest
  assert.ok(html.includes('Auto-generated summary'), 'labels the summary as auto-generated');
  assert.ok(!html.includes('written for'), 'does not claim it is written for a role');
});

test('renderReviewPage: generic summary in static mode hides the role picker', () => {
  const html = renderReviewPage(minimalOpts({ roles: [], wordCount: 9, mode: 'static' }));
  assert.ok(!html.includes('id="roleInput"'), 'no role input when generic + static');
});

test('renderReviewPage: agent-authored roles keep the tailored "written for" header', () => {
  const html = renderReviewPage(minimalOpts({ roles: [{ role: 'Engineering', lead: 'x' }], wordCount: 9 }));
  assert.ok(html.includes('written for'));
  assert.ok(html.includes('id="roleInput"'), 'role picker present for real summaries');
});

test('renderReviewPage embeds client JSON with < escaped to prevent </script> breakout', () => {
  const html = renderReviewPage(minimalOpts({ srcName: 'a</script>b.md' }));
  // the SEAL_JS_DATA blob escapes < as <, so a literal </script> cannot
  // close the inline script early.
  assert.ok(!html.includes('a</script>b.md') || html.includes('a\\u003c/script>b.md'));
});

test('renderReviewPage with empty comments shows the empty-rail message', () => {
  const html = renderReviewPage(minimalOpts({ comments: [] }));
  assert.ok(html.includes('No comments or suggestions yet'));
});

// ===========================================================================
// APPENDED: reviewer-flagged coverage gaps.
// ===========================================================================

// ---------------------------------------------------------------------------
// safeUrl scheme-blocking — guard against a future SAFE_URL regression.
// safeUrl is not exported, so we probe it through renderInline link/image src.
// The allowlist is /^(https?:|mailto:|#|\/|\.\/|\.\.\/|[^:]*$)/i — anything
// with a scheme that is NOT http(s)/mailto must collapse to the sentinel.
// ---------------------------------------------------------------------------
test('renderInline blocks data: URLs (data:text/html payload cannot survive in href)', () => {
  const out = renderInline('[x](data:text/html,<script>alert(1)</script>)');
  assert.ok(out.includes('#blocked-unsafe-url'), 'data: URL not blocked: ' + out);
  assert.ok(!/href="data:/i.test(out), 'data: scheme reached href: ' + out);
});

test('renderInline blocks vbscript: URLs in links', () => {
  const out = renderInline('[x](vbscript:msgbox(1))');
  assert.ok(out.includes('#blocked-unsafe-url'), 'vbscript: not blocked: ' + out);
  assert.ok(!/href="vbscript:/i.test(out));
});

test('renderInline blocks UPPERCASE JavaScript: (case-insensitive scheme block)', () => {
  // SAFE_URL is /i but the dangerous-scheme rejection must not be defeated by
  // mixed/upper case — JavaScript:, JAVASCRIPT:, jAvAsCrIpT: all blocked.
  for (const u of ['JavaScript:alert(1)', 'JAVASCRIPT:alert(1)', 'jAvAsCrIpT:alert(1)']) {
    const out = renderInline(`[x](${u})`);
    assert.ok(out.includes('#blocked-unsafe-url'), `${u} not blocked: ${out}`);
    assert.ok(!/href="javascript:/i.test(out), `javascript reached href for ${u}: ${out}`);
  }
});

test('renderInline blocks UPPERCASE VBSCRIPT: scheme', () => {
  const out = renderInline('[x](VBSCRIPT:x)');
  assert.ok(out.includes('#blocked-unsafe-url'), 'VBSCRIPT: not blocked: ' + out);
  assert.ok(!/href="vbscript:/i.test(out));
});

test('renderInline blocks unsafe image src schemes (data:/vbscript:/uppercase javascript:)', () => {
  // NB: the image regex only matches a src with no spaces and no ')', so these
  // are chosen to actually be parsed as <img> — then the scheme block must fire.
  for (const u of ['data:image/png;base64,AAAA', 'VBSCRIPT:x', 'JavaScript:alert']) {
    const out = renderInline(`![alt](${u})`);
    assert.ok(out.includes('src="#blocked-unsafe-url"'), `img src ${u} not blocked: ${out}`);
    assert.ok(!/src="(data|vbscript|javascript):/i.test(out), `unsafe src survived for ${u}: ${out}`);
  }
});

test('renderInline still allows the documented safe schemes', () => {
  // sanity: the block must not be over-eager — https/mailto/relative/anchor pass.
  assert.ok(renderInline('[a](https://e.com)').includes('href="https://e.com"'));
  assert.ok(renderInline('[a](mailto:x@e.com)').includes('href="mailto:x@e.com"'));
  assert.ok(renderInline('[a](/local/path)').includes('href="/local/path"'));
  assert.ok(renderInline('[a](#anchor)').includes('href="#anchor"'));
  assert.ok(renderInline('[a](./rel.md)').includes('href="./rel.md"'));
});

// ---------------------------------------------------------------------------
// renderMarkdown — list edge cases (parseList recursion, loose lists, ordered).
// ---------------------------------------------------------------------------
test('renderMarkdown nested unordered list nests the child <ul> inside the parent <li>', () => {
  const out = renderMarkdown('- a\n  - a1\n  - a2\n- b');
  // parent list with a nested list embedded before the parent item closes
  assert.ok(/<ul[^>]*><li>a<ul><li>a1<\/li><li>a2<\/li><\/ul><\/li><li>b<\/li><\/ul>/.test(out),
    'nested list structure wrong: ' + out);
  // exactly two <ul> opens (one parent, one child)
  assert.equal((out.match(/<ul/g) || []).length, 2);
});

test('renderMarkdown nests an ordered list inside an unordered parent item', () => {
  const out = renderMarkdown('- top\n  1. one\n  2. two');
  assert.ok(out.includes('<ul'), 'parent should be ul: ' + out);
  assert.ok(/<li>top<ol><li>one<\/li><li>two<\/li><\/ol><\/li>/.test(out),
    'ordered child not nested into parent li: ' + out);
});

test('renderMarkdown deeply nested (3 levels) list recurses', () => {
  const out = renderMarkdown('- a\n  - b\n    - c');
  assert.ok(/<li>a<ul><li>b<ul><li>c<\/li><\/ul><\/li><\/ul><\/li>/.test(out),
    '3-level nesting wrong: ' + out);
  assert.equal((out.match(/<ul/g) || []).length, 3);
});

test('renderMarkdown loose list (blank lines between items) stays one list', () => {
  const out = renderMarkdown('- a\n\n- b\n\n- c');
  // a blank line between items at the same indent does NOT break the list
  assert.equal((out.match(/<ul/g) || []).length, 1, 'loose list split into multiple uls: ' + out);
  assert.ok(out.includes('<li>a</li>'));
  assert.ok(out.includes('<li>b</li>'));
  assert.ok(out.includes('<li>c</li>'));
});

test('renderMarkdown blank line then a non-list line terminates the list', () => {
  const out = renderMarkdown('- a\n- b\n\nA following paragraph.');
  assert.equal((out.match(/<ul/g) || []).length, 1);
  assert.ok(out.includes('<li>b</li>'));
  assert.ok(/<p[^>]*>A following paragraph\.<\/p>/.test(out), 'paragraph after list missing: ' + out);
});

test('renderMarkdown ordered list renders <ol> with items in document order', () => {
  const out = renderMarkdown('1. first\n2. second\n3. third');
  assert.ok(/<ol[^>]*>/.test(out));
  assert.ok(/<li>first<\/li><li>second<\/li><li>third<\/li>/.test(out), 'ol items wrong: ' + out);
});

test('renderMarkdown ordered list does NOT honor a non-1 start number', () => {
  // Known limitation: parseList ignores the literal start number — there is no
  // start="N" attribute. Pin the ACTUAL behavior so a future fix is a deliberate
  // change, not an accident. (Markdown convention would render start="3".)
  const out = renderMarkdown('3. third\n4. fourth');
  assert.ok(out.includes('<ol'), 'should still be an ordered list: ' + out);
  assert.ok(!/start=/.test(out), 'unexpected start attribute appeared: ' + out);
  assert.ok(out.includes('<li>third</li>'));
});

test('renderMarkdown ordered list accepts ) delimiter as well as .', () => {
  const out = renderMarkdown('1) a\n2) b');
  assert.ok(out.includes('<ol'));
  assert.ok(out.includes('<li>a</li>'));
  assert.ok(out.includes('<li>b</li>'));
});

// ---------------------------------------------------------------------------
// renderReviewPage — serve mode differs from static mode.
// ---------------------------------------------------------------------------
test('renderReviewPage serve mode embeds mode:serve and owner Accept/Dismiss buttons', () => {
  const opts = minimalOpts({
    mode: 'serve',
    gitRemote: 'git@github.com:acme/spec.git',
    canCommit: true,
    comments: [{
      id: 'sug1', author: 'Agent', body: 'why', status: 'open',
      suggestion: 'do this instead', anchor: { quote: 'old text' }, anchor_status: 'here',
    }],
  });
  const html = renderReviewPage(opts);
  // client JSON announces serve mode (drives body.can-edit + POST endpoints)
  assert.ok(/"mode":"serve"/.test(html), 'serve mode not in client JSON: missing');
  // cardActions emits owner controls (CSS-gated by body.can-edit at runtime)
  assert.ok(/data-accept="sug1"/.test(html), 'Accept button missing for suggestion');
  assert.ok(/data-dismiss="sug1"/.test(html), 'Dismiss button missing');
  assert.ok(html.includes('owneract'), 'owneract container missing');
});

test('renderReviewPage serve+gitRemote shows commit chrome that static lacks', () => {
  const base = {
    comments: [{ id: 'c1', author: 'A', body: 'hi', status: 'open', anchor: null }],
  };
  const staticHtml = renderReviewPage(minimalOpts({ ...base, mode: 'static' }));
  const serveHtml = renderReviewPage(minimalOpts({
    ...base, mode: 'serve', canCommit: true, gitRemote: 'git@github.com:acme/spec.git',
  }));
  // the two renders MUST differ
  assert.notEqual(staticHtml, serveHtml, 'serve and static rendered identically');
  // commit + auto-commit chrome now lives in the Share modal (built client-side
  // from the embedded data, gated on gitRemote) — the toolbar carries no commit
  // button in any mode
  assert.ok(!serveHtml.includes('id="commitBtn"'), 'toolbar commit button should be removed');
  assert.ok(!staticHtml.includes('id="commitBtn"'), 'commit button must not be in static');
  // mode flag flips in the embedded JSON
  assert.ok(/"mode":"serve"/.test(serveHtml));
  assert.ok(/"mode":"static"/.test(staticHtml));
  // gitRemote is carried into the client blob in serve mode only
  assert.ok(/"gitRemote":"git@github.com:acme\/spec.git"/.test(serveHtml));
  assert.ok(/"gitRemote":null/.test(staticHtml));
});

test('renderReviewPage static mode does not advertise serve-only POST mode', () => {
  const html = renderReviewPage(minimalOpts({ mode: 'static' }));
  assert.ok(/"mode":"static"/.test(html));
  assert.ok(!/"mode":"serve"/.test(html));
});

// ---------------------------------------------------------------------------
// deriveSummary — CRLF / unicode / structural-only edge cases past the happy path.
// ---------------------------------------------------------------------------
test('deriveSummary on an all-headings doc falls back on lead but still collects ## sections', () => {
  // No body paragraph exists, so the lead must fall back; h2s still become sections.
  // (The single h1 `#` is NOT a `##` and must NOT be collected.)
  const s = deriveSummary('# Title\n\n## B\n\n## C', 3);
  assert.equal(s.lead, 'Document ready for review.');
  const values = s.key_decisions.map((k) => k.value);
  assert.deepEqual(values, ['B', 'C'], 'h2 sections not collected (or h1 leaked): ' + JSON.stringify(values));
  assert.ok(s.relevant_sections.some((r) => r.section === 'B'));
});

test('deriveSummary skips a blockquote as the lead and falls back', () => {
  // first non-structural-looking line is a blockquote `> ...` — must be skipped.
  const s = deriveSummary('# Title\n\n> a quoted lead\n\n## Sec', 5);
  assert.equal(s.lead, 'Document ready for review.', 'blockquote was wrongly used as lead');
});

test('deriveSummary skips a table row and an hr before choosing the lead', () => {
  const s = deriveSummary('# T\n\n| a | b |\n\n---\n\nThe true lead.', 4);
  assert.equal(s.lead, 'The true lead.');
});

test('deriveSummary handles CRLF: lead and section labels carry no stray carriage returns', () => {
  const s = deriveSummary('# Title\r\n\r\nReal lead.\r\n\r\n## Section A\r\n\r\n## Section B\r\n', 4);
  assert.equal(s.lead, 'Real lead.');
  assert.ok(!/\r/.test(s.lead), 'CR leaked into lead');
  const values = s.key_decisions.map((k) => k.value);
  assert.deepEqual(values, ['Section A', 'Section B']);
  for (const k of s.key_decisions) assert.ok(!/\r/.test(k.value), 'CR leaked into section value: ' + JSON.stringify(k.value));
});

test('deriveSummary preserves unicode in lead and section labels', () => {
  const s = deriveSummary('# 標題\n\n日本語のリード文。\n\n## セクション ☕', 6);
  assert.equal(s.lead, '日本語のリード文。');
  assert.ok(s.relevant_sections.some((r) => r.section === 'セクション ☕'));
});

test('deriveSummary on a huge unicode doc with CRLF does not throw and stays capped', () => {
  const doc = Array.from({ length: 12000 }, (_, i) => `## セクション ${i} ☕`).join('\r\n\r\n');
  let s;
  assert.doesNotThrow(() => { s = deriveSummary(doc, 50000); });
  // key_decisions caps at 8, relevant_sections at 6 even for a giant doc
  assert.ok(s.key_decisions.length <= 8);
  assert.ok(s.relevant_sections.length <= 6);
  assert.equal(s.lead, 'Document ready for review.'); // no body para → fallback
});
