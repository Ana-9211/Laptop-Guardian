'use strict';
// Retention and compaction of the JSONL files, with large synthetic fixtures in temp folders (nothing under data/ of this checkout is read).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../src/bridge/lib/compact');
const U = require('../src/bridge/lib/util');
const ND = require('../src/bridge/lib/netdeep');
const { runMaintenance } = require('../src/bridge/lib/maintenance');
const { startBridge, fakeRunner } = require('./lib/harness');

const DAY = 86400000;
const NOW = Date.parse('2026-10-07T12:00:00+05:30');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-compact-'));
const iso = (t) => U.localIso(new Date(t));
const count = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).length : 0);

function writeMetrics(file, days, perDay) {
  const lines = [];
  for (let d = days; d > 0; d--) for (let k = 0; k < perDay; k++) lines.push(JSON.stringify({ ts: iso(NOW - d * DAY + k * 60000), runType: 'daily', cpuPct: 10 + k, ramPct: 50, healthScore: 80 + (k % 5), flaggedCount: k, errorCount: 0 }));
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, lines.join('\n') + '\n');
  return lines.length;
}

test('metrics: 400 days x 50 rows keep 180 days raw, older rows become one summary per day, and a second run changes nothing', () => {
  const d = tmp(); const f = path.join(d, 'metrics.jsonl'); const s = path.join(d, 'metrics-daily.jsonl');
  try {
    const total = writeMetrics(f, 400, 50);
    const r = C.compactJsonl(f, { keepDays: 180, now: NOW, summarize: C.summarizeMetrics, summaryFile: s });
    assert.strictEqual(r.rolled + r.kept, total);
    assert.ok(r.days >= 219 && r.days <= 221, `days ${r.days}`);
    assert.strictEqual(count(s), r.days);
    const live = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(live.every((x) => Date.parse(x.ts) >= NOW - 180 * DAY));
    const sum = JSON.parse(fs.readFileSync(s, 'utf8').split('\n')[0]);
    assert.strictEqual(sum.runType, 'summary'); assert.strictEqual(sum.summaryOf, 50); assert.strictEqual(sum.cpuPct, 34.5); assert.strictEqual(sum.flaggedCount, 49);
    const before = fs.readFileSync(f, 'utf8'); const r2 = C.compactJsonl(f, { keepDays: 180, now: NOW, summarize: C.summarizeMetrics, summaryFile: s });
    assert.strictEqual(r2.rolled, 0); assert.strictEqual(fs.readFileSync(f, 'utf8'), before); assert.strictEqual(count(s), r.days);
    assert.ok(!fs.existsSync(`${f}.${process.pid}.compact.tmp`), 'no temp file is left');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('audit log: old rows move to monthly archives (nothing lost), unreadable lines stay, and the live file only holds recent rows', () => {
  const d = tmp(); const f = path.join(d, 'actions.jsonl');
  try {
    const rows = [];
    for (let i = 0; i < 6000; i++) rows.push(JSON.stringify({ id: 'a' + i, ts: iso(NOW - (i % 200) * DAY - i * 1000), category: i % 2 ? 'scan' : 'policy', severity: i % 50 === 0 ? 'error' : 'info', action: 'x' }));
    rows.sort((a, b) => Date.parse(JSON.parse(a).ts) - Date.parse(JSON.parse(b).ts));   // the log is append-only, so oldest first
    rows.splice(10, 0, '{torn line');
    fs.writeFileSync(f, rows.join('\n') + '\n');
    const r = C.compactJsonl(f, { keepDays: 90, now: NOW, summarize: C.summarizeActions, summaryFile: path.join(d, 'actions-daily.jsonl'), archiveDir: path.join(d, 'archive'), archivePrefix: 'actions' });
    const archived = fs.readdirSync(path.join(d, 'archive')).reduce((a, n) => a + count(path.join(d, 'archive', n)), 0);
    assert.strictEqual(archived, r.rolled);
    assert.strictEqual(count(f) + archived, 6001, 'every row is either live or archived');
    assert.ok(fs.readFileSync(f, 'utf8').includes('{torn line'), 'a row that cannot be read is kept, not dropped');
    assert.ok(fs.readdirSync(path.join(d, 'archive')).every((n) => /^actions-\d{4}-\d{2}\.jsonl$/.test(n)));
    const sums = fs.readFileSync(path.join(d, 'actions-daily.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.strictEqual(sums.reduce((a, s) => a + s.total, 0), r.rolled); assert.ok(sums.some((s) => s.errors > 0));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('compaction needs the lock: it refuses (and changes nothing) while another writer holds it, and appends are never lost around a run', () => {
  const d = tmp(); const f = path.join(d, 'm.jsonl');
  try {
    writeMetrics(f, 300, 2);
    const before = fs.readFileSync(f, 'utf8');
    fs.writeFileSync(`${f}.lock`, 'held');
    assert.throws(() => C.compactJsonl(f, { keepDays: 30, now: NOW, summarize: C.summarizeMetrics, summaryFile: path.join(d, 's.jsonl'), lockTimeoutMs: 200 }), /could not lock/);
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before);
    fs.rmSync(`${f}.lock`);
    // an append that happens right after the run lands in the new file
    C.compactJsonl(f, { keepDays: 30, now: NOW, summarize: C.summarizeMetrics, summaryFile: path.join(d, 's.jsonl') });
    U.withFileLock(f, () => U.appendJsonl(f, { ts: iso(NOW), runType: 'daily', cpuPct: 1 }));
    assert.ok(fs.readFileSync(f, 'utf8').trim().endsWith(`"cpuPct":1}`));
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('tailWithSummaries never reads more than the byte caps and returns old summaries before recent rows in time order', () => {
  const d = tmp(); const f = path.join(d, 'm.jsonl'); const s = path.join(d, 's.jsonl');
  try {
    writeMetrics(f, 400, 400);   // large live file (about 20 MB)
    C.compactJsonl(f, { keepDays: 365, now: NOW, summarize: C.summarizeMetrics, summaryFile: s });
    const size = fs.statSync(f).size; assert.ok(size > 8 * 1024 * 1024, `fixture is large (${size})`);
    const rows = C.tailWithSummaries(f, s, { maxBytes: 1024 * 1024 });
    assert.ok(rows.length > 100 && rows.length < 20000, `rows ${rows.length}`);
    const ts = rows.map((r) => Date.parse(r.ts)); assert.deepStrictEqual(ts, [...ts].sort((a, b) => a - b));
    assert.ok(rows.some((r) => r.runType === 'summary'), 'older history comes from summaries');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('maintenance rolls metrics and the audit log, skips while a scan runs, and logs what it did; a failure in one step does not stop the other', () => {
  const root = tmp(); const P = { metrics: path.join(root, 'metrics.jsonl'), metricsDaily: path.join(root, 'md.jsonl'), actions: path.join(root, 'a', 'actions.jsonl'), actionsDaily: path.join(root, 'a', 'ad.jsonl') };
  try {
    writeMetrics(P.metrics, 300, 3);
    fs.mkdirSync(path.dirname(P.actions), { recursive: true });
    fs.writeFileSync(P.actions, Array.from({ length: 300 }, (_, k) => 299 - k).map((i) => JSON.stringify({ id: 'x' + i, ts: iso(NOW - i * DAY), category: 'scan', severity: 'info' })).join('\n') + '\n');
    const logged = [];
    assert.deepStrictEqual(runMaintenance({ P, log: (e) => logged.push(e), now: NOW, running: true }), { skipped: 'a scan is running' });
    const out = runMaintenance({ P, log: (e) => logged.push(e), now: NOW });
    assert.ok(out.metrics.rolled > 0 && out.actions.rolled > 0);
    assert.strictEqual(logged[0].action, 'maintenance.compact');
    const bad = runMaintenance({ P: { ...P, metrics: path.join(root, 'nope', 'm.jsonl') }, log: (e) => logged.push(e), now: NOW });
    assert.deepStrictEqual(bad.metrics, { rolled: 0, kept: 0, days: 0 });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Deep Network Guard: expired day files are summarised before they are removed, and the size cap keeps only the newest bytes', () => {
  const root = tmp();
  try {
    const dir = path.join(root, 'data', 'network', 'deep'); fs.mkdirSync(dir, { recursive: true });
    const ev = (day, i) => JSON.stringify({ ts: `${day}T10:00:${String(i % 60).padStart(2, '0')}+05:30`, type: i % 3 ? 'open' : 'close', proto: 'TCP', remoteAddress: `203.0.113.${i % 4}`, pid: 5, process: i % 2 ? 'a.exe' : 'b.exe' });
    fs.writeFileSync(path.join(dir, 'events-2026-09-01.jsonl'), Array.from({ length: 30 }, (_, i) => ev('2026-09-01', i)).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'events-2026-10-06.jsonl'), Array.from({ length: 5000 }, (_, i) => ev('2026-10-06', i)).join('\n') + '\n');
    const deep = ND.createDeep({ root, getConfig: () => ({ network: { deep: { retentionDays: 7, maxMB: 0.05 } } }), log: () => {}, now: () => NOW, runNetstat: async () => '', runTasklist: async () => '' });
    deep.prune();
    assert.ok(!fs.existsSync(path.join(dir, 'events-2026-09-01.jsonl')));
    const sum = JSON.parse(fs.readFileSync(path.join(root, 'data', 'network', 'deep-daily.jsonl'), 'utf8').trim());
    assert.strictEqual(sum.day, '2026-09-01'); assert.strictEqual(sum.opens + sum.closes, 30); assert.ok(sum.topProcesses.length >= 1 && sum.topRemotes.length >= 1);
    const left = fs.readFileSync(path.join(dir, 'events-2026-10-06.jsonl'), 'utf8');
    assert.ok(Buffer.byteLength(left) <= 0.05 * 1024 * 1024); assert.ok(left.startsWith('{"ts"'), 'starts on a whole line');
    deep.prune(); assert.strictEqual(count(path.join(root, 'data', 'network', 'deep-daily.jsonl')), 1, 'summaries are not duplicated');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('bridge: /api/metrics and /api/overview answer from the live tail plus summaries, quickly, with a very large metrics file', async () => {
  const b = await startBridge({ ps: fakeRunner({}) });
  try {
    const f = path.join(b.root, 'data', 'metrics', 'metrics.jsonl');
    writeMetrics(f, 900, 120);   // about 100k rows
    const size = fs.statSync(f).size;
    b.app.maintenance(NOW + 0);
    assert.ok(fs.statSync(f).size < size, 'the live file shrank');
    const t0 = Date.now(); const m = await b.get('/api/metrics?range=all'); const o = await b.get('/api/overview');
    assert.ok(Date.now() - t0 < 5000, 'both answer quickly');
    assert.strictEqual(m.status, 200); assert.ok(m.json.some((r) => r.runType === 'summary')); assert.ok(m.json.length < 30000);
    assert.strictEqual(o.status, 200); assert.ok(Array.isArray(o.json.metrics));
  } finally { b.close(); }
});

test('retention settings: the windows come from the config, are clamped to 30-730 again in maintenance, and the audit log is archived, never deleted', () => {
  const root = tmp(); const P = { metrics: path.join(root, 'metrics.jsonl'), metricsDaily: path.join(root, 'md.jsonl'), actions: path.join(root, 'a', 'actions.jsonl'), actionsDaily: path.join(root, 'a', 'ad.jsonl') };
  try {
    writeMetrics(P.metrics, 400, 2);
    fs.mkdirSync(path.dirname(P.actions), { recursive: true });
    const rows = Array.from({ length: 400 }, (_, k) => 399 - k).map((i) => JSON.stringify({ id: 'x' + i, ts: iso(NOW - i * DAY), category: 'scan', severity: 'info' }));
    fs.writeFileSync(P.actions, rows.join('\n') + '\n');
    runMaintenance({ P, log: () => {}, now: NOW, retention: { metricsRawDays: 365, auditRawDays: 365 } });
    const liveDays = (f) => new Set(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).ts.slice(0, 10))).size;
    assert.ok(liveDays(P.metrics) >= 363 && liveDays(P.metrics) <= 366, 'metrics follow the 365 day setting');
    assert.ok(liveDays(P.actions) >= 363 && liveDays(P.actions) <= 366, 'audit rows follow the 365 day setting');
    // a hand-edited absurd value (1 day, or text) cannot shrink the window below 30 days or turn it into something else
    runMaintenance({ P, log: () => {}, now: NOW, retention: { metricsRawDays: 1, auditRawDays: 'soon' } });
    assert.ok(liveDays(P.metrics) >= 29 && liveDays(P.metrics) <= 31, 'clamped up to 30 days');
    assert.ok(liveDays(P.actions) >= 89 && liveDays(P.actions) <= 91, 'unusable text falls back to the 90 day default');
    const archived = fs.readdirSync(path.join(root, 'a', 'archive')).reduce((a, n) => a + count(path.join(root, 'a', 'archive', n)), 0);
    assert.strictEqual(count(P.actions) + archived, 400, 'every audit row still exists, live or archived');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('retention settings through the bridge: saved within 30-730, refused outside, defaults unchanged', async () => {
  const b = await startBridge({ ps: fakeRunner({}) });
  try {
    const c = await b.get('/api/config');
    assert.strictEqual(c.json.retention.metricsRawDays, 180); assert.strictEqual(c.json.retention.auditRawDays, 90);
    for (const bad of [{ metricsRawDays: 29 }, { metricsRawDays: 731 }, { auditRawDays: 5 }, { auditRawDays: 1e9 }, { auditRawDays: 'x' }]) {
      const r = await b.put('/api/config', { retention: bad }); assert.strictEqual(r.status, 400, JSON.stringify(bad));
    }
    const ok = await b.put('/api/config', { retention: { metricsRawDays: 365, auditRawDays: 30 } });
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.json)); assert.strictEqual(b.readConfig().retention.auditRawDays, 30);
  } finally { b.close(); }
});

test('Logs: archived audit rows are searched only on request, newest month first, within a byte cap, and marked archived', async () => {
  const b = await startBridge({ ps: fakeRunner({}) });
  try {
    const dir = path.join(b.root, 'data', 'actions', 'archive'); fs.mkdirSync(dir, { recursive: true });
    const row = (i, m) => JSON.stringify({ id: `old${m}${i}`, ts: `2025-${m}-10T10:00:${String(i % 60).padStart(2, '0')}+05:30`, category: 'policy', severity: 'info', action: 'policy.blacklist.add', target: i === 7 ? 'needle.exe' : `p${i}` });
    fs.writeFileSync(path.join(dir, 'actions-2025-03.jsonl'), Array.from({ length: 50 }, (_, i) => row(i, '03')).join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'actions-2025-04.jsonl'), Array.from({ length: 50 }, (_, i) => row(i, '04')).join('\n') + '\n');
    const live = await b.get('/api/actions?limit=2000&q=needle'); assert.strictEqual(live.json.filter((r) => r.archived).length, 0, 'not searched by default');
    const r = await b.get('/api/actions?limit=2000&q=needle&archived=1');
    assert.deepStrictEqual(r.json.filter((x) => x.archived).map((x) => x.id), ['old047', 'old037']);
    assert.ok(r.json.filter((x) => x.archived).every((x) => x.target === 'needle.exe'));
    // the cap: a huge archive month is read only up to 8 MB
    const big = path.join(dir, 'actions-2025-05.jsonl');
    const line = JSON.stringify({ id: 'b', ts: '2025-05-10T10:00:00+05:30', category: 'scan', severity: 'info', action: 'x', target: 'y'.repeat(900) }) + '\n';
    const fd = fs.openSync(big, 'w'); for (let i = 0; i < 12000; i++) fs.writeSync(fd, line); fs.closeSync(fd);
    assert.ok(fs.statSync(big).size > 10 * 1024 * 1024);
    const t0 = Date.now(); const cap = await b.get('/api/actions?limit=2000&archived=1'); assert.ok(Date.now() - t0 < 5000);
    assert.ok(cap.json.length <= 2000); assert.ok(cap.json.some((x) => x.archived));
  } finally { b.close(); }
});

test('firewall connection log CSV export: POST, formula-guarded, audited, and an honest error when the log cannot be read', async () => {
  const items = [{ ts: '2026-10-07T10:00:00+05:30', eventId: 5157, result: 'blocked', direction: 'outbound', protocol: 'TCP', pid: 9, application: '=HYPERLINK("http://x")', localAddress: '10.0.0.2', localPort: 50000, remoteAddress: '203.0.113.9', remotePort: 443 }, { ts: 't', eventId: 5156, result: 'allowed', direction: 'inbound', protocol: 'UDP', pid: 4, application: 'a,b', localAddress: '', localPort: 0, remoteAddress: '', remotePort: 0 }];
  let avail = true;
  const ps = fakeRunner({ 'Network/Get-FirewallEvents.ps1': () => ({ ok: true, data: avail ? { available: true, reason: null, items } : { available: false, reason: 'Reading the Security log needs administrator rights.', items: [] } }) });
  const b = await startBridge({ ps });
  try {
    const get = await b.get('/api/network/fw-events/export'); assert.strictEqual(get.status, 405, 'export is POST only');
    const r = await b.post('/api/network/fw-events/export', { hours: 6 });
    assert.strictEqual(r.status, 200); assert.match(r.text, /^ts,eventId,result,direction,protocol,pid,application,/);
    assert.ok(r.text.includes("'=HYPERLINK"), 'formula guard'); assert.ok(r.text.includes('"a,b"'), 'quoting');
    assert.deepStrictEqual(ps.calls.find((c) => c.rel === 'Network/Get-FirewallEvents.ps1').args, ['-Max', '2000', '-Hours', '6']);
    const log = await b.get('/api/actions?q=fwlog.export'); assert.strictEqual(log.json.length, 1);
    avail = false;
    const bad = await b.post('/api/network/fw-events/export', {}); assert.strictEqual(bad.status, 409); assert.match(bad.json.error, /administrator/);
  } finally { b.close(); }
});
