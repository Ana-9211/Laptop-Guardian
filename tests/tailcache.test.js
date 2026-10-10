'use strict';
// The audit-log tail is not re-read and re-parsed while the file is unchanged.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('../src/bridge/lib/util');
const { startBridge, fakeRunner } = require('./lib/harness');
const { makeNetworkSnapshot } = require('./fixtures/network-fixture');

/** Counts how many times a file is opened for reading while fn runs. */
async function countOpens(file, fn) {
  const real = fs.openSync; let n = 0;
  fs.openSync = function (p, ...rest) { if (path.resolve(String(p)) === path.resolve(file)) n++; return real.call(fs, p, ...rest); };
  try { await fn(); } finally { fs.openSync = real; }
  return n;
}

test('tailJsonlCached: the second read of an unchanged file does not open it, a change is seen at once, and callers get their own array', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-tail-')); const f = path.join(d, 'a.jsonl');
  try {
    fs.writeFileSync(f, [1, 2, 3].map((i) => JSON.stringify({ i })).join('\n') + '\n');
    let first;
    const n1 = (() => { const real = fs.openSync; let n = 0; fs.openSync = (p, ...r) => { if (String(p) === f) n++; return real.call(fs, p, ...r); }; try { first = U.tailJsonlCached(f, 10); U.tailJsonlCached(f, 10); U.tailJsonlCached(f, 2); return n; } finally { fs.openSync = real; } })();
    assert.strictEqual(n1, 1, 'three reads, one open');
    assert.deepStrictEqual(first.map((r) => r.i), [1, 2, 3]);
    first.reverse(); first.pop();
    assert.deepStrictEqual(U.tailJsonlCached(f, 10).map((r) => r.i), [1, 2, 3], 'changing a returned array does not change the cache');
    assert.deepStrictEqual(U.tailJsonlCached(f, 2).map((r) => r.i), [2, 3]);
    fs.appendFileSync(f, JSON.stringify({ i: 4 }) + '\n');
    assert.deepStrictEqual(U.tailJsonlCached(f, 10).map((r) => r.i), [1, 2, 3, 4], 'an append is seen');
    assert.deepStrictEqual(U.tailJsonlCached(path.join(d, 'missing.jsonl')), []);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('network polls: the second /api/network/current does not re-read the audit log; a new audit row makes the next one read it again', async () => {
  const snap = makeNetworkSnapshot();
  const ps = fakeRunner({ 'Network/Get-NetworkSnapshot.ps1': () => ({ ok: true, data: snap }) });
  const b = await startBridge({ ps });
  try {
    await b.post('/api/network/snapshot', {});
    const audit = path.join(b.root, 'data', 'actions', 'actions.jsonl');
    await b.get('/api/network/current');                       // warms the cache
    const second = await countOpens(audit, () => b.get('/api/network/current'));
    assert.strictEqual(second, 0, 'the unchanged audit log was not opened again');
    const third = await countOpens(audit, () => b.get('/api/network/current'));
    assert.strictEqual(third, 0);
    fs.appendFileSync(audit, JSON.stringify({ id: 'a_new', ts: new Date().toISOString(), category: 'system', severity: 'info', action: 'test.row', result: 'success' }) + '\n');   // another process writes an audit row
    const afterWrite = await countOpens(audit, () => b.get('/api/network/current'));
    assert.ok(afterWrite >= 1, 'a changed log is read again');
    const fresh = await b.get('/api/actions?q=test.row'); assert.strictEqual(fresh.json.length, 1, 'and the newest row is there');
  } finally { b.close(); }
});
