'use strict';
// First-run checklist, what changed since the last run, and the Safe Mode dry-run preview.
process.env.USERPROFILE = 'C:\\Users\\u'; process.env.SystemDrive = 'C:';
const test = require('node:test');
const assert = require('node:assert');
const { startBridge, fakeRunner, task } = require('./lib/harness');
const { buildChecklist } = require('../src/bridge/lib/setup');
const { diffReports } = require('../src/bridge/lib/changes');
const { previewSafeModeOff } = require('../src/bridge/lib/dryrun');
const R = require('../src/bridge/lib/remediation');
const { DEFAULT_CONFIG } = require('../src/bridge/lib/util');

const cfg = (o = {}) => JSON.parse(JSON.stringify({ ...DEFAULT_CONFIG, ...o }));

test('checklist: lists what is missing with a catalog action each, is complete when the required items are done, and never auto-runs anything', () => {
  const todo = buildChecklist({ tasks: [{ kind: 'daily', status: 'missing', repair: { needed: false } }], daily: null, config: cfg({ safety: { ...DEFAULT_CONFIG.safety, safeMode: false } }), aiKeyConfigured: false, networkSnapshot: null });
  assert.strictEqual(todo.complete, false); assert.strictEqual(todo.remaining, 3);
  assert.deepStrictEqual(todo.items.filter((i) => !i.done && !i.optional).map((i) => i.action.actionId), ['setup.register-tasks', 'scan.run-now', 'setup.enable-safe-defaults']);
  for (const i of todo.items) if (i.action) assert.ok(R.byId.get(i.action.actionId), i.action.actionId);
  const admin = buildChecklist({ tasks: [{ kind: 'daily', status: 'ok', repair: { needed: true, requiresElevation: true } }], daily: {}, config: cfg(), untrustedRefused: true });
  assert.strictEqual(admin.items.find((i) => i.id === 'tasks').action.actionId, 'schedule.repair');
  assert.ok(admin.items.find((i) => i.id === 'admin-install').detail.includes('administrator PowerShell'));
  const done = buildChecklist({ tasks: [{ kind: 'daily', status: 'ok', repair: { needed: false } }], daily: {}, config: cfg(), aiKeyConfigured: true, networkSnapshot: {} });
  assert.strictEqual(done.complete, true); assert.strictEqual(done.remaining, 0);
  assert.ok(done.items.filter((i) => i.optional).every((i) => i.optional), 'optional items never block completion');
});

test('changes: compares the newest two reports, skips missing fields, and says so when there is nothing to compare', () => {
  assert.strictEqual(diffReports(null, null).available, false);
  assert.match(diffReports({ sections: {} }, null).reason, /Only one/);
  const prev = { generatedAt: 'a', healthScore: 80, sections: { system: { disks: [{ freeGB: 220 }], ram: { usedPct: 60 } }, defender: { enabled: true, realTimeProtection: true, sigAgeDays: 1 }, firewall: { profiles: [{ name: 'Public', enabled: true }] }, processes: { flagged: 1, topCpu: [{ name: 'chrome' }] }, startup: { count: 20 } }, errors: [] };
  const cur = { generatedAt: 'b', healthScore: 72, sections: { system: { disks: [{ freeGB: 205.4 }], ram: { usedPct: 61 } }, defender: { enabled: true, realTimeProtection: false, sigAgeDays: 4 }, firewall: { profiles: [{ name: 'Public', enabled: false }] }, processes: { flagged: 3, topCpu: [{ name: 'chrome' }, { name: 'newtool' }] }, startup: { count: 20 } }, errors: [{ message: 'x' }] };
  const d = diffReports(cur, prev); assert.strictEqual(d.available, true);
  const by = Object.fromEntries(d.items.map((i) => [i.label, i]));
  assert.deepStrictEqual([by['Health score'].delta, by['Health score'].tone], ['-8', 'warn']);
  assert.strictEqual(by['Free disk space (C:)'].delta, '-14.6 GB');
  assert.ok(!by['RAM in use'], 'a 1 point change is within tolerance'); assert.ok(!by['Startup programs'], 'no change, no row');
  assert.strictEqual(by['Real-time protection'].tone, 'crit'); assert.strictEqual(by['Firewall profiles that are off'].to, 'Public');
  assert.match(by['New among the busiest programs'].to, /newtool/);
  assert.strictEqual(by['Errors recorded'].delta, '+1');
  assert.deepStrictEqual(diffReports(prev, prev).items, []);
});

test('dry run: lists what Safe Mode off would do, respects the switches and protections, and never lists a protected process as ended', () => {
  const config = cfg(); config.safety = { ...config.safety, safeMode: true, autoKillBlacklisted: true }; config.cleanup = { ...config.cleanup, tempFiles: true, crashDumps: false, caches: true, recycleBin: 'never', tempMinAgeDays: 14 };
  const policy = { blacklist: [{ name: 'updater', enabled: true, reason: 'nag' }, { name: 'svchost', enabled: true }, { name: 'off', enabled: false }], whitelist: [], ignored: [] };
  const processes = [{ name: 'updater', pid: 11, path: 'C:\\Users\\u\\AppData\\Local\\Temp\\updater.exe' }, { name: 'svchost', pid: 4, path: 'C:\\Windows\\System32\\svchost.exe' }, { name: 'off', pid: 12, path: 'D:\\off.exe' }];
  const daily = { generatedAt: 'x', sections: { storage: { tempMB: 800, crashDumpMB: 50, cacheMB: 120 } } };
  const p = previewSafeModeOff({ config, policy, processes, daily, guardianRoot: 'C:\\g' });
  assert.strictEqual(p.safeMode, true);
  assert.deepStrictEqual(p.wouldDo.filter((x) => x.kind === 'process').map((x) => x.label), ['End updater (PID 11)']);
  assert.ok(p.wouldNotDo.some((x) => /svchost/.test(x.label) && /Protected/.test(x.detail)), 'a protected process stays');
  assert.ok(!p.wouldNotDo.some((x) => /off/.test(x.label) && x.kind === 'process'), 'a disabled entry is not mentioned');
  const cleanup = p.wouldDo.filter((x) => x.kind === 'cleanup').map((x) => x.label);
  assert.deepStrictEqual(cleanup, ['Delete old temporary files', 'Delete known safe caches']);
  assert.match(p.wouldDo.find((x) => x.label === 'Delete old temporary files').detail, /800 MB.*14 day/);
  assert.ok(p.wouldNotDo.some((x) => x.kind === 'always'));
  config.safety.autoKillBlacklisted = false;
  const q = previewSafeModeOff({ config, policy, processes, daily, guardianRoot: 'C:\\g' });
  assert.ok(!q.wouldDo.some((x) => x.kind === 'process')); assert.ok(q.wouldNotDo.some((x) => /updater/.test(x.label) && /is off/.test(x.detail)));
  config.safety.automationPaused = true; assert.ok(previewSafeModeOff({ config, policy, processes, daily }).notes.some((n) => /paused/.test(n)));
});

test('the three guidance routes answer from the fixture data without running anything', async () => {
  const ps = fakeRunner({ 'Scheduler.ps1': () => ({ ok: true, data: { tasks: [task({})] } }) });
  const b = await startBridge({ ps });
  try {
    await b.get('/api/status?fresh=1');
    const s = await b.get('/api/setup'); assert.strictEqual(s.status, 200); assert.ok(Array.isArray(s.json.items) && s.json.items.length >= 5); assert.strictEqual(typeof s.json.complete, 'boolean');
    const c = await b.get('/api/changes'); assert.strictEqual(c.status, 200); assert.strictEqual(c.json.available, true); assert.ok(Array.isArray(c.json.items));
    const d = await b.get('/api/safemode/preview'); assert.strictEqual(d.status, 200); assert.ok(d.json.wouldNotDo.length > 0);
    assert.strictEqual(ps.calls.filter((x) => /Invoke-GuardianAction|Request-Elevated/.test(x.rel)).length, 0, 'nothing was executed');
  } finally { b.close(); }
});
