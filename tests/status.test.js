'use strict';
// Live status endpoint, bridge identity, and the pure status helpers used by the dashboard's Refresh / attention features.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { makeFixtures } = require('./fixtures/make-fixtures');
const { createApp } = require('../src/bridge/server');
const U = require('../src/bridge/lib/util');
const S = require('../src/bridge/lib/status');
const cfg = U.DEFAULT_CONFIG;

let root; let app; let port;
const H = { 'X-Guardian': '1', 'Content-Type': 'application/json' };
function req(method, p, { body, headers = {}, host } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: host || `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Authorization: `Bearer ${app.token}`, ...headers } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, json, text }); });
    });
    r.on('error', reject); if (data !== undefined) r.write(data); r.end();
  });
}
const get = (p, o) => req('GET', p, o);
const mut = (m, p, body) => req(m, p, { body, headers: H });
const runStateFile = () => path.join(root, 'data', 'state', 'run-state.json');

test.before(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-status-'));
  makeFixtures(root, 20);
  app = createApp(root, { dist: path.join(root, 'dist') });
  fs.mkdirSync(path.join(root, 'dist'));
  fs.writeFileSync(path.join(root, 'dist', 'index.html'), '<!doctype html><title>x</title>');
  await new Promise((r) => app.listen_(0, (p) => { port = p; r(); }));
});
test.after(() => { app.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('ping identifies the bridge, enforces the Host allowlist, and a pid file is written', async () => {
  const r = await get('/api/ping');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.app, 'laptop-guardian');
  assert.strictEqual(r.json.port, port);
  assert.strictEqual(r.json.pid, process.pid);
  assert.strictEqual((await get('/api/ping', { host: 'evil.example.com' })).status, 403);
  assert.strictEqual(U.readJson(path.join(root, 'data', 'state', 'bridge.json')).pid, process.pid);
});

test('status aggregates run, reports, snapshots, schedule and attention; degrades without Scheduler.ps1', async () => {
  const r = await get('/api/status?fresh=1');
  assert.strictEqual(r.status, 200);
  const s = r.json;
  assert.strictEqual(s.bridge.ok, true);
  assert.strictEqual(typeof s.safety.safeMode, 'boolean');
  assert.ok(Array.isArray(s.attention));
  assert.ok(s.schedule.error, 'scheduler script is absent in the fixture root');
  assert.strictEqual(s.schedule.level, 'warn');
  assert.ok(s.reports.counts.daily >= 1);
  assert.strictEqual(s.shutdown.cancelCommand, 'shutdown /a');
  assert.ok(s.next.daily && s.next.weekly);
  assert.ok(!/apiKey|gemini\.dpapi|commandLine/i.test(JSON.stringify(s)), 'status leaks no secrets or command lines');
});

test('status is read-only and needs the Host allowlist', async () => {
  assert.strictEqual((await mut('POST', '/api/status', {})).status, 405);
  assert.strictEqual((await get('/api/status', { host: 'evil.example.com' })).status, 403);
});

test('a stale running marker (dead pid) is not a live scan and does not block a new one; a live one does', async () => {
  const rs = runStateFile(); const prev = fs.existsSync(rs) ? fs.readFileSync(rs, 'utf8') : null;
  try {
    fs.mkdirSync(path.dirname(rs), { recursive: true });
    fs.writeFileSync(rs, JSON.stringify({ running: { type: 'daily', phase: 'collecting', startedAt: U.localIso(), mode: 'manual', pid: 2147483000 } }));
    const s = (await get('/api/status')).json;
    assert.strictEqual(s.run.running, null);
    assert.strictEqual(s.run.stale.type, 'daily');
    assert.ok(s.attention.some((a) => a.id === 'stale-run'));
    fs.writeFileSync(rs, JSON.stringify({ running: { type: 'weekly', phase: 'analysis', startedAt: U.localIso(), mode: 'manual', shutdownPossible: false, pid: process.pid } }));
    const live = (await get('/api/status')).json;
    assert.strictEqual(live.run.running.type, 'weekly');
    assert.strictEqual(live.run.running.mode, 'manual');
    assert.ok(live.run.running.elapsedSec >= 0);
    assert.strictEqual((await mut('POST', '/api/scan/daily', {})).status, 409);
    assert.strictEqual((await mut('POST', '/api/scan/weekly', { noShutdown: false })).status, 409);
  } finally { if (prev === null) fs.rmSync(rs, { force: true }); else fs.writeFileSync(rs, prev); }
});

test('Task Scheduler result codes are translated; 0x41303 means "has not run yet"', () => {
  const never = S.describeResult(267011);
  assert.strictEqual(never.kind, 'never-run');
  assert.strictEqual(never.hex, '0x41303');
  assert.match(never.text, /not run yet/i);
  assert.strictEqual(S.describeResult(0).kind, 'success');
  assert.strictEqual(S.describeResult(-2147024894).hex, '0x80070002'); // signed HRESULT as PowerShell reports it
  assert.strictEqual(S.describeResult(267009).kind, 'running');
  assert.strictEqual(S.describeResult(null).kind, 'unknown');
});

const task = (o) => ({ name: 'Daily Audit', kind: 'daily', state: 'Ready', nextRun: '2026-10-06T19:00:00+05:30', lastRun: null, lastResult: 267011, runLevel: 'Highest', trigger: '2026-10-05T19:00:00+05:30', days: [], scheduledFlag: true, ...o });
const weekly = (o) => task({ kind: 'weekly', name: 'Weekly Deep Analysis', trigger: '2026-10-05T02:00:00+05:30', days: ['Saturday'], lastResult: 0, ...o });

test('a newly registered task that has not run is info, not a problem', () => {
  const [t] = S.assessTasks([task({})], cfg);
  assert.strictEqual(t.status, 'never-run');
  assert.strictEqual(t.level, 'info');
  assert.deepStrictEqual(t.issues, []);
  assert.ok(!S.buildAttention({ daily: null, tasks: [t], run: {}, openRecs: 0, highRiskRecs: 0, config: cfg }).some((a) => a.id === 'task-daily'));
});

test('missing, disabled, failed and misconfigured tasks are surfaced', () => {
  const rows = S.assessTasks([
    { name: 'Daily Audit', kind: 'daily', state: 'NotRegistered' },
    weekly({ state: 'Disabled' }),
    task({ name: 'Dashboard Bridge', kind: 'dashboard', lastResult: 1, trigger: null }),
  ], cfg);
  assert.strictEqual(rows[0].status, 'missing'); assert.strictEqual(rows[0].level, 'warn');
  assert.strictEqual(rows[1].status, 'disabled'); assert.strictEqual(rows[1].level, 'warn');
  assert.strictEqual(rows[2].status, 'failed'); assert.strictEqual(rows[2].level, 'crit');
  const [wrongTime] = S.assessTasks([task({ trigger: '2026-10-05T18:00:00+05:30', lastResult: 0 })], cfg);
  assert.match(wrongTime.issues[0], /trigger is 18:00/); assert.strictEqual(wrongTime.level, 'warn');
  const [noFlag] = S.assessTasks([weekly({ scheduledFlag: false })], cfg);
  assert.ok(noFlag.issues.some((i) => /-Scheduled/.test(i)));
  const [wrongDay] = S.assessTasks([weekly({ days: ['Monday'] })], cfg);
  assert.ok(wrongDay.issues.some((i) => /Monday/.test(i)));
  const [limited] = S.assessTasks([task({ runLevel: 'Limited', lastResult: 0 })], cfg);
  assert.ok(limited.issues.some((i) => /administrator/i.test(i)));
  const off = S.assessTasks([{ name: 'Daily Audit', kind: 'daily', state: 'NotRegistered' }], { ...cfg, schedule: { ...cfg.schedule, daily: { ...cfg.schedule.daily, enabled: false } } });
  assert.strictEqual(off[0].status, 'off');
});

test('run sanitising and pending shutdown', () => {
  const now = Date.parse('2026-10-10T03:00:00+05:30');
  const run = { running: { type: 'daily', pid: 1, startedAt: '2026-10-10T02:59:00+05:30' } };
  assert.strictEqual(S.sanitizeRun(run, () => false, now).running, null);
  assert.strictEqual(S.sanitizeRun(run, () => true, now).running.elapsedSec, 60);
  assert.strictEqual(S.sanitizeRun({ running: { type: 'daily', startedAt: '2026-10-09T01:00:00+05:30' } }, () => true, now).running, null, 'old marker without pid is stale');
  const ev = [{ action: 'shutdown:initiated', result: 'success', ts: '2026-10-10T02:58:00+05:30', reason: 'Windows shutdown scheduled in 600 s (cancel with: shutdown /a)' }];
  assert.ok(S.pendingShutdown(ev, now));
  assert.strictEqual(S.pendingShutdown(ev, Date.parse('2026-10-10T04:00:00+05:30')), null);
  assert.strictEqual(S.pendingShutdown([{ action: 'shutdown:skipped', result: 'skipped', ts: '2026-10-10T02:58:00+05:30' }], now), null);
});

test('Defender history of quarantined/removed items is info; unresolved threats are critical', () => {
  const mk = (statuses) => ({ generatedAt: new Date().toISOString(), status: 'complete', sections: { defender: { enabled: true, realTimeProtection: true, sigAgeDays: 0, threats: statuses.length, scan: { threats: statuses.map((s) => ({ name: 'x', status: s })) } } } });
  const handled = S.buildAttention({ daily: mk(['3', '3', '4']), tasks: [], run: {}, openRecs: 0, highRiskRecs: 0, config: cfg });
  assert.strictEqual(handled.find((a) => a.id === 'defender-history').level, 'info');
  assert.ok(!handled.some((a) => a.id === 'defender-threats'));
  const live = S.buildAttention({ daily: mk(['3', '1']), tasks: [], run: {}, openRecs: 0, highRiskRecs: 0, config: cfg });
  assert.strictEqual(live.find((a) => a.id === 'defender-threats').level, 'crit');
  assert.match(live.find((a) => a.id === 'defender-threats').title, /^1 unresolved/);
});

test('attention is prioritised: security first, then storage, then maintenance', () => {
  const daily = { generatedAt: new Date().toISOString(), status: 'complete', sections: { defender: { enabled: true, realTimeProtection: false, sigAgeDays: 5, threats: 0 }, system: { disks: [{ freePct: 5 }] } } };
  const tasks = S.assessTasks([{ name: 'Daily Audit', kind: 'daily', state: 'NotRegistered' }], cfg);
  const a = S.buildAttention({ daily, tasks, run: {}, openRecs: 2, highRiskRecs: 1, config: cfg });
  const ids = a.map((x) => x.id);
  assert.ok(ids.indexOf('defender-rt') < ids.indexOf('recs-high'));
  assert.ok(ids.indexOf('disk-crit') < ids.indexOf('task-daily'));
  assert.strictEqual(a[0].level, 'crit');
  assert.ok(a.every((x) => ['crit', 'warn', 'info'].includes(x.level)));
  assert.ok(!ids.includes('safe-off'), 'safe mode is on by default, so no warning about it');
});

test('polls never wait for Task Scheduler: cold start answers immediately with pending, then serves cached rows', async () => {
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-slow-'));
  fs.mkdirSync(path.join(r2, 'src', 'powershell'), { recursive: true });
  fs.writeFileSync(path.join(r2, 'src', 'powershell', 'Scheduler.ps1'), "Start-Sleep -Seconds 3; '{\"tasks\":[{\"name\":\"Daily Audit\",\"kind\":\"daily\",\"state\":\"Ready\",\"lastResult\":267011,\"runLevel\":\"Highest\",\"trigger\":\"2026-10-05T19:00:00+05:30\"}]}'");
  const a2 = createApp(r2, { pidFile: false });
  const p2 = await new Promise((res) => a2.listen_(0, res));
  const call = () => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: p2, path: '/api/status', headers: { Host: `127.0.0.1:${p2}`, Authorization: `Bearer ${a2.token}` } }, (x) => { let b = ''; x.on('data', (c) => b += c); x.on('end', () => resolve(JSON.parse(b))); }).on('error', reject));
  try {
    const t0 = Date.now(); const first = await call();
    assert.ok(Date.now() - t0 < 2000, 'status answered without waiting for the 3 s scheduler query');
    assert.strictEqual(first.schedule.pending, true);
    assert.strictEqual(first.schedule.level, 'info');
    await new Promise((r) => setTimeout(r, 6500));
    const later = await call();
    assert.strictEqual(later.schedule.pending, false);
    assert.strictEqual(later.schedule.tasks[0].status, 'never-run');
  } finally { a2.close(); fs.rmSync(r2, { recursive: true, force: true }); }
});
