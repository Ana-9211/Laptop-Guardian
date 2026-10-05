'use strict';
// A development checkout and an installed copy: where the bridge finds its data, where elevated runs write, and the default port.
// Everything happens in temp folders. Nothing here installs, elevates or touches real data.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('../src/bridge/lib/util');
const P = require('../src/bridge/lib/protected');
const { startBridge, fakeRunner } = require('./lib/harness');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-install-'));
const clean = (d) => fs.rmSync(d, { recursive: true, force: true });

test('readInstall: absent means a checkout; a good file is read; a damaged or incomplete one stops everything', () => {
  const d = tmp();
  try {
    assert.strictEqual(U.readInstall(d), null);
    fs.writeFileSync(path.join(d, 'install.json'), JSON.stringify({ dataRoot: 'C:\\Data\\G', elevatedDir: 'C:\\ProgramData\\G' }));
    assert.strictEqual(U.readInstall(d).dataRoot, 'C:\\Data\\G');
    fs.writeFileSync(path.join(d, 'install.json'), '{ nope');
    assert.throws(() => U.readInstall(d), /damaged/);
    fs.writeFileSync(path.join(d, 'install.json'), JSON.stringify({ dataRoot: 'relative\\path', elevatedDir: 'C:\\ProgramData\\G' }));
    assert.throws(() => U.readInstall(d), /dataRoot/);
    fs.writeFileSync(path.join(d, 'install.json'), JSON.stringify({ dataRoot: 'C:\\Data\\G' }));
    assert.throws(() => U.readInstall(d), /elevatedDir/);
  } finally { clean(d); }
});

test('a development checkout defaults to port 7879 so it does not clash with the installed copy on 7878', () => {
  assert.strictEqual(U.DEFAULT_PORT, 7879);
  assert.strictEqual(U.DEFAULT_CONFIG.bridge.port, 7879);
});

test('protected targets accept several Guardian folders (data and program)', () => {
  const roots = ['C:\\Users\\u\\AppData\\Local\\LaptopGuardian', 'C:\\Program Files\\LaptopGuardian'];
  assert.strictEqual(P.checkPath('C:\\Program Files\\LaptopGuardian\\src\\x.ps1', { guardianRoot: roots }).protected, true);
  assert.strictEqual(P.checkPath('C:\\Users\\u\\AppData\\Local\\LaptopGuardian\\data\\a.json', { guardianRoot: roots }).protected, true);
  assert.strictEqual(P.checkProcess({ name: 'node', pid: 900, path: 'C:\\Program Files\\LaptopGuardian\\tool.exe', guardianRoot: roots }).protected, true);
});

test('an installed copy: the audit trail merges the administrators-only log, and elevated results are read from its folder', async () => {
  const elev = tmp();
  fs.mkdirSync(path.join(elev, 'audit'), { recursive: true });
  const now = new Date();
  const line = (id, ago) => JSON.stringify({ id, ts: U.localIso(new Date(now - ago)), category: 'remediation', severity: 'info', action: 'remediation:dns.flush', result: 'success', actor: 'user' });
  fs.writeFileSync(path.join(elev, 'audit', 'actions.jsonl'), line('elev-1', 1000) + '\n');
  fs.mkdirSync(path.join(elev, 'results'), { recursive: true });
  const ticket = 'a'.repeat(32);
  fs.writeFileSync(path.join(elev, 'results', ticket + '.json'), JSON.stringify({ ok: true, verified: true, action: 'dns.flush', message: 'done' }));
  const b = await startBridge({ ps: fakeRunner({}), opts: { elevatedDir: elev } });
  try {
    const acts = (await b.get('/api/actions?limit=50')).json;
    assert.ok(acts.some((a) => a.id === 'elev-1'), 'elevated audit lines are part of the log');
    const r = (await b.get('/api/remediation/result/' + ticket)).json;
    assert.strictEqual(r.status, 'done');
    const ping = (await b.get('/api/ping')).json;
    assert.ok(ping.root && ping.dataRoot, 'ping tells the launcher which program folder this is');
  } finally { b.close(); clean(elev); }
});
