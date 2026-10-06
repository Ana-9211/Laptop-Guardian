'use strict';
// Diagnostics for bug reports: the masked text hides the user name and home paths; the route answers read-only.
const test = require('node:test');
const assert = require('node:assert');
const { startBridge, fakeRunner } = require('./lib/harness');
const { maskText, buildDiagnostics } = require('../src/bridge/lib/diagnostics');

test('maskText: user name, profile, data and program folders and other users\' folders are replaced', () => {
  const opts = { userName: 'Anagha', userProfile: 'C:\\Users\\Anagha', dataRoot: 'C:\\Users\\Anagha\\AppData\\Local\\LaptopGuardian', codeRoot: 'C:\\Program Files\\LaptopGuardian', computerName: 'DESKTOP-AB12' };
  const out = maskText('Data C:\\Users\\Anagha\\AppData\\Local\\LaptopGuardian\\data, prog C:\\Program Files\\LaptopGuardian\\src, home c:\\users\\anagha\\Documents, other C:\\Users\\Bob\\x, user Anagha on DESKTOP-AB12', opts);
  assert.strictEqual(out, 'Data <data folder>\\data, prog <program folder>\\src, home %USERPROFILE%\\Documents, other C:\\Users\\<user>\\x, user <user> on <computer>');
  assert.ok(!/anagha|bob|desktop-ab12/i.test(out));
  assert.strictEqual(maskText('plain text 12', {}), 'plain text 12');
});

test('buildDiagnostics: install mode, last runs, sampler state, and a masked text', () => {
  const d = buildDiagnostics({ version: '1.1.0', startedAt: 's', codeMtime: 'm', restartNeeded: true, port: 7879, install: null, root: 'C:\\Users\\Anagha\\Documents\\LaptopGuardian', codeRoot: 'C:\\Users\\Anagha\\Documents\\LaptopGuardian',
    runState: { lastDaily: { startedAt: 'a', finishedAt: 'b', status: 'complete' } }, daily: { id: '2026-10-07', status: 'complete', healthScore: 80 }, deep: { active: true, source: 'sampler' }, sampler: { running: true, alive: true, gaveUp: false, restarts: 1 },
    tasks: [{ kind: 'daily', state: 'Ready', runLevel: 'Limited', status: 'ok' }], config: { safety: { safeMode: true } }, env: { USERNAME: 'Anagha', USERPROFILE: 'C:\\Users\\Anagha', COMPUTERNAME: 'PC1' } });
  assert.strictEqual(d.install.mode, 'checkout'); assert.strictEqual(d.sampler.running, true); assert.strictEqual(d.lastRuns.daily.status, 'complete');
  assert.match(d.text, /RESTART NEEDED/); assert.match(d.text, /Sampler: deep mode on, source sampler, running true/);
  assert.ok(!/Anagha/.test(d.text)); assert.strictEqual(d.masked, true);
  const inst = buildDiagnostics({ version: '1', install: { elevatedDir: 'C:\\ProgramData\\LaptopGuardian' }, root: 'C:\\Users\\Anagha\\AppData\\Local\\LaptopGuardian', codeRoot: 'C:\\Program Files\\LaptopGuardian', env: { USERNAME: 'Anagha', USERPROFILE: 'C:\\Users\\Anagha' } });
  assert.strictEqual(inst.install.mode, 'installed'); assert.match(inst.text, /\(installed\)/); assert.match(inst.text, /Data folder: <data folder>/); assert.ok(!/Anagha/.test(inst.text));
});

test('GET /api/diagnostics works through the bridge and exposes no config, process or log content', async () => {
  const b = await startBridge({ ps: fakeRunner({}) });
  try {
    await b.get('/api/status');
    const r = await b.get('/api/diagnostics'); assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.install.mode, 'checkout'); assert.ok(r.json.bridge.version); assert.strictEqual(typeof r.json.text, 'string');
    assert.ok(!JSON.stringify(r.json).includes('token'), 'no session token');
    assert.ok(!r.json.text.includes(b.root), 'the data folder path is masked in the copy text');
    assert.deepStrictEqual(Object.keys(r.json).sort(), ['bridge', 'install', 'lastRuns', 'masked', 'safety', 'sampler', 'tasks', 'text']);
  } finally { b.close(); }
});
