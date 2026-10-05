'use strict';
// Remediation planning, confirmation, elevation and findings. A fake PowerShell runner stands in for the real scripts:
// nothing here stops a process, changes a service, task or firewall, recycles a file, or starts Revo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startBridge, fakeRunner } = require('./lib/harness');
const R = require('../src/bridge/lib/remediation');
const F = require('../src/bridge/lib/findings');
const P = require('../src/bridge/lib/protected');

const decode = (args) => JSON.parse(Buffer.from(args[args.indexOf('-ParamsB64') + 1], 'base64').toString('utf8'));
const argOf = (args, name) => args[args.indexOf(name) + 1];

/** Builds a remediation engine over a temp root with a scripted fake runner. */
function engine({ handlers = {}, now, events = [], tasks = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-rem-'));
  const logged = [...events];
  const ps = fakeRunner(handlers);
  const eng = R.createRemediation({
    root, ps, log: (e) => { logged.push({ id: `a_${logged.length}`, ts: new Date().toISOString(), ...e }); }, tailJsonl: () => logged,
    readJson: (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } }, config: () => ({ storage: { protectedDirs: ['D:\\Private'] } }),
    applySchedule: async ({ elevate }) => ({ registered: !elevate, elevationRequested: !!elevate, needsElevation: false, message: elevate ? 'prompt' : 'registered', report: [] }),
    assessedTasks: () => tasks, now,
  });
  return { eng, ps, root, logged, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const okValidate = (extra = {}) => ({ ok: true, data: { ok: true, needsAdmin: false, identityKey: 'k1', details: { x: 1 }, errors: [], ...extra } });
const stopParams = { pid: 4242, name: 'updater', path: 'C:\\Users\\u\\AppData\\Local\\Temp\\updater.exe', startTime: '2026-10-05T10:00:00' };

test('protected lists in Node are identical to the PowerShell lists', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'powershell', 'Common', 'Security.psm1'), 'utf8');
  const grab = (name) => {
    const m = new RegExp(`\\$script:${name} = @\\(([\\s\\S]*?)\\)`).exec(src);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1].toLowerCase());
  };
  assert.deepStrictEqual([...P.PROCESS_NAMES].sort(), [...new Set(grab('ProtectedProcessNames'))].sort());
  assert.deepStrictEqual([...P.SERVICE_NAMES].sort(), [...new Set(grab('ProtectedServiceNames'))].sort());
});

test('protected path rules refuse system locations, roots, wildcards and Guardian files', () => {
  const guardianRoot = 'C:\\Users\\u\\Documents\\LaptopGuardian';
  for (const p of ['C:\\Windows\\notepad.exe', 'C:\\Program Files\\X\\x.dll', 'C:\\ProgramData\\x.dat', 'C:', 'C:\\', 'C:\\Users\\u\\Documents\\LaptopGuardian\\data\\a.json', 'D:\\Private\\a.txt', 'relative.txt', '\\\\server\\share\\a.txt', 'C:\\Users\\u\\Downloads\\*.exe']) {
    assert.strictEqual(P.checkPath(p, { protectedDirs: ['D:\\Private'], guardianRoot }).protected, true, p);
  }
  assert.strictEqual(P.checkPath('C:\\Users\\u\\Downloads\\old.exe', { guardianRoot }).protected, false);
  for (const n of ['explorer', 'LSASS.EXE', 'MsMpEng', 'svchost', 'powershell', 'node']) assert.strictEqual(P.checkProcess({ name: n, pid: 999 }).protected, true, n);
  assert.strictEqual(P.checkProcess({ name: 'updater', pid: 3 }).protected, true, 'reserved pid');
  assert.strictEqual(P.checkProcess({ name: 'updater', pid: 999, path: 'C:\\Users\\u\\x\\updater.exe' }).protected, false);
});

test('parameter validation mirrors the catalog: unknown keys, missing, formats, enums, no command-like input', () => {
  const stop = R.byId.get('process.stop');
  assert.deepStrictEqual(R.validateParams(stop, stopParams), []);
  assert.match(R.validateParams(stop, { ...stopParams, command: 'calc' })[0], /Unexpected parameter 'command'/);
  assert.match(R.validateParams(stop, { pid: 'abc', name: 'a' })[0], /invalid format/);
  assert.match(R.validateParams(stop, { pid: 1, name: 'a; calc' })[0], /invalid format/);
  assert.match(R.validateParams(R.byId.get('firewall.enable-profile'), { profile: 'All' })[0], /must be one of/);
  assert.match(R.validateParams(R.byId.get('file.recycle'), { path: '\\\\srv\\x' })[0], /invalid format/);
  for (const a of R.CATALOG.actions) for (const k of Object.keys(a.params)) assert.ok(!/^(command|script|args|arguments|cmd|shell|expression|exe|executable)$/i.test(k), `${a.id}.${k}`);
});

test('plan refuses unknown actions, bad parameters and protected targets WITHOUT asking PowerShell', async () => {
  const { eng, ps, logged, done } = engine({ handlers: { 'Actions/Invoke-GuardianAction.ps1': () => okValidate() } });
  try {
    await assert.rejects(eng.plan('shell.run', { command: 'calc' }), (e) => e.status === 400 && /not an allowlisted/.test(e.message));
    await assert.rejects(eng.plan('Stop-Process -Id 4', {}), (e) => e.status === 400);
    await assert.rejects(eng.plan('process.stop', { ...stopParams, command: 'x' }), (e) => e.status === 400);
    await assert.rejects(eng.plan('process.stop', { pid: 100, name: 'explorer' }), (e) => e.status === 403 && /Protected/.test(e.message));
    await assert.rejects(eng.plan('process.stop', { pid: 4, name: 'system' }), (e) => e.status === 403);
    await assert.rejects(eng.plan('service.disable', { name: 'WinDefend' }), (e) => e.status === 403);
    await assert.rejects(eng.plan('file.recycle', { path: 'C:\\Windows\\System32\\drivers\\etc\\hosts' }), (e) => e.status === 403);
    await assert.rejects(eng.plan('file.recycle', { path: 'D:\\Private\\notes.txt' }), (e) => e.status === 403);
    await assert.rejects(eng.plan('task.disable', { taskPath: '\\Microsoft\\Windows\\Defrag\\', taskName: 'ScheduledDefrag' }), (e) => e.status === 403);
    assert.strictEqual(ps.calls.length, 0, 'PowerShell was never consulted for refused requests');
    assert.ok(logged.filter((l) => l.action === 'remediation.refused').length >= 8, 'every refusal is audited');
  } finally { done(); }
});

test('plan shows the exact effect and requires acknowledgements for risky actions', async () => {
  const { eng, ps, done } = engine({ handlers: { 'Actions/Invoke-GuardianAction.ps1': () => okValidate() } });
  try {
    const p = await eng.plan('process.stop', stopParams);
    assert.strictEqual(p.ok, true);
    assert.match(p.summary, /updater \(PID 4242\)/);
    assert.deepStrictEqual(p.requiredAcks, ['unsaved-work']);
    assert.strictEqual(p.reversible, false);
    assert.strictEqual(p.adminRequired, false);
    assert.match(p.token, /^[0-9a-f]{32}$/);
    assert.deepStrictEqual(ps.calls[0].args.slice(0, 4), ['-Action', 'process.stop', '-Mode', 'Validate']);
    assert.deepStrictEqual(decode(ps.calls[0].args), stopParams);
  } finally { done(); }
});

test('plan refuses when the live check refuses (PID reuse, gone, changed) and logs it', async () => {
  const { eng, logged, done } = engine({ handlers: { 'Actions/Invoke-GuardianAction.ps1': () => ({ ok: true, data: { ok: false, errors: ['PID 4242 now belongs to \'notepad\', not \'updater\'. The PID was reused.'] } }) } });
  try {
    await assert.rejects(eng.plan('process.stop', stopParams), (e) => e.status === 422 && /PID was reused/.test(e.message));
    assert.strictEqual(logged.at(-1).action, 'remediation.refused');
    assert.strictEqual(logged.at(-1).result, 'skipped');
  } finally { done(); }
});

test('execute needs confirm:true, a valid single-use token and the acknowledgements', async () => {
  const { eng, ps, done } = engine({ handlers: { 'Actions/Invoke-GuardianAction.ps1': (args) => (args.includes('Validate') ? okValidate() : { ok: true, data: { ok: true, verified: true, message: 'Stopped updater (PID 4242).' } }) } });
  try {
    const p = await eng.plan('process.stop', stopParams);
    await assert.rejects(eng.execute(p.token, {}), (e) => e.status === 400 && /confirm/.test(e.message));
    await assert.rejects(eng.execute('nope', { confirm: true }), (e) => e.status === 400);
    await assert.rejects(eng.execute(p.token, { confirm: true }), (e) => e.status === 400 && /acknowledge/.test(e.message));
    assert.ok(!ps.calls.some((c) => c.args.includes('Execute')), 'nothing executed without full confirmation');
    const r = await eng.execute(p.token, { confirm: true, acknowledged: ['unsaved-work'] });
    assert.strictEqual(r.status, 'done'); assert.strictEqual(r.result.verified, true);
    const exec = ps.calls.find((c) => c.args.includes('Execute'));
    assert.deepStrictEqual({ ...decode(exec.args) }, { ...stopParams, _identityKey: 'k1' }, 'the reviewed identity travels with the request so PowerShell can detect changes');
    await assert.rejects(eng.execute(p.token, { confirm: true, acknowledged: ['unsaved-work'] }), (e) => e.status === 410, 'a token is single use');
  } finally { done(); }
});

test('cancellation is audited and the token dies', async () => {
  const { eng, ps, logged, done } = engine({ handlers: { 'Actions/Invoke-GuardianAction.ps1': () => okValidate() } });
  try {
    const p = await eng.plan('file.recycle', { path: 'C:\\Users\\u\\Downloads\\old.exe' });
    eng.cancel(p.token);
    assert.strictEqual(logged.at(-1).action, 'remediation.cancelled');
    await assert.rejects(eng.execute(p.token, { confirm: true }), (e) => e.status === 410);
    assert.ok(!ps.calls.some((c) => c.args.includes('Execute')));
  } finally { done(); }
});

test('an expired confirmation cannot be used', async () => {
  let t = 1_000_000;
  const { eng, done } = engine({ now: () => t, handlers: { 'Actions/Invoke-GuardianAction.ps1': () => okValidate() } });
  try {
    const p = await eng.plan('dns.flush', {});
    t += 11 * 60 * 1000;
    await assert.rejects(eng.execute(p.token, { confirm: true }), (e) => e.status === 410);
  } finally { done(); }
});

test('failed and unverified outcomes are reported honestly (never as success)', async () => {
  let mode = 'fail';
  const { eng, done } = engine({ handlers: { 'Actions/Invoke-GuardianAction.ps1': (args) => (args.includes('Validate') ? okValidate() : mode === 'fail' ? { ok: true, data: { ok: false, errors: ['The file is still there after the request.'] } } : { ok: true, data: { ok: true, verified: false, message: 'Revo opened.' } }) } });
  try {
    let p = await eng.plan('file.recycle', { path: 'C:\\Users\\u\\Downloads\\old.exe' });
    const bad = await eng.execute(p.token, { confirm: true });
    assert.strictEqual(bad.status, 'failed'); assert.match(bad.result.errors[0], /still there/);
    mode = 'unverified';
    p = await eng.plan('app.verify-removed', { appName: 'Old Tool' });
    assert.strictEqual((await eng.execute(p.token, { confirm: true })).status, 'done-unverified');
  } finally { done(); }
});

test('a non-elevated attempt that hits "needs administrator" returns a NEW plan; it never retries elevated on its own', async () => {
  let executes = 0;
  const { eng, ps, done } = engine({ handlers: {
    'Actions/Invoke-GuardianAction.ps1': (args) => { if (args.includes('Validate')) return okValidate(); executes++; return { ok: true, data: { ok: false, needsElevation: true, errors: ['Windows denied access to stop this process.'] } }; },
  } });
  try {
    const p = await eng.plan('process.stop', stopParams);
    const r = await eng.execute(p.token, { confirm: true, acknowledged: ['unsaved-work'] });
    assert.strictEqual(r.status, 'needs-elevation');
    assert.ok(r.plan && r.plan.adminRequired === true && r.plan.confirmLabel === 'Continue to Windows prompt');
    assert.strictEqual(executes, 1);
    assert.ok(!ps.calls.some((c) => c.rel.includes('Request-ElevatedAction')), 'no UAC without a second explicit confirmation');
  } finally { done(); }
});

test('administrator actions go through the fixed elevation script with fixed arguments only', async () => {
  const { eng, ps, root, done } = engine({ handlers: {
    'Actions/Invoke-GuardianAction.ps1': () => okValidate({ needsAdmin: true, needsElevation: true, ok: false, errors: ['needs administrator'] }),
    'Actions/Request-ElevatedAction.ps1': () => ({ ok: true, data: { ok: true, requested: true, message: 'Windows is asking for administrator permission.' } }),
  } });
  try {
    const p = await eng.plan('firewall.enable-profile', { profile: 'Public' });
    assert.strictEqual(p.adminRequired, true); assert.strictEqual(p.confirmLabel, 'Continue to Windows prompt');
    const r = await eng.execute(p.token, { confirm: true });
    assert.strictEqual(r.status, 'awaiting-permission'); assert.match(r.ticket, /^[0-9a-f]{32}$/);
    const call = ps.calls.find((c) => c.rel === 'Actions/Request-ElevatedAction.ps1');
    assert.deepStrictEqual(call.args.slice(0, 2), ['-Action', 'firewall.enable-profile']);
    assert.deepStrictEqual(decode(call.args), { profile: 'Public', _identityKey: 'k1' });
    assert.strictEqual(argOf(call.args, '-Ticket'), r.ticket);
    assert.strictEqual(call.args.length, 6, 'only -Action, -ParamsB64 and -Ticket');
    // polling: waiting, running, done
    assert.strictEqual(eng.result(r.ticket).status, 'awaiting-permission');
    const dir = path.join(root, 'data', 'state', 'action-results'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${r.ticket}.running.json`), '{}');
    assert.strictEqual(eng.result(r.ticket).status, 'running');
    fs.writeFileSync(path.join(dir, `${r.ticket}.json`), JSON.stringify({ ok: true, verified: true, action: 'firewall.enable-profile', message: 'on' }));
    const fin = eng.result(r.ticket); assert.strictEqual(fin.status, 'done'); assert.strictEqual(fin.result.verified, true);
  } finally { done(); }
});

test('declining or ignoring the Windows prompt changes nothing and is reported', async () => {
  let t = 5_000_000;
  const { eng, logged, done } = engine({ now: () => t, handlers: {
    'Actions/Invoke-GuardianAction.ps1': () => okValidate({ needsAdmin: true }),
    'Actions/Request-ElevatedAction.ps1': (() => { let n = 0; return () => (++n === 1 ? { ok: false, data: { ok: false, requested: false, message: 'Administrator permission was not granted, so nothing was changed.' } } : { ok: true, data: { requested: true, message: 'asked' } }); })(),
  } });
  try {
    let p = await eng.plan('dns.flush', {});
    const declined = await eng.execute(p.token, { confirm: true });
    assert.strictEqual(declined.status, 'declined'); assert.match(declined.message, /not granted/);
    assert.strictEqual(logged.at(-1).result, 'skipped');
    p = await eng.plan('dns.flush', {});
    const asked = await eng.execute(p.token, { confirm: true });
    t += 3 * 60 * 1000;
    const late = eng.result(asked.ticket); assert.strictEqual(late.status, 'declined'); assert.match(late.message, /not approved in time/);
  } finally { done(); }
});

test('result polling only reads validated tickets (no path traversal)', () => {
  const { eng, done } = engine();
  try {
    for (const bad of ['../../config/config', 'a'.repeat(31), 'Z'.repeat(32), '', undefined]) assert.throws(() => eng.result(bad), (e) => e.status === 400);
  } finally { done(); }
});

test('history exposes undo only for reversible successes, and an undo is a normal confirmed plan', async () => {
  const events = [
    { id: 'e1', ts: '2026-10-05T10:00:00Z', category: 'remediation', action: 'remediation:startup.disable', target: 'kind=registry; name=Updater; location=HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', result: 'success', reason: 'disabled', data: { verified: true, undo: { action: 'startup.enable', params: { kind: 'registry', name: 'Updater', location: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' } } } },
    { id: 'e2', ts: '2026-10-05T10:05:00Z', category: 'remediation', action: 'remediation:process.stop', target: 'pid=1; name=x', result: 'failure', error: 'still running', data: { verified: false } },
  ];
  const { eng, done } = engine({ events, handlers: { 'Actions/Invoke-GuardianAction.ps1': () => okValidate() } });
  try {
    const h = eng.history();
    assert.strictEqual(h.find((x) => x.id === 'e1').canUndo, true);
    assert.strictEqual(h.find((x) => x.id === 'e2').canUndo, false);
    assert.strictEqual(h.find((x) => x.id === 'e2').result, 'failure');
    const p = await eng.undo('e1');
    assert.strictEqual(p.actionId, 'startup.enable'); assert.ok(p.token);
    await assert.rejects(eng.undo('e2'), (e) => e.status === 409);
    await assert.rejects(eng.undo('missing'), (e) => e.status === 404);
  } finally { done(); }
});

test('history: an undo whose params differ from the original still marks the original as undone (canonical subject)', () => {
  const events = [
    { id: 's1', ts: '2026-10-05T10:00:00Z', category: 'remediation', action: 'remediation:service.disable', target: 'name=Fax', result: 'success', data: { subject: 'service:Fax', verified: true, undo: { action: 'service.enable', params: { name: 'Fax', startMode: 'Manual' } } } },
    { id: 's2', ts: '2026-10-05T10:10:00Z', category: 'remediation', action: 'remediation:service.enable', target: 'name=Fax; startMode=Manual', result: 'success', data: { subject: 'service:Fax', verified: true, undo: { action: 'service.disable', params: { name: 'Fax' } } } },
    { id: 'f1', ts: '2026-10-05T10:20:00Z', category: 'remediation', action: 'remediation:firewall.block-remote', target: 'remote=203.0.113.9; duration=1h', result: 'success', data: { subject: 'fw:LG-1-abc123', verified: true, undo: { action: 'firewall.remove-rule', params: { name: 'LG-1-abc123' } } } },
  ];
  const { eng, done } = engine({ events, handlers: {} });
  try {
    const h = eng.history();
    assert.strictEqual(h.find((x) => x.id === 's1').canUndo, false, 'already undone');
    assert.strictEqual(h.find((x) => x.id === 's2').canUndo, true, 'the re-enable can itself be undone');
    assert.strictEqual(h.find((x) => x.id === 'f1').canUndo, true);
  } finally { done(); }
});

// ---------- findings ----------
const NOW = Date.parse('2026-10-05T12:00:00+05:30');
const baseCtx = (o = {}) => ({ recs: [], processes: [], files: null, daily: null, weekly: null, tasks: [], apps: null, revo: null, history: [], protectedDirs: [], guardianRoot: 'C:\\Guardian', now: NOW, ...o });
const procRec = (o = {}) => ({ id: 'r1', kind: 'process', status: 'open', title: 'Unsigned updater', risk: 'HIGH', confidence: 0.8, whatIsIt: 'x', whyFlagged: ['unsigned'], target: { name: 'updater', pid: 4242, path: 'C:\\Users\\u\\AppData\\Local\\Temp\\updater.exe' }, identity: { publisher: null, signature: 'NotSigned' }, persistence: { persistent: true, mechanisms: [{ kind: 'registry', name: 'Updater', location: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' }, { kind: 'task', name: '\\Vendor\\Updater Task', location: 'Task Scheduler' }, { kind: 'task', name: '\\Microsoft\\Office\\Feature Updates', location: 'Task Scheduler' }, { kind: 'service', name: 'WinDefend', location: 'SCM' }] }, ...o });

test('process findings offer only catalog actions with this finding\'s exact parameters; protected ones are ineligible', () => {
  const live = { pid: 4242, name: 'updater', path: 'C:\\Users\\u\\AppData\\Local\\Temp\\updater.exe', startTime: '2026-10-05T15:30:00+05:30' };
  const f = F.buildFindings(baseCtx({ recs: [procRec()], processes: [live] }))[0];
  const ids = f.actions.map((a) => a.actionId);
  assert.deepStrictEqual(ids, ['process.stop', 'startup.disable', 'task.disable', 'task.disable', 'service.disable']);
  const stop = f.actions[0];
  assert.strictEqual(stop.eligible, true); assert.strictEqual(stop.label, 'Stop process'); assert.strictEqual(stop.reversible, false);
  assert.strictEqual(stop.params.startTime, '2026-10-05T10:00:00', 'start time is sent in the same UTC form PowerShell compares');
  assert.strictEqual(f.actions[2].params.taskPath, '\\Vendor\\'); assert.strictEqual(f.actions[2].params.taskName, 'Updater Task');
  assert.strictEqual(f.actions[3].eligible, false, 'Microsoft tasks are never eligible');
  assert.strictEqual(f.actions[4].eligible, false, 'protected service is never eligible'); assert.match(f.actions[4].ineligibleReason, /Protected/);
  for (const a of f.actions) assert.ok(R.byId.has(a.actionId));
  const prot = F.buildFindings(baseCtx({ recs: [procRec({ target: { name: 'explorer', pid: 500, path: 'C:\\Windows\\explorer.exe' }, persistence: { persistent: false, mechanisms: [] } })] }))[0];
  assert.strictEqual(prot.actions[0].eligible, false); assert.match(prot.actions[0].ineligibleReason, /Protected/);
});

test('AI text never becomes an action, command or label', () => {
  const rec = procRec({ ai: { suggested_action: 'Stop temporarily', temporary_stop_method: 'Stop-Process -Id 4242 -Force', persistence_removal_method: 'Remove-Item -Recurse C:\\', evidence: ['rm -rf'] } });
  const f = F.buildFindings(baseCtx({ recs: [rec] }))[0];
  const text = JSON.stringify(f.actions);
  assert.doesNotMatch(text, /Remove-Item|rm -rf|Stop-Process/);
  for (const a of f.actions) { assert.ok(R.byId.has(a.actionId)); assert.strictEqual(a.label, R.byId.get(a.actionId).label); }
});

test('Revo is offered only for a recognised installed application with a trusted Revo', () => {
  const apps = [{ name: 'Old Tool', installLocation: 'C:\\Program Files\\Acme\\Old Tool', systemComponent: false, isUpdate: false }, { name: 'SysThing', installLocation: 'C:\\Program Files\\Sys', systemComponent: true, isUpdate: false }];
  const rec = procRec({ target: { name: 'oldtool', pid: 5, path: 'C:\\Program Files\\Acme\\Old Tool\\oldtool.exe' }, persistence: { persistent: false, mechanisms: [] } });
  const revoOk = { available: true };
  assert.ok(F.buildFindings(baseCtx({ recs: [rec], apps, revo: revoOk }))[0].actions.some((a) => a.actionId === 'app.revo-launch' && a.params.appName === 'Old Tool' && a.label === 'Uninstall cleanly with Revo'));
  assert.ok(!F.buildFindings(baseCtx({ recs: [rec], apps, revo: { available: false } }))[0].actions.some((a) => a.actionId === 'app.revo-launch'), 'Revo missing: no Revo action');
  assert.ok(!F.buildFindings(baseCtx({ recs: [rec], apps: [], revo: revoOk }))[0].actions.some((a) => a.actionId === 'app.revo-launch'), 'not a recognised app');
  const sys = procRec({ target: { name: 'sys', pid: 6, path: 'C:\\Program Files\\Sys\\sys.exe' }, persistence: { persistent: false, mechanisms: [] } });
  assert.ok(!F.buildFindings(baseCtx({ recs: [sys], apps, revo: revoOk }))[0].actions.some((a) => a.actionId === 'app.revo-launch'), 'system components never');
});

test('file findings: only REVIEW and LIKELY_UNNECESSARY files, Recycle Bin action only, protected paths ineligible', () => {
  const files = { candidates: [
    { id: 'a', path: 'C:\\Users\\u\\Downloads\\old.exe', name: 'old.exe', sizeMB: 900, classification: 'LIKELY_UNNECESSARY', ageDays: 400, whyFlagged: ['old installer'] },
    { id: 'b', path: 'C:\\Users\\u\\Documents\\thesis.docx', name: 'thesis.docx', sizeMB: 5, classification: 'KEEP' },
    { id: 'c', path: 'C:\\Users\\u\\Downloads\\x.iso', name: 'x.iso', sizeMB: 4000, classification: 'HIGH_RISK' },
    { id: 'd', path: 'D:\\Private\\big.bin', name: 'big.bin', sizeMB: 2000, classification: 'REVIEW' },
    { id: 'e', path: 'C:\\Users\\u\\Downloads\\ign.exe', name: 'ign.exe', sizeMB: 50, classification: 'REVIEW', ignored: true },
  ] };
  const fs2 = F.buildFindings(baseCtx({ files, protectedDirs: ['D:\\Private'] })).filter((f) => f.kind === 'file');
  assert.deepStrictEqual(fs2.map((f) => f.id), ['file:d', 'file:a']);
  assert.ok(fs2.every((f) => f.actions.length === 1 && f.actions[0].actionId === 'file.recycle' && f.actions[0].label === 'Recycle file'));
  assert.strictEqual(fs2.find((f) => f.id === 'file:d').actions[0].eligible, false);
  assert.strictEqual(fs2.find((f) => f.id === 'file:a').actions[0].eligible, true);
  assert.match(fs2[1].actions[0].undo, /Recycle Bin/);
});

test('health findings: Defender, firewall, integrity, DNS and schedule repair each map to one fixed action', () => {
  const daily = { sections: { defender: { available: true, enabled: true, sigAgeDays: 6, sigVersion: '1.2', lastQuickScan: '2026-09-01T00:00:00+05:30' }, firewall: { profiles: [{ name: 'Public', enabled: false }, { name: 'Private', enabled: true }] }, network: { dnsOk: false, internet: false, gatewayOk: true, dnsServers: ['1.1.1.1'] } } };
  const weekly = { id: '2026-W40', incomplete: ['Windows integrity checks skipped (battery)'] };
  const tasks = [{ kind: 'daily', name: 'Daily Audit', summary: 'x', runLevel: 'Highest', issues: ['Daily task was registered without -Scheduled'], repair: { needed: true, requiresElevation: true } }];
  const all = F.buildFindings(baseCtx({ daily, weekly, tasks }));
  const byAction = Object.fromEntries(all.flatMap((f) => f.actions.map((a) => [a.actionId, a])));
  for (const id of ['defender.update-signatures', 'defender.quick-scan', 'firewall.enable-profile', 'system.integrity-check', 'dns.flush', 'schedule.repair']) assert.ok(byAction[id], id);
  assert.deepStrictEqual(byAction['firewall.enable-profile'].params, { profile: 'Public' });
  assert.strictEqual(byAction['schedule.repair'].label, 'Repair with administrator permission');
  assert.strictEqual(byAction['schedule.repair'].admin, 'yes');
  assert.strictEqual(all[0].id, 'health:firewall-Public', 'highest risk first');
  const healthy = F.buildFindings(baseCtx({ daily: { sections: { defender: { available: true, enabled: true, sigAgeDays: 0.5, lastQuickScan: '2026-10-04T00:00:00+05:30' }, firewall: { profiles: [{ name: 'Public', enabled: true }] }, network: { dnsOk: true, internet: true } } } }));
  assert.deepStrictEqual(healthy, []);
});

test('findings carry previous attempts and their outcomes', () => {
  const history = [{ id: 'h1', actionId: 'process.stop', target: 'pid=4242; name=updater', result: 'failure', ts: '2026-10-04T10:00:00Z', message: 'still running' }, { id: 'h2', actionId: 'process.stop', target: 'pid=1; name=chrome', result: 'success', ts: '2026-10-04T10:00:00Z' }];
  const f = F.buildFindings(baseCtx({ recs: [procRec()], history }))[0];
  assert.deepStrictEqual(f.attempts.map((a) => a.id), ['h1']);
});

// ---------- over HTTP ----------
test('HTTP: plan, cancel and execute are mutation-protected and refuse protected targets end to end', async () => {
  const ps = fakeRunner({ 'Actions/Invoke-GuardianAction.ps1': () => okValidate(), 'Actions/Get-RemediationInfo.ps1': () => ({ ok: true, data: { ok: true, apps: [], revo: { available: false, reason: 'none' } } }) });
  const b = await startBridge({ ps });
  try {
    const refused = await b.post('/api/remediation/plan', { actionId: 'process.stop', params: { pid: 100, name: 'lsass' } });
    assert.strictEqual(refused.status, 403); assert.match(refused.json.error, /Protected/);
    const bad = await b.post('/api/remediation/plan', { actionId: 'shell.run', params: { command: 'calc' } });
    assert.strictEqual(bad.status, 400);
    const ok = await b.post('/api/remediation/plan', { actionId: 'dns.flush', params: {} });
    assert.strictEqual(ok.status, 200); assert.strictEqual(ok.json.actionId, 'dns.flush');
    const noConfirm = await b.post('/api/remediation/execute', { token: ok.json.token });
    assert.strictEqual(noConfirm.status, 400);
    const cancel = await b.post('/api/remediation/cancel', { token: ok.json.token });
    assert.strictEqual(cancel.status, 200);
    const hist = (await b.get('/api/remediation/history')).json.items;
    assert.ok(hist.some((h) => h.actionId === 'refused') && hist.some((h) => h.actionId === 'cancelled'), 'refusals and cancellations appear in the history');
    const f = await b.get('/api/remediation/findings');
    assert.strictEqual(f.status, 200); assert.ok(Array.isArray(f.json.findings));
    assert.strictEqual((await b.get('/api/remediation/result/not-a-ticket')).status, 400);
    assert.strictEqual((await b.get('/api/remediation/catalog')).json.actions.length, R.CATALOG.actions.length);
  } finally { b.close(); }
});

test('HTTP: fixtures produce findings that all reference allowlisted actions', async () => {
  const ps = fakeRunner({ 'Actions/Get-RemediationInfo.ps1': () => ({ ok: true, data: { ok: true, apps: [], revo: { available: false } } }) });
  const b = await startBridge({ ps });
  try {
    const f = (await b.get('/api/remediation/findings')).json.findings;
    assert.ok(f.length > 0);
    for (const x of f) { assert.ok(x.what && Array.isArray(x.why) && Array.isArray(x.evidence) && x.risk, x.id); for (const a of x.actions) { assert.ok(R.byId.has(a.actionId)); assert.ok(a.summary && a.consequences && a.undo, a.actionId); } }
  } finally { b.close(); }
});
