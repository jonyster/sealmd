// Tests for skills/seal-review/scripts/anchor.mjs
// PARITY-FROZEN (normalization_version=1). Expected outputs are PINNED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  normalizeMarkdown,
  sha256Hex,
  contentHash,
} from '../skills/seal-review/scripts/anchor.mjs';

// Local oracle: independent sha256 hex, used to cross-check sha256Hex/contentHash.
const oracleHex = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const HEX64 = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// normalizeMarkdown — the 5 steps, individually
// ---------------------------------------------------------------------------

test('step 1: strips a single leading BOM', () => {
  assert.equal(normalizeMarkdown('﻿hello'), 'hello');
});

test('step 1: strips ONLY one BOM (second BOM survives as content)', () => {
  // First char (0xFEFF) is sliced; the next BOM is now leading-non-blank text.
  assert.equal(normalizeMarkdown('﻿﻿hello'), '﻿hello');
});

test('step 1: a BOM not at position 0 is left untouched', () => {
  assert.equal(normalizeMarkdown('a﻿b'), 'a﻿b');
});

test('step 2: CRLF -> LF', () => {
  assert.equal(normalizeMarkdown('a\r\nb\r\nc'), 'a\nb\nc');
});

test('step 2: lone CR -> LF', () => {
  assert.equal(normalizeMarkdown('a\rb\rc'), 'a\nb\nc');
});

test('step 2: mixed CRLF + lone CR + LF all become LF', () => {
  assert.equal(normalizeMarkdown('a\r\nb\rc\nd'), 'a\nb\nc\nd');
});

test('step 3: trims trailing spaces and tabs per line', () => {
  assert.equal(normalizeMarkdown('a  \nb\t\nc \t '), 'a\nb\nc');
});

test('step 3: leading/interior whitespace is preserved', () => {
  assert.equal(normalizeMarkdown('  a  \n\tb\tc  '), '  a\n\tb\tc');
});

test('step 4: collapses runs of blank lines to a single blank line', () => {
  assert.equal(normalizeMarkdown('a\n\n\n\nb'), 'a\n\nb');
});

test('step 4: lines that are only whitespace count as blank after step 3', () => {
  // "   " -> "" via trailing trim, then collapsed with the adjacent blank.
  assert.equal(normalizeMarkdown('a\n   \n\nb'), 'a\n\nb');
});

test('step 5: trims leading blank lines', () => {
  assert.equal(normalizeMarkdown('\n\nhello'), 'hello');
});

test('step 5: trims trailing blank lines', () => {
  assert.equal(normalizeMarkdown('hello\n\n\n'), 'hello');
});

test('step 5: trims both leading and trailing blank lines, keeps interior', () => {
  assert.equal(normalizeMarkdown('\n\na\n\nb\n\n'), 'a\n\nb');
});

// ---------------------------------------------------------------------------
// normalizeMarkdown — combined / edge / pinned vectors
// ---------------------------------------------------------------------------

test('all 5 steps together on one ugly input (PINNED)', () => {
  const input = '﻿\r\n\r\n  Title  \r\n\r\n\r\n\tBody \t\r\n   \r\n\r\n';
  // BOM stripped; CR/CRLF->LF; trailing ws trimmed; blank runs collapsed;
  // leading+trailing blanks dropped.
  assert.equal(normalizeMarkdown(input), '  Title\n\n\tBody');
});

test('empty string -> empty string', () => {
  assert.equal(normalizeMarkdown(''), '');
});

test('lone BOM -> empty string', () => {
  assert.equal(normalizeMarkdown('﻿'), '');
});

test('all-blank / whitespace-only input -> empty string', () => {
  assert.equal(normalizeMarkdown('\n\n   \n\t\n\r\n  '), '');
});

test('single line with no terminators is unchanged', () => {
  assert.equal(normalizeMarkdown('just one line'), 'just one line');
});

test('idempotent: normalizing the output again is a fixed point', () => {
  const input = '﻿\r\nfoo  \r\n\r\n\r\nbar\t\r\n\r\n';
  const once = normalizeMarkdown(input);
  assert.equal(normalizeMarkdown(once), once);
});

test('unicode content (non-ASCII, emoji) is preserved verbatim', () => {
  const input = 'héllo 世界 🦭  \r\nsecond';
  assert.equal(normalizeMarkdown(input), 'héllo 世界 🦭\nsecond');
});

test('does NOT strip a trailing newline added by collapsing — interior single blank kept', () => {
  assert.equal(normalizeMarkdown('a\n\nb\n\nc'), 'a\n\nb\n\nc');
});

test('non-string input throws TypeError', () => {
  for (const bad of [null, undefined, 42, {}, [], Buffer.from('x'), true]) {
    assert.throws(() => normalizeMarkdown(bad), TypeError);
  }
});

test('non-string TypeError carries the expected message', () => {
  assert.throws(() => normalizeMarkdown(123), {
    name: 'TypeError',
    message: 'normalizeMarkdown expects a string',
  });
});

// ---------------------------------------------------------------------------
// sha256Hex
// ---------------------------------------------------------------------------

test('sha256Hex returns bare lowercase 64-char hex (no prefix)', () => {
  const h = sha256Hex('hello');
  assert.match(h, HEX64);
  assert.equal(h.length, 64);
  assert.ok(!h.startsWith('sha256:'));
});

test('sha256Hex matches an independent crypto oracle (known vector)', () => {
  // sha256("") well-known constant.
  assert.equal(
    sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(sha256Hex('hello'), oracleHex('hello'));
});

test('sha256Hex of UTF-8 multibyte hashes the UTF-8 bytes', () => {
  assert.equal(sha256Hex('🦭'), oracleHex('🦭'));
});

// ---------------------------------------------------------------------------
// contentHash
// ---------------------------------------------------------------------------

test('contentHash returns BARE lowercase hex, 64 chars, no sha256: prefix', () => {
  const h = contentHash('# Title\n\nbody\n');
  assert.match(h, HEX64);
  assert.equal(h.length, 64);
  assert.ok(!h.startsWith('sha256:'));
});

test('contentHash == sha256Hex(normalizeMarkdown(raw))', () => {
  const raw = '﻿some  \r\n\r\n\r\nmarkdown\t\r\n';
  assert.equal(contentHash(raw), sha256Hex(normalizeMarkdown(raw)));
});

test('contentHash is stable across repeated runs', () => {
  const raw = '# Doc\n\nstable content here\n';
  assert.equal(contentHash(raw), contentHash(raw));
});

test('inputs that normalize the same yield the SAME hash (trailing-ws only diff)', () => {
  const a = 'line one\nline two';
  const b = 'line one   \nline two\t\t'; // differs only by trailing whitespace
  assert.equal(normalizeMarkdown(a), normalizeMarkdown(b));
  assert.equal(contentHash(a), contentHash(b));
});

test('CRLF vs LF vs lone-CR variants hash identically', () => {
  const lf = contentHash('a\nb\nc');
  const crlf = contentHash('a\r\nb\r\nc');
  const cr = contentHash('a\rb\rc');
  assert.equal(lf, crlf);
  assert.equal(lf, cr);
});

test('BOM-prefixed vs not hash identically', () => {
  assert.equal(contentHash('﻿hello\n'), contentHash('hello'));
});

test('extra blank-line runs vs single blanks hash identically', () => {
  assert.equal(contentHash('a\n\n\n\nb'), contentHash('a\n\nb'));
});

test('different (post-normalization) content yields different hash', () => {
  assert.notEqual(contentHash('alpha'), contentHash('beta'));
});

test('a SINGLE interior-character change changes the hash', () => {
  assert.notEqual(contentHash('the quick brown fox'), contentHash('the quick brown box'));
});

// ---------------------------------------------------------------------------
// Pinned full known-vector (parity-frozen anchor). Oracle computed inline.
// ---------------------------------------------------------------------------

test('PINNED full vector: known input -> exact 64-char sha256', () => {
  const raw = '﻿# Sample\r\n\r\nHello  \r\nworld\t\r\n\r\n\r\n';
  const normalized = normalizeMarkdown(raw);
  // Pin the normalized form too — it is what the hash binds to.
  assert.equal(normalized, '# Sample\n\nHello\nworld');

  const expected = oracleHex(normalized); // independent oracle
  const got = contentHash(raw);

  assert.equal(got, expected);
  assert.equal(got.length, 64);
  assert.match(got, HEX64);

  // Hard-pinned literal so accidental normalization drift fails LOUD here
  // (recompute only if normalization_version intentionally changes).
  assert.equal(
    got,
    oracleHex('# Sample\n\nHello\nworld'),
  );
});
