// ============================================================================
// Shared test harness for the sealmd plugin. Zero deps — node:test + node stdlib.
//
// Two layers:
//   - Direct imports of the pure modules (anchor / notify / render-core).
//   - Black-box CLI driver `runSeal()` that spawns seal.mjs in an isolated tmp
//     dir, so the engine is tested exactly as users invoke it.
//
// APPEND-ONLY for parallel authors: add helpers, do not rewrite existing ones.
// ============================================================================
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRIPTS = join(HERE, '..', 'skills', 'seal-review', 'scripts');
export const SEAL = join(SCRIPTS, 'seal.mjs');

// Make a throwaway working dir. Pass {git:true} to init a real repo (for
// commit/owner-from-git tests). Returns {dir, doc, sidecar, cleanup, write, read}.
export function makeWorkspace({ git = false, docName = 'doc.md', content = SAMPLE_DOC } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'seal-test-'));
  const doc = join(dir, docName);
  writeFileSync(doc, content, 'utf8');
  if (git) {
    execSync('git init -q', { cwd: dir });
    execSync('git config user.name "Test User"', { cwd: dir });
    execSync('git config user.email "test@example.com"', { cwd: dir });
  }
  return {
    dir, doc,
    sidecar: doc.replace(/\.md$/, '.seal.md'),
    html: doc.replace(/\.md$/, '.review.html'),
    write: (name, body) => { const p = join(dir, name); writeFileSync(p, body, 'utf8'); return p; },
    read: (name) => readFileSync(join(dir, name), 'utf8'),
    exists: (name) => existsSync(join(dir, name)),
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

// Run the seal CLI. Returns {code, stdout, stderr, json}. `json` is the LAST
// JSON line of stdout parsed (the CLI prints one JSON result line on success),
// or null. Never throws on non-zero exit — inspect .code.
export function runSeal(args, { cwd, env, input } = {}) {
  let stdout = '', stderr = '', code = 0;
  try {
    stdout = execFileSync(process.execPath, [SEAL, ...args], {
      cwd, encoding: 'utf8', input,
      env: { ...process.env, CI: '1', NO_COLOR: '1', ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    code = e.status ?? 1;
    stdout = e.stdout?.toString() ?? '';
    stderr = e.stderr?.toString() ?? '';
  }
  let json = null;
  const lines = stdout.trim().split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { json = JSON.parse(lines[i]); break; } catch {}
  }
  return { code, stdout, stderr, json };
}

// Convenience: init a workspace + run `seal init`, returning the workspace.
export function initWorkspace(opts = {}) {
  const ws = makeWorkspace(opts);
  const res = runSeal(['init', '--in', ws.doc, ...(opts.initArgs || [])], { cwd: ws.dir });
  if (res.code !== 0) throw new Error(`init failed: ${res.stderr || res.stdout}`);
  ws.initResult = res.json;
  return ws;
}

export const SAMPLE_DOC = `# Sample PRD

## Overview
This is a sample document for review. It has enough text to anchor against.

## Goals
The primary goal is to ship a fully local review tool with zero network calls.

## Risks
There is a risk that anchors drift when the document changes underneath them.
`;
