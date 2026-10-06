'use strict';
// The actions added for "an action for every finding": catalog schema, the bridge-handled ones, typed confirmation, path rules.
process.env.USERPROFILE = 'C:\\Users\\u';
process.env.SystemDrive = 'C:';
process.env.LOCALAPPDATA = 'C:\\Users\\u\\AppData\\Local';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startBridge, fakeRunner } = require('./lib/harness');
const R = require('../src/bridge/lib/remediation');
const P = require('../src/bridge/lib/protected');
const CAT = require('../src/shared/action-catalog.json');

const NEW_IDS = ['scan.run-now', 'scan.queue-next-run', 'scan.schedule-once', 'scan.cancel-once', 'setup.register-tasks', 'setup.enable-safe-defaults', 'setup.enable-dns-log', 'setup.enable-firewall-audit', 'setup.disable-firewall-audit', 'defender.enable-realtime', 'system.run-windows-update-scan', 'system.open-settings', 'service.stop', 'service.start', 'storage.clean-temp', 'cleanup.empty-recycle-bin', 'file.delete-permanent'];

test('catalog schema: every action has risk, admin mode, summary, consequences, undo and a verify step; params are typed; undo ids exist', () => {
  const ids = new Set(CAT.actions.map((a) => a.id));
  assert.strictEqual(ids.size, CAT.actions.length, 'ids are unique');
  for (const a of CAT.actions) {
    assert.ok(['LOW', 'MEDIUM', 'HIGH'].includes(a.risk), `${a.id}: risk`);
    assert.ok([true, false, 'dynamic'].includes(a.admin), `${a.id}: admin must be true, false or "dynamic"`);
    for (const k of ['label', 'summary', 'consequences', 'undo', 'verify', 'category']) assert.ok(typeof a[k] === 'string' && a[k].length >= 4, `${a.id}: ${k}`);
    assert.strictEqual(typeof a.reversible, 'boolean', `${a.id}: reversible`);
    for (const [name, def] of Object.entries(a.params || {})) {
      assert.ok(def.enum || (def.pattern && CAT.patterns[def.pattern]), `${a.id}.${name}: needs an enum or a known pattern`);
      assert.ok(!/^(command|script|args|arguments|cmd|shell|expression|exe|executable)$/i.test(name), `${a.id}.${name}: no command-carrying parameter`);
    }
    if (a.undoId) assert.ok(ids.has(a.undoId), `${a.id}: undoId ${a.undoId}`);
    for (const m of String(a.summary).matchAll(/\{(\w+)\}/g)) assert.ok(a.params && a.params[m[1]], `${a.id}: summary placeholder {${m[1]}} is not a parameter`);
  }
  for (const id of NEW_IDS) assert.ok(ids.has(id), `${id} is in the catalog`);
});

test('every catalog action is either bridge-handled or dispatched by PowerShell', () => {
  const dispatch = fs.readFileSync(path.join(__dirname, '..', 'src', 'powershell', 'Actions', 'Remediation', 'Dispatch.ps1'), 'utf8');
  for (const a of CAT.actions) {
    if (a.handler === 'bridge') continue;
    const inRem = dispatch.includes(`'${a.id}' {`);
    assert.ok(inRem, `${a.id} has no PowerShell handler`);
  }
});

function engine(over = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-rem2-'));
  const logged = [];
  const state = { safe: false, queued: null, running: null, launches: [], safeSets: [] };
  const eng = R.createRemediation({
    root, ps: over.ps || fakeRunner({}), log: (e) => { logged.push({ id: `a_${logged.length}`, ts: new Date().toISOString(), ...e }); }, tailJsonl: () => logged,
    readJson: () => null, config: () => ({ storage: { protectedDirs: ['D:\\Private'] }, safety: { safeMode: state.safe } }),
    applySchedule: over.applySchedule || (async () => ({ registered: true, needsElevation: false, message: 'registered', report: [] })),
    assessedTasks: over.assessedTasks || (() => []),
    currentRun: () => ({ running: state.running }), sleep: async () => {},
    launchScan: (kind, args) => { state.launches.push({ kind, args }); if (over.launchThrows) throw new Error('already running'); if (over.becomesRunning !== false) state.running = { type: kind.toLowerCase() }; return { started: true }; },
    queuedRun: () => state.queued, queueNextRun: (k) => { state.queued = { kind: k === 'nearest' ? 'daily' : k, full: true, queuedAt: 'now' }; return state.queued; },
    setSafeMode: (v) => { state.safe = v; state.safeSets.push(v); },
    cleanupRoots: () => ['C:\\Users\\u\\AppData\\Local\\Temp', 'C:\\Users\\u\\AppData\\Local\\CrashDumps'],
  });
  return { eng, state, logged, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('scan.run-now: plans without running, starts the right script, never lets a weekly run shut down, and verifies it shows as running', async () => {
  const { eng, state, done } = engine();
  try {
    const plan = await eng.plan('scan.run-now', { kind: 'weekly' });
    assert.strictEqual(plan.adminRequired, false);
    assert.strictEqual(state.launches.length, 0, 'planning starts nothing');
    const r = await eng.execute(plan.token, { confirm: true });
    assert.deepStrictEqual(state.launches, [{ kind: 'Weekly', args: ['-NoShutdown'] }]);
    assert.strictEqual(r.status, 'done');
    assert.strictEqual(r.result.verified, true);
    const d = await eng.plan('scan.run-now', { kind: 'daily' }).catch((e) => e);
    assert.strictEqual(d.status, 409, 'refused while a run is in progress');
  } finally { done(); }
});

test('scan.run-now: reports honestly when the start fails or never shows as running', async () => {
  const a = engine({ launchThrows: true });
  try { const p = await a.eng.plan('scan.run-now', { kind: 'daily' }); const r = await a.eng.execute(p.token, { confirm: true }); assert.strictEqual(r.status, 'failed'); assert.match(r.result.message, /already running/); } finally { a.done(); }
  const b = engine({ becomesRunning: false });
  try { const p = await b.eng.plan('scan.run-now', { kind: 'daily' }); const r = await b.eng.execute(p.token, { confirm: true }); assert.strictEqual(r.status, 'done-unverified'); } finally { b.done(); }
});

test('scan.queue-next-run and setup.enable-safe-defaults: refuse a no-op, change exactly one thing and read it back', async () => {
  const { eng, state, done } = engine();
  try {
    const q = await eng.plan('scan.queue-next-run', { kind: 'nearest' });
    const r = await eng.execute(q.token, { confirm: true });
    assert.strictEqual(r.status, 'done'); assert.strictEqual(state.queued.kind, 'daily');
    await assert.rejects(eng.plan('scan.queue-next-run', { kind: 'weekly' }), (e) => e.status === 409);
    await assert.rejects(eng.plan('scan.queue-next-run', { kind: 'bogus' }), (e) => e.status === 400);
    const s = await eng.plan('setup.enable-safe-defaults', {});
    assert.strictEqual((await eng.execute(s.token, { confirm: true })).status, 'done');
    assert.deepStrictEqual(state.safeSets, [true]);
    await assert.rejects(eng.plan('setup.enable-safe-defaults', {}), (e) => e.status === 409);
  } finally { done(); }
});

test('setup.register-tasks: only offered when something is missing; asks for the repair path when administrator tasks are involved', async () => {
  const none = engine({ assessedTasks: () => [{ status: 'ok', repair: { needed: false } }] });
  try { await assert.rejects(none.eng.plan('setup.register-tasks', {}), (e) => e.status === 409); } finally { none.done(); }
  const some = engine({ assessedTasks: () => [{ status: 'missing', repair: { needed: false } }] });
  try { const p = await some.eng.plan('setup.register-tasks', {}); assert.strictEqual((await some.eng.execute(p.token, { confirm: true })).status, 'done'); } finally { some.done(); }
  const adm = engine({ assessedTasks: () => [{ status: 'missing', repair: { needed: false } }], applySchedule: async () => ({ registered: false, needsElevation: true, message: 'needs permission', report: [] }) });
  try { const p = await adm.eng.plan('setup.register-tasks', {}); const r = await adm.eng.execute(p.token, { confirm: true }); assert.strictEqual(r.status, 'failed'); assert.match(r.result.message, /Repair schedule/); } finally { adm.done(); }
});

test('file.delete-permanent: needs the exact file name typed, and is refused outside the Recycle Bin and cleanup locations', async () => {
  const ps = fakeRunner({ 'Actions/Invoke-GuardianAction.ps1': (args) => ({ ok: true, data: { ok: true, verified: args.includes('Execute'), identityKey: 'k', details: {}, errors: [], needsAdmin: false } }) });
  const { eng, done } = engine({ ps });
  try {
    const file = 'C:\\Users\\u\\AppData\\Local\\Temp\\big-installer.tmp';
    const plan = await eng.plan('file.delete-permanent', { path: file });
    assert.strictEqual(plan.typedConfirmation, 'big-installer.tmp');
    await assert.rejects(eng.execute(plan.token, { confirm: true }), /Type the file name/);
    const plan2 = await eng.plan('file.delete-permanent', { path: file });
    await assert.rejects(eng.execute(plan2.token, { confirm: true, typed: 'big-installer' }), /Type the file name/);
    const plan3 = await eng.plan('file.delete-permanent', { path: file });
    assert.strictEqual((await eng.execute(plan3.token, { confirm: true, typed: 'big-installer.tmp' })).status, 'done');
    for (const bad of ['C:\\Users\\u\\Documents\\thesis.docx', 'C:\\Windows\\Temp\\x.tmp', 'D:\\Private\\x.tmp', 'C:\\Users\\u\\AppData\\Local\\Temp', 'relative.tmp']) {
      await assert.rejects(eng.plan('file.delete-permanent', { path: bad }), (e) => e.status === 403 || e.status === 400, bad);
    }
    await eng.plan('file.delete-permanent', { path: 'C:\\$Recycle.Bin\\S-1-5-21-1-2-3-1001\\$R1A2B3.txt' });
  } finally { done(); }
});

test('checkPermanentDeletePath: Recycle Bin and cleanup roots only; protected locations stay protected', () => {
  const o = { cleanupRoots: ['C:\\Users\\u\\AppData\\Local\\Temp'], protectedDirs: ['C:\\Users\\u\\AppData\\Local\\Temp\\keep'], guardianRoot: 'C:\\g' };
  assert.strictEqual(P.checkPermanentDeletePath('C:\\$Recycle.Bin\\S-1\\$R1.txt', o).location, 'recycle-bin');
  assert.strictEqual(P.checkPermanentDeletePath('C:\\Users\\u\\AppData\\Local\\Temp\\a.tmp', o).location, 'cleanup');
  assert.strictEqual(P.checkPermanentDeletePath('C:\\Users\\u\\AppData\\Local\\Temp\\keep\\a.tmp', o).protected, true);
  assert.strictEqual(P.checkPermanentDeletePath('C:\\Users\\u\\Documents\\a.docx', o).protected, true);
  assert.strictEqual(P.checkPermanentDeletePath('C:\\$Recycle.Bin', o).protected, true, 'the bin folder itself');
  assert.strictEqual(P.checkPermanentDeletePath('C:\\Users\\u\\AppData\\Local\\Temp\\*.tmp', o).protected, true);
});

test('service.stop needs the dependent-programs acknowledgement and refuses protected services in Node too', async () => {
  const ps = fakeRunner({ 'Actions/Invoke-GuardianAction.ps1': () => ({ ok: true, data: { ok: true, needsAdmin: true, identityKey: 'k', details: {}, errors: [] } }) });
  const { eng, done } = engine({ ps });
  try {
    await assert.rejects(eng.plan('service.stop', { name: 'WinDefend' }), (e) => e.status === 403);
    const p = await eng.plan('service.stop', { name: 'AcmeSync' });
    assert.deepStrictEqual(p.requiredAcks, ['dependent-programs']);
    await assert.rejects(eng.execute(p.token, { confirm: true }), /acknowledge/);
  } finally { done(); }
});

test('through the bridge: queue-next-run writes the marker file and setup.enable-safe-defaults saves the setting', async () => {
  const b = await startBridge({ ps: fakeRunner({}) });
  try {
    const cfg = b.readConfig(); cfg.safety.safeMode = false; fs.writeFileSync(path.join(b.root, 'config', 'config.json'), JSON.stringify(cfg));
    let r = await b.post('/api/remediation/plan', { actionId: 'setup.enable-safe-defaults', params: {} });
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    r = await b.post('/api/remediation/execute', { token: r.json.token, confirm: true });
    assert.strictEqual(r.json.status, 'done');
    assert.strictEqual(b.readConfig().safety.safeMode, true);
    r = await b.post('/api/remediation/plan', { actionId: 'scan.queue-next-run', params: { kind: 'daily' } });
    r = await b.post('/api/remediation/execute', { token: r.json.token, confirm: true });
    assert.strictEqual(r.json.status, 'done');
    const q = JSON.parse(fs.readFileSync(path.join(b.root, 'data', 'state', 'queued-run.json'), 'utf8'));
    assert.strictEqual(q.kind, 'daily'); assert.strictEqual(q.full, true);
    r = await b.post('/api/remediation/plan', { actionId: 'scan.queue-next-run', params: { kind: 'weekly' } });
    assert.strictEqual(r.status, 409);
    const log = await b.get('/api/remediation/history');
    assert.ok(log.json.items.some((i) => i.actionId === 'setup.enable-safe-defaults' && i.result === 'success'));
  } finally { b.close(); }
});
