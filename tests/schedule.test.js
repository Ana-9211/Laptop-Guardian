'use strict';
// Bridge-side schedule handling: saving settings must never silently downgrade elevated tasks, and the
// Task Scheduler cache must stay honest. Uses a fake PowerShell runner: no real task is read or changed.
const test = require('node:test');
const assert = require('node:assert');
const { startBridge, fakeRunner, task, weeklyTask, sleep } = require('./lib/harness');
const S = require('../src/bridge/lib/status');

const newSchedule = (over = {}) => ({ daily: { enabled: true, time: '20:15' }, weekly: { enabled: true, day: 'Saturday', time: '02:00', shutdownTime: '05:00', shutdownEnabled: true }, ...over });
const registerOk = (extra = {}) => () => ({ ok: true, data: { ok: true, message: 'Tasks updated (daily updated)', needsElevation: false, report: [{ kind: 'daily', outcome: 'updated' }], tasks: [task({ runLevel: 'Limited', time: '20:15' })], ...extra } });

test('saving an unchanged schedule does not touch Task Scheduler at all', async () => {
  const ps = fakeRunner({ 'Scheduler.ps1': () => ({ ok: true, data: { tasks: [task({})] } }) });
  const b = await startBridge({ ps });
  try {
    const cur = b.readConfig().schedule;
    const r = await b.put('/api/schedule', cur);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.changed, false);
    assert.strictEqual(r.json.registered, false);
    assert.ok(!ps.calls.some((c) => c.args.includes('Register')), 'Register was never invoked');
  } finally { b.close(); }
});

test('a changed schedule registers once, never asks for elevation, and refreshes the cache from the result', async () => {
  const ps = fakeRunner({ 'Scheduler.ps1': (args) => (args.includes('Register') ? registerOk()() : { ok: true, data: { tasks: [task({})] } }) });
  const b = await startBridge({ ps });
  try {
    const r = await b.put('/api/schedule', newSchedule());
    assert.strictEqual(r.json.changed, true);
    assert.strictEqual(r.json.registered, true);
    assert.strictEqual(r.json.needsElevation, false);
    const reg = ps.calls.filter((c) => c.args.includes('Register'));
    assert.strictEqual(reg.length, 1);
    assert.ok(!reg[0].args.includes('-Elevate'), 'a plain save never requests UAC');
    assert.strictEqual(b.readConfig().schedule.daily.time, '20:15');
    const before = ps.calls.length;
    const st = (await b.get('/api/status')).json;
    assert.strictEqual(st.schedule.tasks[0].runLevel, 'Limited', 'status shows the rows returned by Register');
    assert.strictEqual(ps.calls.length, before, 'no extra Task Scheduler read was needed');
  } finally { b.close(); }
});

test('when the script keeps an elevated task unchanged, the response says elevation is needed (settings are still saved)', async () => {
  const ps = fakeRunner({ 'Scheduler.ps1': (args) => (args.includes('Register')
    ? { ok: true, data: { ok: true, needsElevation: true, message: 'Elevated tasks were left unchanged.', report: [{ kind: 'daily', outcome: 'elevation-required' }], tasks: [task({ time: '19:00', trigger: '2026-10-05T19:00:00+05:30' })] } }
    : { ok: true, data: { tasks: [task({})] } }) });
  const b = await startBridge({ ps });
  try {
    const r = await b.put('/api/schedule', newSchedule());
    assert.strictEqual(r.json.needsElevation, true);
    assert.strictEqual(r.json.registered, true, 'the script itself succeeded');
    assert.strictEqual(b.readConfig().schedule.daily.time, '20:15', 'the saved setting is kept');
    const st = (await b.get('/api/status')).json;
    const daily = st.schedule.tasks.find((t) => t.kind === 'daily');
    assert.strictEqual(daily.runLevel, 'Highest', 'the elevated task is still elevated');
    assert.strictEqual(daily.repair.needed, true);
    assert.strictEqual(daily.repair.requiresElevation, true);
  } finally { b.close(); }
});

test('explicit elevation sends exactly one fixed -Elevate Register request and shows a pending state', async () => {
  const ps = fakeRunner({ 'Scheduler.ps1': (args) => (args.includes('-Elevate')
    ? { ok: true, data: { ok: true, elevationRequested: true, message: 'Windows is asking for administrator permission.', tasks: [] } }
    : { ok: true, data: { tasks: [task({ time: '18:00', trigger: '2026-10-05T18:00:00+05:30' })] } }) });
  const b = await startBridge({ ps });
  try {
    await b.get('/api/status?fresh=1');
    const r = await b.post('/api/schedule/apply', { elevate: true });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.elevationRequested, true);
    const el = ps.calls.filter((c) => c.args.includes('-Elevate'));
    assert.strictEqual(el.length, 1);
    assert.deepStrictEqual(el[0].args, ['-Action', 'Register', '-Json', '-Elevate']);
    const st = (await b.get('/api/status')).json;
    assert.ok(st.schedule.elevationPending, 'UI can show "waiting for administrator approval"');
  } finally { b.close(); }
});

test('declining UAC changes nothing and reports it', async () => {
  const ps = fakeRunner({ 'Scheduler.ps1': (args) => (args.includes('-Elevate')
    ? { ok: true, data: { ok: false, elevationRequested: false, message: 'Administrator permission was not granted, so the tasks were not changed.' } }
    : { ok: true, data: { tasks: [task({})] } }) });
  const b = await startBridge({ ps });
  try {
    const r = await b.post('/api/schedule/apply', { elevate: true });
    assert.strictEqual(r.json.elevationRequested, false);
    assert.strictEqual(r.json.registered, false);
    assert.match(r.json.message, /not granted/);
    assert.strictEqual((await b.get('/api/status')).json.schedule.elevationPending, null);
    const log = (await b.get('/api/actions?limit=5')).json;
    assert.ok(log.some((a) => a.action === 'schedule.elevate' && a.result === 'failure'));
  } finally { b.close(); }
});

test('apply rejects non-boolean elevate and refuses a second concurrent change', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const ps = fakeRunner({ 'Scheduler.ps1': async (args) => { if (args.includes('Register')) await gate; return { ok: true, data: { ok: true, tasks: [task({})], report: [] } }; } });
  const b = await startBridge({ ps });
  try {
    assert.strictEqual((await b.post('/api/schedule/apply', { elevate: 'yes' })).status, 400);
    const first = b.post('/api/schedule/apply', {});
    await sleep(100);
    assert.strictEqual((await b.post('/api/schedule/apply', {})).status, 409);
    release(); assert.strictEqual((await first).status, 200);
  } finally { b.close(); }
});

test('a failing scheduler is reported honestly: error is surfaced and no fake "fetched just now"', async () => {
  const ps = fakeRunner({ 'Scheduler.ps1': () => ({ ok: false, error: 'access denied' }) });
  const b = await startBridge({ ps });
  try {
    const st = (await b.get('/api/status?fresh=1')).json;
    assert.strictEqual(st.schedule.error, 'access denied');
    assert.strictEqual(st.schedule.fetchedAt, null, 'nothing was ever read successfully');
    assert.strictEqual(st.schedule.level, 'warn');
  } finally { b.close(); }
});

test('after one good read, a later failure keeps the old rows and the old read time', async () => {
  let n = 0;
  const ps = fakeRunner({ 'Scheduler.ps1': () => (++n === 1 ? { ok: true, data: { tasks: [task({})] } } : { ok: false, error: 'timed out' }) });
  const b = await startBridge({ ps });
  try {
    const good = (await b.get('/api/status?fresh=1')).json;
    assert.ok(good.schedule.fetchedAt);
    const bad = (await b.get('/api/status?fresh=1')).json;
    assert.strictEqual(bad.schedule.error, 'timed out');
    assert.strictEqual(bad.schedule.tasks.length, 1);
    assert.strictEqual(bad.schedule.fetchedAt, good.schedule.fetchedAt);
  } finally { b.close(); }
});

test('a Task Scheduler read that started before a schedule change is discarded and re-read', async () => {
  let release; const gate = new Promise((r) => { release = r; });
  let reads = 0;
  const ps = fakeRunner({ 'Scheduler.ps1': async (args) => {
    if (args.includes('Register')) return { ok: true, data: { ok: true, report: [], tasks: [] } }; // empty rows: forces the next read
    reads++;
    if (reads === 1) { await gate; return { ok: true, data: { tasks: [task({ time: '18:00', trigger: '2026-10-05T18:00:00+05:30' })] } }; }
    return { ok: true, data: { tasks: [task({ time: '20:15', trigger: '2026-10-05T20:15:00+05:30' })] } };
  } });
  const b = await startBridge({ ps });
  try {
    const stale = b.get('/api/status?fresh=1');                 // first read starts and blocks on the gate
    await sleep(100);
    await b.put('/api/schedule', newSchedule());                 // schedule changes while that read is in flight
    release();
    const st = (await stale).json;
    assert.strictEqual(st.schedule.tasks[0].trigger.slice(11, 16), '20:15', 'the pre-change read was discarded');
  } finally { b.close(); }
});

test('ping identifies the installation root so a launcher can verify ownership', async () => {
  const b = await startBridge({ ps: fakeRunner() });
  try {
    const p = (await b.get('/api/ping')).json;
    assert.strictEqual(p.app, 'laptop-guardian');
    assert.strictEqual(p.root, b.root);
  } finally { b.close(); }
});

test('task assessment flags a Daily task without -Scheduled and marks the repair as needing elevation when elevated', () => {
  const cfg = { schedule: { daily: { enabled: true, time: '19:00' }, weekly: { enabled: true, day: 'Saturday', time: '02:00' } } };
  const [d] = S.assessTasks([task({ scheduledFlag: false })], cfg);
  assert.ok(d.issues.some((i) => /Daily task was registered without -Scheduled/.test(i)));
  assert.deepStrictEqual(d.repair, { needed: true, requiresElevation: true });
  const [ok] = S.assessTasks([task({}), weeklyTask({})].slice(0, 1), cfg);
  assert.deepStrictEqual(ok.repair, { needed: false, requiresElevation: false });
  const [limited] = S.assessTasks([task({ runLevel: 'Limited', scheduledFlag: true })], cfg);
  assert.deepStrictEqual(limited.repair, { needed: true, requiresElevation: true }, 'raising a standard task to administrator also needs UAC');
  const [std] = S.assessTasks([task({ runLevel: 'Limited', time: '18:00', trigger: '2026-10-05T18:00:00+05:30' })], cfg);
  assert.strictEqual(std.repair.needed, true);
  const [other] = S.assessTasks([task({ scriptCurrent: false })], cfg);
  assert.ok(other.issues.some((i) => /different Guardian installation/.test(i)));
});
