// The serve loopback is not an auth boundary: any web page the reviewer has open
// can POST to 127.0.0.1, and DNS-rebinding defeats the bind. These tests pin the
// guard — foreign Host, cross-site Origin/Sec-Fetch, and missing token are all 403,
// while the page's own same-origin call (token attached) succeeds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { SEAL, makeWorkspace, runSeal, sealToken } from './helper.mjs';

// Raw GET so we can set a Host header that undici's fetch would otherwise overwrite.
const rawStatus = (port, host) => new Promise((resolve, reject) => {
  const req = request({ host: '127.0.0.1', port, path: '/api/state', method: 'GET', headers: { Host: host } }, (res) => { res.resume(); resolve(res.statusCode); });
  req.on('error', reject); req.end();
});

async function withServe(fn) {
  const ws = makeWorkspace({ git: true });
  runSeal(['init', '--in', ws.doc], { cwd: ws.dir });
  const port = 14000 + Math.floor(Math.random() * 50000);
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [SEAL, 'serve', '--in', ws.doc, '--port', String(port)], {
    cwd: ws.dir, env: { ...process.env, CI: '1', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = ''; child.stderr.on('data', (c) => { stderr += c; });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    if (/live review at|seal serve/.test(stderr)) { try { await fetch(base + '/api/state'); ready = true; break; } catch {} }
    if (child.exitCode != null) break;
    await delay(50);
  }
  try {
    if (!ready) throw new Error('serve never came up: ' + stderr);
    return await fn({ base, port });
  } finally { try { child.kill('SIGKILL'); } catch {} await delay(20); ws.cleanup(); }
}

test('POST without a session token is rejected (403)', () => withServe(async ({ base }) => {
  const r = await fetch(base + '/api/autocommit', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"on":true}',
  });
  assert.equal(r.status, 403);
}));

test('POST with the page token succeeds', () => withServe(async ({ base }) => {
  const token = await sealToken(base);
  assert.match(token, /\S/, 'page exposes a token');
  const r = await fetch(base + '/api/autocommit', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-seal-token': token }, body: '{"on":true}',
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).auto_commit, true);
}));

test('a cross-site Origin is rejected even with a valid token (CSRF)', () => withServe(async ({ base }) => {
  const token = await sealToken(base);
  const r = await fetch(base + '/api/autocommit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-seal-token': token, origin: 'http://evil.example.com' },
    body: '{"on":true}',
  });
  assert.equal(r.status, 403);
}));

test('a cross-site Sec-Fetch-Site is rejected (CSRF)', () => withServe(async ({ base }) => {
  const token = await sealToken(base);
  const r = await fetch(base + '/api/autocommit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-seal-token': token, 'sec-fetch-site': 'cross-site' },
    body: '{"on":true}',
  });
  assert.equal(r.status, 403);
}));

test('a foreign Host header is rejected (DNS-rebind defense)', () => withServe(async ({ port }) => {
  assert.equal(await rawStatus(port, 'evil.example.com'), 403);
  assert.equal(await rawStatus(port, `127.0.0.1:${port}`), 200); // loopback Host still OK
}));
