'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { makeFixtures } = require('./fixtures/make-fixtures');
const { createApp } = require('../src/bridge/server');
const U = require('../src/bridge/lib/util');

let root; let app; let port;
const H = { 'X-Guardian': '1', 'Content-Type': 'application/json' };

function req(method, p, { body, headers = {}, host, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: host || `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    r.on('error', reject); if (data !== undefined) r.write(data); r.end();
  });
}
const get = (p, o) => req('GET', p, o);
const mut = (m, p, body, headers = H) => req(m, p, { body, headers });

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-test-'));
  makeFixtures(root, 20);
  app = createApp(root, { dist: path.join(root, 'dist') });
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), '<!doctype html><title>x</title>');
  await new Promise((r) => app.listen_(0, (p) => { port = p; r(); }));
});
test.after(() => { app.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('security: bad Host header is rejected', async () => {
  assert.strictEqual((await get('/api/overview', { host: 'evil.example.com' })).status, 403);
  assert.strictEqual((await get('/', { host: 'evil.example.com' })).status, 403);
});
test('security: mutating request without X-Guardian is rejected', async () => {
  const r = await req('POST', '/api/policy', { body: { list: 'blacklist', name: 'x' }, headers: { 'Content-Type': 'application/json' } });
  assert.strictEqual(r.status, 403);
});
test('security: cross-origin mutation is rejected', async () => {
  const r = await req('POST', '/api/policy', { body: { list: 'blacklist', name: 'x' }, headers: { ...H, Origin: 'http://evil.example.com' } });
  assert.strictEqual(r.status, 403);
});
test('security: no CORS headers emitted', async () => {
  const r = await get('/api/overview');
  assert.strictEqual(r.headers['access-control-allow-origin'], undefined);
});
test('security: report id traversal rejected', async () => {
  for (const id of ['..', '..%2F..%2Fconfig', '2026-1-1', '2026-W1', '..%5C..']) {
    const r = await get(`/api/reports/daily/${id}`);
    assert.ok([400, 404].includes(r.status), `${id} -> ${r.status}`);
  }
  assert.strictEqual((await get('/api/reports/other/2026-01-01')).status, 400);
});
test('security: static path traversal blocked', async () => {
  const r = await get('/..%2f..%2fconfig%2fconfig.json');
  assert.ok(!(r.text || '').includes('schemaVersion'));
});
test('security: oversize body rejected', async () => {
  const r = await req('POST', '/api/policy', { raw: JSON.stringify({ list: 'blacklist', name: 'a'.repeat(200000) }), headers: H }).catch(() => ({ status: 0 }));
  assert.ok(r.status === 413 || r.status === 0);
});
test('security: invalid JSON rejected', async () => {
  assert.strictEqual((await req('POST', '/api/policy', { raw: '{nope', headers: H })).status, 400);
});
test('security: kill requires confirm and snapshot membership', async () => {
  assert.strictEqual((await mut('POST', '/api/process/kill', { pid: 1234, name: 'x', path: '' })).status, 400);
  assert.strictEqual((await mut('POST', '/api/process/kill', { pid: 1234, name: 'ghost', path: '', confirm: true })).status, 409);
  assert.strictEqual((await mut('POST', '/api/process/kill', { pid: 4, name: 'System', confirm: true })).status, 400);
});
test('security: missing scripts give 501, not a crash', async () => {
  const p = (await get('/api/processes')).json.processes[0];
  const r = await mut('POST', '/api/process/kill', { pid: p.pid, name: p.name, path: p.path, confirm: true });
  assert.strictEqual(r.status, 501);
  assert.strictEqual((await mut('POST', '/api/ai/key', { key: 'A'.repeat(39) })).status, 501);
});
test('security: recycle only known candidate paths', async () => {
  const r = await mut('POST', '/api/files/recycle', { path: 'C:\\Windows\\System32\\kernel32.dll', confirm: true });
  assert.strictEqual(r.status, 403);
});

test('api: overview shape', async () => {
  const j = (await get('/api/overview')).json;
  assert.ok(j.daily && j.metrics.length >= 1 && j.next.daily && j.safety && j.ai && typeof j.openRecommendations === 'number');
});
test('api: metrics ranges', async () => {
  assert.ok((await get('/api/metrics?range=7')).json.length <= 8);
  assert.strictEqual((await get('/api/metrics?range=all')).json.length, 20);
  assert.strictEqual((await get('/api/metrics?range=5')).status, 400);
});
test('api: processes + history', async () => {
  const j = (await get('/api/processes')).json;
  assert.ok(j.processes.length > 10);
  const h = (await get('/api/processes/history?name=chrome')).json;
  assert.ok(Array.isArray(h.appearances) && Array.isArray(h.actions));
});
test('api: actions filters', async () => {
  const all = (await get('/api/actions?limit=50')).json;
  assert.ok(all.length === 50 && all[0].ts >= all[1].ts);
  const errs = (await get('/api/actions?severity=error')).json;
  assert.ok(errs.length > 0 && errs.every((a) => a.severity === 'error'));
});
test('api: recommendations status update logs action', async () => {
  const rec = (await get('/api/recommendations?status=open')).json.items[0];
  assert.strictEqual((await mut('POST', `/api/recommendations/${rec.id}/status`, { status: 'bogus' })).status, 400);
  const r = await mut('POST', `/api/recommendations/${rec.id}/status`, { status: 'ignored' });
  assert.strictEqual(r.json.status, 'ignored');
  const last = (await get('/api/actions?q=recommendation.status&limit=1')).json[0];
  assert.strictEqual(last.actor, 'user');
});
test('api: config validation', async () => {
  assert.strictEqual((await mut('PUT', '/api/config', { schedule: { daily: { time: '25:00' } } })).status, 400);
  assert.strictEqual((await mut('PUT', '/api/config', { bogus: 1 })).status, 400);
  assert.strictEqual((await mut('PUT', '/api/config', { ai: { model: 5 } })).status, 400);
  const ok = await mut('PUT', '/api/config', { safety: { safeMode: true } });
  assert.strictEqual(ok.json.safety.safeMode, true);
  assert.strictEqual((await get('/api/config')).json.safety.safeMode, true);
});
test('api: config never exposes key material', async () => {
  const t = (await get('/api/config')).text;
  assert.ok(!/AIza|apiKey|api_key/i.test(t));
});
test('policy: blacklist/whitelist CRUD and mutual exclusion', async () => {
  const add = await mut('POST', '/api/policy', { list: 'blacklist', name: 'Foo.exe', reason: 'test' });
  assert.strictEqual(add.status, 200); assert.strictEqual(add.json.name, 'Foo'); assert.strictEqual(add.json.action, 'terminate');
  let pol = (await get('/api/policy')).json;
  assert.ok(pol.blacklist.some((e) => e.name === 'Foo'));
  await mut('POST', '/api/policy', { list: 'whitelist', name: 'foo' });
  pol = (await get('/api/policy')).json;
  assert.ok(!pol.blacklist.some((e) => e.name === 'Foo') && pol.whitelist.some((e) => e.name.toLowerCase() === 'foo'));
  const wl = pol.whitelist.find((e) => e.name.toLowerCase() === 'foo');
  const patched = await mut('PATCH', `/api/policy/whitelist/${wl.id}`, { enabled: false });
  assert.strictEqual(patched.json.enabled, false);
  assert.strictEqual((await mut('DELETE', `/api/policy/whitelist/${wl.id}`)).status, 200);
  assert.strictEqual((await mut('DELETE', `/api/policy/whitelist/${wl.id}`)).status, 404);
  assert.strictEqual((await mut('POST', '/api/policy', { list: 'blacklist', name: 'a\\b' })).status, 400);
  assert.strictEqual((await mut('POST', '/api/policy', { list: 'nope', name: 'a' })).status, 400);
});
test('reports: list, read, html, export, delete', async () => {
  const list = (await get('/api/reports?type=daily')).json;
  assert.strictEqual(list.length, 20);
  const id = list[list.length - 1].id;
  const rep = (await get(`/api/reports/daily/${id}`)).json;
  assert.strictEqual(rep.schema, 'guardian.report/1');
  const html = await get(`/api/reports/daily/${id}/html`);
  assert.match(html.headers['content-security-policy'], /sandbox/);
  const csv = await get(`/api/reports/export?type=daily&id=${id}&format=csv`);
  assert.match(csv.text, /^key,value/);
  assert.strictEqual((await mut('DELETE', `/api/reports/daily/${id}`)).status, 200);
  assert.strictEqual((await get(`/api/reports/daily/${id}`)).status, 404);
  assert.strictEqual((await get('/api/reports?type=daily')).json.length, 19);
  assert.ok((await get('/api/reports?type=weekly')).json.length >= 2);
});
test('files: ignore overlay', async () => {
  const f = (await get('/api/files')).json.candidates[0];
  await mut('POST', '/api/files/ignore', { id: f.id });
  assert.strictEqual((await get('/api/files')).json.candidates[0].ignored, true);
});
test('schedule: PUT validates then degrades gracefully without Scheduler.ps1', async () => {
  assert.strictEqual((await mut('PUT', '/api/schedule', { daily: { time: 'noon' } })).status, 400);
  const r = await mut('PUT', '/api/schedule', { daily: { time: '20:30' } });
  assert.strictEqual(r.json.saved, true); assert.strictEqual(r.json.registered, false);
});
test('util: atomic write, tail with corrupt lines, nextRun', () => {
  const f = path.join(root, 'x', 'a.json'); U.writeJsonAtomic(f, { a: 1 });
  assert.deepStrictEqual(U.readJson(f), { a: 1 });
  const j = path.join(root, 'x', 'l.jsonl'); fs.writeFileSync(j, '{"a":1}\nCORRUPT\n{"a":2}\n');
  assert.deepStrictEqual(U.tailJsonl(j, 10).map((r) => r.a), [1, 2]);
  const n = new Date(U.nextRun('19:00', null, new Date('2026-10-03T20:00:00')));
  assert.strictEqual(n.getDate(), 4);
  const s = new Date(U.nextRun('02:00', 'Saturday', new Date('2026-10-03T03:00:00'))); // Saturday past 2am -> next week
  assert.strictEqual(s.getDay(), 6); assert.strictEqual(s.getDate(), 10);
});
