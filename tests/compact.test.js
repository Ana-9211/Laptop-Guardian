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
