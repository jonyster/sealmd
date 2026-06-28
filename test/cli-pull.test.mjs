// ============================================================================
// Inbound GitHub sync (corePull / `seal pull`) WITHOUT hitting GitHub. A fake `gh`
// on PATH serves the PR-comment API endpoints; the git mechanics run for real.
// Covers: import a reviewer's PR comments into the sidecar, skip Seal's OWN posted
// comments (seal:c= / seal:pr-comments markers), tag origin+external_ref, and
// idempotent re-pull. corePull isn't exported, so we drive it via `seal pull`.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { runSeal } from './helper.mjs';

const SAMPLE = `# PR Doc

## Overview
This document is reviewed and opened as a pull request via gh.
`;

function git(cwd, args) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'seal-pull-'));
  execFileSync('git', ['init', '-q', dir], { stdio: 'ignore' });
  git(dir, ['config', 'user.name', 'PR User']);
  git(dir, ['config', 'user.email', 'pr@example.com']);
  git(dir, ['checkout', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'spec.md'), SAMPLE, 'utf8');
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'seed']);
  return { dir, doc: join(dir, 'spec.md'), cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

// Fake gh: nameWithOwner -> acme/repo; `api .../pulls/42/comments` -> one foreign review
// comment on spec.md + one of OUR OWN (seal:c= marker); `api .../issues/42/comments` -> one
// foreign + one of ours (seal:pr-comments). Everything else exits 0.
function makeFakeGh({ empty = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'seal-fakegh-pull-'));
  const reviewJSON = empty ? '[]' : JSON.stringify([
    { id: 1001, body: 'This number looks wrong.', path: 'spec.md', line: 4, user: { login: 'octo-reviewer' } },
    { id: 1002, body: '<!-- seal:c=c_abc -->\n**Me**: prior seal comment', path: 'spec.md', line: 4, user: { login: 'me' } },
    { id: 1003, body: 'Replying to that.', path: 'spec.md', line: 4, in_reply_to_id: 1001, user: { login: 'octo-author' } },
  ]).replace(/'/g, "'\\''");
  const issueJSON = empty ? '[]' : JSON.stringify([
    { id: 2001, body: 'General thought on the whole doc.', user: { login: 'octo-pm' } },
    { id: 2002, body: '<!-- seal:pr-comments -->\n## 🦭 Seal review', user: { login: 'me' } },
  ]).replace(/'/g, "'\\''");
  const gh = join(dir, 'gh');
  writeFileSync(gh, `#!/usr/bin/env bash
case "$1" in
  --version) echo "gh version 0.0.0 (fake)"; exit 0 ;;
  auth) exit 0 ;;
  repo) for a in "$@"; do if [ "$a" = "nameWithOwner" ] || [ "$a" = ".nameWithOwner" ]; then echo "acme/repo"; exit 0; fi; done; echo "acme/repo"; exit 0 ;;
  api)
    path="$2"
    case "$path" in
      *pulls/42/comments) echo '${reviewJSON}'; exit 0 ;;
      *issues/42/comments) echo '${issueJSON}'; exit 0 ;;
      *) echo '[]'; exit 0 ;;
    esac ;;
  *) exit 0 ;;
esac
`, 'utf8');
  chmodSync(gh, 0o755);
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

const PR = 'https://github.com/acme/repo/pull/42';

test('seal pull imports foreign PR comments, skips Seal\'s own, tags origin+external_ref', () => {
  const repo = makeRepo();
  const fake = makeFakeGh();
  const env = { PATH: fake.dir + delimiter + (process.env.PATH || '') };
  try {
    runSeal(['init', '--in', repo.doc, '--title', 'PR Doc', '--owner', 'Dana Owner'], { cwd: repo.dir });

    const res = runSeal(['pull', '--in', repo.doc, '--pr', PR, '--no-render'], { cwd: repo.dir, env });
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.imported, 3, 'review comment + its reply + one issue comment');
    assert.equal(res.json.skipped, 0);

    const sidecar = readFileSync(repo.doc.replace(/\.md$/, '.seal.md'), 'utf8');
    assert.match(sidecar, /"origin":"github"/);
    assert.match(sidecar, /"external_ref":"gh:1001"/);     // the review comment (root)
    assert.match(sidecar, /"external_ref":"gh:2001"/);     // the issue comment
    assert.match(sidecar, /"external_ref":"gh:1003"/);     // the reply (in a thread entry)
    assert.match(sidecar, /replied on the GitHub PR/);     // reply threaded, not a new root
    assert.match(sidecar, /octo-reviewer/);                // GitHub author named
    assert.match(sidecar, /§ Overview/);                   // section heading captured
    assert.doesNotMatch(sidecar, /gh:1002/);               // our seal:c= comment NOT imported
    assert.doesNotMatch(sidecar, /gh:2002/);               // our seal:pr-comments NOT imported
    // 1003 is a reply: it lives inside 1001's thread, so there are 2 ROOT github comments (1001, 2001).
    const roots = (sidecar.match(/"kind":"comment"/g) || []).length;
    assert.equal(roots, 2, 'reply did not create a third root comment');
  } finally { repo.cleanup(); fake.cleanup(); }
});

test('seal pull routes a comment to the section\'s role reviewer, by email', () => {
  const repo = makeRepo();
  const fake = makeFakeGh();
  const env = { PATH: fake.dir + delimiter + (process.env.PATH || '') };
  const base = repo.doc.replace(/\.md$/, '');
  try {
    runSeal(['init', '--in', repo.doc, '--owner', 'Dana Owner'], { cwd: repo.dir });
    // The review comment lands on line 4, under the "## Overview" heading. A role whose summary
    // claims "Overview" + a person curated with that role + email = a routable reviewer.
    writeFileSync(`${base}.seal.summary.json`, JSON.stringify({ roles: [{ role: 'Legal', relevant_sections: ['Overview'] }] }), 'utf8');
    writeFileSync(`${base}.seal.people.json`, JSON.stringify({ 'Lee Legal': { role: 'Legal', email: 'lee@law.example' } }), 'utf8');

    const res = runSeal(['pull', '--in', repo.doc, '--pr', PR, '--no-render'], { cwd: repo.dir, env });
    assert.equal(res.json.ok, true);
    const sidecar = readFileSync(`${base}.seal.md`, 'utf8');
    assert.match(sidecar, /for the \*\*Legal\*\* reviewer/);   // role named, from the summary
    assert.match(sidecar, /lee@law\.example/);                 // routed to that reviewer's email
  } finally { repo.cleanup(); fake.cleanup(); }
});

test('seal pull resolves comments deleted on GitHub (archive, not hard-delete)', () => {
  const repo = makeRepo();
  const fake = makeFakeGh();
  const envWith = { PATH: fake.dir + delimiter + (process.env.PATH || '') };
  try {
    runSeal(['init', '--in', repo.doc, '--owner', 'Dana Owner'], { cwd: repo.dir });
    const first = runSeal(['pull', '--in', repo.doc, '--pr', PR, '--no-render'], { cwd: repo.dir, env: envWith });
    assert.ok(first.json.imported >= 1);

    // Same PR, but now GitHub returns no comments → everything we imported was deleted upstream.
    const fakeEmpty = makeFakeGh({ empty: true });
    const envEmpty = { PATH: fakeEmpty.dir + delimiter + (process.env.PATH || '') };
    const second = runSeal(['pull', '--in', repo.doc, '--pr', PR, '--no-render'], { cwd: repo.dir, env: envEmpty });
    assert.ok(second.json.resolved >= 1, 'deleted comments archived');
    const sidecar = readFileSync(repo.doc.replace(/\.md$/, '.seal.md'), 'utf8');
    assert.match(sidecar, /"external_ref":"gh:1001"/);   // row still present (not hard-deleted)
    assert.match(sidecar, /"status":"resolved"/);        // archived
    fakeEmpty.cleanup();
  } finally { repo.cleanup(); fake.cleanup(); }
});

test('seal pull is idempotent — a second pull imports nothing', () => {
  const repo = makeRepo();
  const fake = makeFakeGh();
  const env = { PATH: fake.dir + delimiter + (process.env.PATH || '') };
  try {
    runSeal(['init', '--in', repo.doc, '--owner', 'Dana Owner'], { cwd: repo.dir });
    runSeal(['pull', '--in', repo.doc, '--pr', PR, '--no-render'], { cwd: repo.dir, env });
    const again = runSeal(['pull', '--in', repo.doc, '--pr', PR, '--no-render'], { cwd: repo.dir, env });
    assert.equal(again.json.imported, 0, 'nothing new on re-pull');
    assert.equal(again.json.skipped, 3, 'root + reply + issue comment all skipped via external_ref');
  } finally { repo.cleanup(); fake.cleanup(); }
});
