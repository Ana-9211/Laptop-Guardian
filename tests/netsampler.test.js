'use strict';
// The Deep Network Guard sampler: parsing, restart with backoff, giving up, stopping, and the fallback to netstat. No real process is started.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSampler, parseSampleLine } = require('../src/bridge/lib/netsampler');
const ND = require('../src/bridge/lib/netdeep');

const line = (rows, names = {}) => JSON.stringify({ t: '2026-10-07T08:00:00.000Z', rows, names }) + '\n';
const tcp = (state, la, lp, ra, rp, pid) => ({ proto: 'TCP', localAddress: la, localPort: lp, remoteAddress: ra, remotePort: rp, state, pid });

function fakeStream() {
  const procs = [];
  return { procs, ps: { stream: (rel, args, h) => { const p = { rel, args, h, killed: false, kill() { p.killed = true; } }; procs.push(p); return p; } } };
}
function clock() { let t = 1000000; const timers = []; return { now: () => t, advance: (ms) => { t += ms; }, setTimeoutFn: (fn, ms) => { const x = { fn, ms }; timers.push(x); return x; }, clearTimeoutFn: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); }, timers }; }

test('parseSampleLine: normalises state words, drops junk rows, caps nothing silently wrong, rejects non-samples', () => {
  const s = parseSampleLine(line([tcp('TimeWait', '10.0.0.2', 5, '203.0.113.1', 443, 0), tcp('FinWait2', '10.0.0.2', 6, '203.0.113.1', 443, 4), tcp('Established', '10.0.0.2', 7, '203.0.113.1', 443, 9), { proto: 'ICMP' }, null], { 9: 'chrome.exe' }));
  assert.deepStrictEqual(s.rows.map((r) => r.state), ['Time Wait', 'Fin Wait 2', 'Established']);
  assert.strictEqual(s.names.get(9), 'chrome.exe');
  assert.strictEqual(parseSampleLine('not json'), null);
  assert.strictEqual(parseSampleLine('{"rows":5}'), null);
});

test('sampler: reads lines split across chunks, ignores broken lines, and a stale sample is not used', () => {
  const f = fakeStream(); const c = clock();
  const s = createSampler({ ps: f.ps, intervalSec: 5, now: c.now, setTimeoutFn: c.setTimeoutFn, clearTimeoutFn: c.clearTimeoutFn });
  s.start();
  assert.strictEqual(f.procs.length, 1);
  assert.deepStrictEqual(f.procs[0].args, ['-IntervalSec', '5', '-ParentPid', String(process.pid)]);
  const full = line([tcp('Established', 'a', 1, 'b', 2, 7)]);
  f.procs[0].h.onData('garbage\n' + full.slice(0, 20)); assert.strictEqual(s.latest(), null);
  f.procs[0].h.onData(full.slice(20)); assert.strictEqual(s.latest().rows.length, 1);
  c.advance(16000); assert.strictEqual(s.latest(), null, 'older than three intervals');
});

test('sampler: restarts with a growing backoff after it dies, gives up after too many restarts, and stop kills it', () => {
  const f = fakeStream(); const c = clock(); const logged = [];
  const s = createSampler({ ps: f.ps, log: (e) => logged.push(e), now: c.now, setTimeoutFn: c.setTimeoutFn, clearTimeoutFn: c.clearTimeoutFn });
  s.start();
  const delays = [];
  for (let i = 0; i < 5; i++) { f.procs[f.procs.length - 1].h.onExit(); delays.push(c.timers[c.timers.length - 1].ms); c.timers.pop().fn(); c.advance(1000); }
  assert.deepStrictEqual(delays, [1000, 2000, 4000, 8000, 16000]);
  assert.strictEqual(f.procs.length, 6);
  f.procs[5].h.onExit();
  assert.strictEqual(s.status().gaveUp, true);
  assert.ok(logged.some((e) => e.action === 'network.deep.sampler-gave-up'));
  assert.strictEqual(c.timers.length, 0, 'no retry is scheduled after giving up');
  const g = fakeStream(); const s2 = createSampler({ ps: g.ps }); s2.start(); s2.stop(); assert.strictEqual(g.procs[0].killed, true);
});

test('sampler: a runner that cannot stream means gave-up immediately (the caller falls back to netstat)', () => {
  const s = createSampler({ ps: { stream: () => ({ ok: false, missing: true }) } }); s.start();
  assert.strictEqual(s.status().gaveUp, true); assert.strictEqual(s.latest(), null);
});

test('Deep Network Guard records from the sampler when it is fresh, and falls back to netstat (locale-dependent parser kept) when it is not', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-deep-'));
  try {
    let fresh = { rows: [tcp('Established', '10.0.0.2', 50000, '203.0.113.5', 443, 11)], names: new Map([[11, 'agent.exe']]) };
    const sampler = { start() {}, stop() {}, latest: () => fresh };
    let netstatCalls = 0;
    const netstat = 'Active Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    10.0.0.2:50001         203.0.113.6:443        ESTABLISHED     12\r\n';
    const deep = ND.createDeep({ root: dir, getConfig: () => ({ network: { deep: {} } }), log: () => {}, sampler, runNetstat: async () => { netstatCalls++; return netstat; }, runTasklist: async () => '"other.exe","12"\r\n' });
    await deep.tick();
    assert.strictEqual(netstatCalls, 0); assert.strictEqual(deep.status().source, 'sampler');
    let ev = deep.readEvents({ limit: 10 }); assert.ok(ev.some((e) => e.pid === 11 && e.process === 'agent.exe'));
    fresh = null;
    await deep.tick();
    assert.strictEqual(netstatCalls, 1); assert.strictEqual(deep.status().source, 'netstat');
    ev = deep.readEvents({ limit: 10 }); assert.ok(ev.some((e) => e.pid === 12 && e.process === 'other.exe' && e.type === 'open'));
    assert.ok(ev.some((e) => e.pid === 11 && e.type === 'close'), 'the sampler connection is closed when it disappears');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the sampler script is locale independent and read-only: Get-NetTCPConnection and Get-NetUDPEndpoint, no netstat, no changes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'powershell', 'Network', 'Stream-Connections.ps1'), 'utf8');
  assert.match(src, /Get-NetTCPConnection/); assert.match(src, /Get-NetUDPEndpoint/); assert.match(src, /ParentPid/);
  assert.doesNotMatch(src, /netstat|Set-|Remove-|New-NetFirewallRule|Invoke-Expression|Start-Process/i);
});
