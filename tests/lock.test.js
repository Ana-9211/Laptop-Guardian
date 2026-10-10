'use strict';
// Shared file locks: fail closed, never rob a live owner, recover from a dead one, never freeze the event loop, never lose an update.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork, spawnSync } = require('child_process');
const U = require('../src/bridge/lib/util');
const NS = require('../src/bridge/lib/netstore');
const { startBridge, fakeRunner } = require('./lib/harness');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-lock-'));
const writeLock = (file, o, ageMs = 0) => { const l = `${file}.lock`; fs.writeFileSync(l, typeof o === 'string' ? o : JSON.stringify(o)); if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(l, t, t); } return l; };
const realProbe = { alive: (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }, startTime: () => null };
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', '0']); return r.pid; };

test('timeout: the work does not run and the error is ELOCKED (fail closed)', () => {
  const d = tmp(); const f = path.join(d, 'x.json'); let ran = false;
  try {
    writeLock(f, { pid: process.pid, createdAt: new Date().toISOString(), token: 't' });   // a fresh lock held by someone else
    assert.throws(() => U.withFileLock(f, () => { ran = true; }, 150), (e) => e.code === 'ELOCKED');
    assert.strictEqual(ran, false);
    assert.ok(fs.existsSync(`${f}.lock`), 'the other holder\'s lock is untouched');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('a lock whose owner is alive is never robbed, however old; a reused pid is recognised; a dead owner is recovered', () => {
  const d = tmp(); const f = path.join(d, 'x.json'); let ran = 0;
  try {
    U.setLockProbe({ ...realProbe });
    // old, owner (this very process) alive, start time unknown -> keep waiting, then fail
    const info = { pid: process.pid, createdAt: new Date(Date.now() - 120000).toISOString(), token: 'a' };
    writeLock(f, info, 120000);
    assert.throws(() => U.withFileLock(f, () => { ran++; }, 150), (e) => e.code === 'ELOCKED');
    assert.strictEqual(ran, 0); assert.ok(fs.existsSync(`${f}.lock`), 'a live owner keeps its lock');
    // same pid, but that process started AFTER the lock was written -> the pid was reused, the lock is abandoned
    U.setLockProbe({ ...realProbe, startTime: () => Date.now() });
    assert.strictEqual(U.withFileLock(f, () => { ran++; return 'ok'; }, 500), 'ok'); assert.strictEqual(ran, 1);
    assert.ok(!fs.existsSync(`${f}.lock`), 'released');
    // a pid that no longer exists -> recovered once the lock is old
    U.setLockProbe({ ...realProbe });
    writeLock(f, { pid: deadPid(), createdAt: new Date(Date.now() - 120000).toISOString(), token: 'b' }, 120000);
    assert.strictEqual(U.withFileLock(f, () => 'recovered', 500), 'recovered');
    // a dead owner's lock that is NOT yet old is respected (it may be a very short write in progress elsewhere)
    writeLock(f, { pid: deadPid(), createdAt: new Date().toISOString(), token: 'c' });
    assert.throws(() => U.withFileLock(f, () => 'x', 150), (e) => e.code === 'ELOCKED');
    fs.rmSync(`${f}.lock`);
    // an agent-style lock (no owner information) that is old and not held open is removed
    writeLock(f, '', 120000);
    assert.strictEqual(U.withFileLock(f, () => 'agent lock gone', 500), 'agent lock gone');
  } finally { U.setLockProbe({ ...realProbe }); fs.rmSync(d, { recursive: true, force: true }); }
});

test('nested use inside one process is allowed, and release only removes our own lock', () => {
  const d = tmp(); const f = path.join(d, 'x.json');
  try {
    assert.strictEqual(U.withFileLock(f, () => U.withFileLock(f, () => 'inner', 100), 500), 'inner');
    assert.ok(!fs.existsSync(`${f}.lock`));
    // if our lock was taken over while we worked, releasing must not delete the new owner's lock
    U.withFileLock(f, () => { fs.rmSync(`${f}.lock`); writeLock(f, { pid: 1, createdAt: new Date().toISOString(), token: 'someone-else' }); }, 500);
    assert.ok(fs.existsSync(`${f}.lock`) && JSON.parse(fs.readFileSync(`${f}.lock`, 'utf8')).token === 'someone-else');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('the async lock waits with timers: the event loop keeps running while another process holds the lock', async () => {
  const d = tmp(); const f = path.join(d, 'x.json');
  try {
    writeLock(f, { pid: process.pid, createdAt: new Date().toISOString(), token: 't' });
    let ticks = 0; const iv = setInterval(() => { ticks++; }, 20);
    const t0 = Date.now();
    await assert.rejects(U.withFileLockAsync(f, () => 'x', 400), (e) => e.code === 'ELOCKED');
    clearInterval(iv);
    assert.ok(Date.now() - t0 >= 380, 'it waited for the timeout');
    assert.ok(ticks >= 8, `the loop ran ${ticks} timer ticks while waiting`);
    // and it proceeds as soon as the lock is released
    setTimeout(() => fs.rmSync(`${f}.lock`), 100);
    assert.strictEqual(await U.withFileLockAsync(f, () => 'got it', 2000), 'got it');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('concurrent writers in separate processes lose no update (sync and async)', async () => {
  for (const mode of ['sync', 'async']) {
    const d = tmp(); const f = path.join(d, 'counter.json'); fs.writeFileSync(f, JSON.stringify({ n: 0, by: {} }));
    try {
      const kids = Array.from({ length: 4 }, () => new Promise((resolve, reject) => { const c = fork(path.join(__dirname, 'lib', 'lock-worker.js'), [f, '25', mode]); c.on('message', resolve); c.on('error', reject); }));
      const res = await Promise.all(kids);
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      assert.strictEqual(res.reduce((a, r) => a + r.failed, 0), 0, `${mode}: no writer gave up`);
      assert.strictEqual(j.n, 100, `${mode}: every one of the 100 read-modify-write cycles is in the final count`);
      assert.strictEqual(Object.keys(j.by).length, 4);
      assert.ok(!fs.existsSync(`${f}.lock`), 'no lock left behind');
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
  }
});

test('pruneJsonl: takes the lock, replaces the file atomically (no temp file left) and refuses to run while another writer holds it', () => {
  const d = tmp(); const f = path.join(d, 'h.jsonl');
  try {
    const old = new Date(Date.now() - 40 * 86400000).toISOString(); const now = new Date().toISOString();
    fs.writeFileSync(f, [JSON.stringify({ ts: old, a: 1 }), JSON.stringify({ ts: now, a: 2 })].join('\n') + '\n');
    writeLock(f, { pid: process.pid, createdAt: new Date().toISOString(), token: 't' });
    const before = fs.readFileSync(f, 'utf8');
    const orig = U.withFileLock;   // keep the test fast: the prune uses the default 4 s wait
    assert.throws(() => NS.pruneJsonl(f, { days: 30, maxBytes: 1e6 }), (e) => e.code === 'ELOCKED');
    assert.strictEqual(fs.readFileSync(f, 'utf8'), before, 'nothing was changed');
    assert.strictEqual(typeof orig, 'function');
    fs.rmSync(`${f}.lock`);
    assert.strictEqual(NS.pruneJsonl(f, { days: 30, maxBytes: 1e6 }), 1);
    assert.deepStrictEqual(fs.readdirSync(d).sort(), ['h.jsonl']);
    assert.strictEqual(JSON.parse(fs.readFileSync(f, 'utf8').trim()).a, 2);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test('through the bridge: a write that cannot get the lock answers 503 and changes nothing (settings and schedule), and setNetworkFlag takes the lock', async () => {
  const b = await startBridge({ ps: fakeRunner({ 'Scheduler.ps1': () => ({ ok: true, data: { tasks: [] } }) }) });
  try {
    const cfgFile = path.join(b.root, 'config', 'config.json'); const before = fs.readFileSync(cfgFile, 'utf8');
    writeLock(cfgFile, { pid: process.pid, createdAt: new Date().toISOString(), token: 'held' });
    const put = await b.put('/api/config', { thresholds: { cpuPct: 60 } });
    assert.strictEqual(put.status, 503); assert.match(put.json.error, /try again/);
    const sch = await b.put('/api/schedule', { daily: { time: '07:45' } });
    assert.strictEqual(sch.status, 503);
    assert.strictEqual(fs.readFileSync(cfgFile, 'utf8'), before, 'the config file was not touched');
    fs.rmSync(`${cfgFile}.lock`);
    const ok = await b.put('/api/config', { thresholds: { cpuPct: 60 } }); assert.strictEqual(ok.status, 200);
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'bridge', 'lib', 'network-context.js'), 'utf8');
    assert.match(src, /function setNetworkFlag[\s\S]{0,300}withFileLock\(P\.config/);
  } finally { b.close(); }
});
