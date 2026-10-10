'use strict';
// The Node policy matcher against the same fixture the PowerShell matcher is tested with (tests/Policy.Tests.ps1).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const PM = require('../src/bridge/lib/policymatch');
const { startBridge, fakeRunner } = require('./lib/harness');

const fx = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'policy-match-cases.json'), 'utf8'));

test('policy matching: every shared case gives the answer the PowerShell side gives (case, .exe, spaces, scope, pauses, precedence)', () => {
  const now = Date.parse(fx.now);
  for (const c of fx.cases) {
    const r = PM.findPolicyMatch(fx.policy, c.name, c.path, now);
    assert.strictEqual(`${r.list}:${r.entry ? r.entry.id : ''}`, c.expect, JSON.stringify(c));
  }
});

test('adding through the API: the same name in another case or with .exe is the same entry, a path-scoped entry is not a name-wide one, and a move replaces the opposite list', async () => {
  const b = await startBridge({ ps: fakeRunner({}) });
  try {
    const add = (o) => b.post('/api/policy', o);
    const a = await add({ list: 'blacklist', name: 'BadApp.exe', reason: 'x' });
    const a2 = await add({ list: 'blacklist', name: '  badapp ' });
    assert.strictEqual(a2.json.id, a.json.id, 'same entry');
    const scoped = await add({ list: 'blacklist', name: 'badapp', path: 'C:\\Tools\\Bad.exe' });
    assert.notStrictEqual(scoped.json.id, a.json.id, 'a path-scoped entry is its own entry');
    const scoped2 = await add({ list: 'blacklist', name: 'BADAPP', path: 'c:\\tools\\BAD.EXE' });
    assert.strictEqual(scoped2.json.id, scoped.json.id, 'paths compare without regard to case');
    await add({ list: 'whitelist', name: 'BADAPP' });
    const pol = (await b.get('/api/policy')).json;
    const bad = (l) => l.filter((e) => PM.procKey(e.name) === 'badapp');
    assert.strictEqual(bad(pol.whitelist).length, 1); assert.strictEqual(bad(pol.blacklist).length, 0, 'moving it to the whitelist replaced the overlapping blacklist entries');
  } finally { b.close(); }
});
