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
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: host || `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Authorization: `Bearer ${app.token}`, ...headers } }, (res) => {
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
test('security: missing scripts give 501, not a crash', async () => {
  assert.strictEqual((await mut('POST', '/api/ai/key', { key: 'A'.repeat(39) })).status, 501);
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

test('api: malformed percent-encoding is a 400, not a 500', async () => {
  assert.strictEqual((await get('/%E0%A4%A')).status, 400);
  assert.strictEqual((await get('/api/reports/daily/%E0%A4%A')).status, 400);
});
test('config: numeric ranges and cross-field checks', async () => {
  for (const bad of [{ thresholds: { cpuPct: 0 } }, { thresholds: { memoryMB: 1 } }, { storage: { oldFileDays: 0 } }, { thresholds: { diskFreeCritPct: 20, diskFreeWarnPct: 10 } }]) assert.strictEqual((await mut('PUT', '/api/config', bad)).status, 400, JSON.stringify(bad));
  assert.strictEqual((await mut('PUT', '/api/config', { thresholds: { cpuPct: 60 } })).status, 200);
  await mut('PUT', '/api/config', { thresholds: { cpuPct: 50 } });
});
test('api: overview and status agree on the shutdown gate (automation paused hides it in both)', async () => {
  await mut('PUT', '/api/config', { safety: { automationPaused: true } });
  try {
    assert.strictEqual((await get('/api/overview')).json.next.shutdown, null);
    assert.strictEqual((await get('/api/status')).json.shutdown.armed, false);
  } finally { await mut('PUT', '/api/config', { safety: { automationPaused: false } }); }
});

test('auth: every /api route except ping needs the session token; static files and ping do not', async () => {
  const noTok = (p, extra = {}) => req('GET', p, { headers: { Authorization: '', ...extra } });
  assert.strictEqual((await noTok('/api/overview')).status, 401);
  assert.strictEqual((await noTok('/api/config')).status, 401);
  assert.strictEqual((await noTok('/api/overview', { Authorization: 'Bearer ' + 'a'.repeat(64) })).status, 401);
  assert.strictEqual((await noTok('/api/ping')).status, 200);
  assert.strictEqual((await noTok('/')).status, 200);
  assert.strictEqual((await get('/api/overview')).status, 200);
});
test('auth: cross-site fetch metadata is refused, headers carry resource/opener policy', async () => {
  const r = await req('GET', '/api/overview', { headers: { Authorization: `Bearer ${app.token}`, 'Sec-Fetch-Site': 'cross-site' } });
  assert.strictEqual(r.status, 403);
  const ok = await req('GET', '/api/overview', { headers: { Authorization: `Bearer ${app.token}`, 'Sec-Fetch-Site': 'same-origin' } });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.headers['cross-origin-resource-policy'], 'same-origin');
  assert.strictEqual(ok.headers['cross-origin-opener-policy'], 'same-origin');
});

test('config: changes that lower a safety margin need confirmation, are audited, and only then apply', async () => {
  const before = (await get('/api/config')).json;
  assert.strictEqual(before.safety.safeMode, true);
  const refused = await mut('PUT', '/api/config', { safety: { safeMode: false } });
  assert.strictEqual(refused.status, 409); assert.ok(refused.json.needsConfirmation.length >= 1);
  assert.strictEqual((await get('/api/config')).json.safety.safeMode, true, 'nothing changed');
  assert.strictEqual((await mut('PUT', '/api/config', { cleanup: { recycleBin: 'always' } })).status, 409);
  const ok = await mut('PUT', '/api/config', { safety: { safeMode: false }, _confirmRisky: true });
  assert.strictEqual(ok.status, 200);
  const acts = (await get('/api/actions?limit=20')).json;
  assert.ok(acts.some((a) => a.action === 'config.risky-refused') && acts.some((a) => a.action === 'config.risky-update'));
  assert.strictEqual((await mut('PUT', '/api/config', { safety: { safeMode: true } })).status, 200, 'turning protection back on never needs confirmation');
});

test('shutdown: cancel runs the fixed abort command once, is audited, and clears the pending banner', async () => {
  let calls = 0;
  const a = createApp(root, { pidFile: false, dist: path.join(root, 'dist'), abortShutdown: async () => { calls++; return { ok: true, text: '' }; } });
  const p = await new Promise((r) => a.listen_(0, r));
  const call = (m, u, body) => new Promise((resolve, reject) => { const d = body ? JSON.stringify(body) : undefined; const r = http.request({ host: '127.0.0.1', port: p, path: u, method: m, headers: { Host: `127.0.0.1:${p}`, Origin: `http://127.0.0.1:${p}`, Authorization: `Bearer ${a.token}`, 'X-Guardian': '1', 'Content-Type': 'application/json' } }, (res) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(t) })); }); r.on('error', reject); if (d) r.write(d); r.end(); });
  try {
    const r = await call('POST', '/api/shutdown/cancel', {});
    assert.strictEqual(r.status, 200); assert.strictEqual(r.json.cancelled, true); assert.strictEqual(calls, 1);
    const acts = (await call('GET', '/api/actions?limit=5')).json;
    assert.ok(acts.some((x) => x.action === 'shutdown:cancelled' && x.result === 'success'));
  } finally { a.close(); }
});
