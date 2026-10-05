'use strict';
// Network Guard: target rules, findings, offers, storage, Deep Network Guard sampling and the HTTP surface.
// Everything uses synthetic snapshots, injected netstat output and temp roots. Nothing here reads real connections,
// captures traffic, edits the hosts file or touches the firewall.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startBridge, fakeRunner } = require('./lib/harness');
const { makeNetworkSnapshot } = require('./fixtures/network-fixture');
const NG = require('../src/bridge/lib/netguard');
const NF = require('../src/bridge/lib/netfindings');
const NO = require('../src/bridge/lib/netoffers');
const NS = require('../src/bridge/lib/netstore');
const ND = require('../src/bridge/lib/netdeep');
const R = require('../src/bridge/lib/remediation');

const tmp = (p = 'guardian-net-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const clean = (d) => fs.rmSync(d, { recursive: true, force: true });

// ---------- target rules ----------
test('remote targets: refuses loopback, broad ranges, gateway/DNS/DHCP, multicast, link-local and garbage', () => {
  const id = ['192.168.1.1', '1.1.1.1'];
  for (const bad of ['nope', '127.0.0.1', '0.0.0.0', '224.0.0.5', '169.254.9.9', '10.0.0.0/4', '0.0.0.0/0', '::1', 'fe80::1', '192.168.1.1', '192.168.1.0/24', '1.1.1.1', '8.8.8.8/7', '2001:db8::/8']) assert.ok(NG.refuseRemote(bad, id), bad);
  for (const good of ['203.0.113.7', '198.51.100.0/24', '10.20.30.40', '2001:db8::1']) assert.strictEqual(NG.refuseRemote(good, id), null, good);
  assert.match(NG.refuseRemote('1.1.1.1', id), /gateway, DNS or DHCP/);
});

test('port, program and domain targets', () => {
  for (const p of [0, 53, 67, 68, 546, 547, 70000, 'x']) assert.ok(NG.refusePort(p, 7878), String(p));
  assert.ok(NG.refusePort(7878, 7878)); assert.strictEqual(NG.refusePort(3389, 7878), null);
  assert.ok(NG.refuseProgram('C:\\Windows\\System32\\svchost.exe')); assert.ok(NG.refuseProgram('C:\\x\\readme.txt')); assert.ok(NG.refuseProgram('C:\\Users\\u\\powershell.exe'));
  assert.ok(NG.refuseProgram('C:\\Guardian\\bin\\x.exe', { guardianRoot: 'C:\\Guardian' }));
  assert.strictEqual(NG.refuseProgram('C:\\Tools\\updater.exe'), null);
  for (const d of ['*.example.org', 'a/b.com', '1.2.3.4', 'localhost', 'bad domain.com', 'www.microsoft.com', 'update.windowsupdate.com', 'login.live.com']) assert.ok(NG.refuseDomain(d), d);
  assert.strictEqual(NG.refuseDomain('tracker.adnetwork.net'), null);
  assert.match(NG.staticRefusal('dns.block-domain', { domain: 'tracker.adnetwork.net' }, { dnsFilteringEnabled: false }), /filtering is off/);
  assert.strictEqual(NG.staticRefusal('dns.block-domain', { domain: 'tracker.adnetwork.net' }, { dnsFilteringEnabled: true }), null);
});

test('hosts block is read from the managed section only', () => {
  const d = tmp(); const f = path.join(d, 'hosts');
  fs.writeFileSync(f, '127.0.0.1 localhost\r\n0.0.0.0 user-own-block.example\r\n# BEGIN LAPTOP GUARDIAN DNS BLOCKS (x)\r\n0.0.0.0 a.example.org\r\n0.0.0.0 b.example.org\r\n# END LAPTOP GUARDIAN DNS BLOCKS\r\n');
  try { assert.deepStrictEqual(NG.readHostsBlock(f).domains, ['a.example.org', 'b.example.org']); assert.deepStrictEqual(NG.readHostsBlock(path.join(d, 'missing')).domains, []); } finally { clean(d); }
});

// ---------- findings ----------
const procsFile = new Set(['c:\\users\\testuser\\appdata\\roaming\\helper\\helper.exe']);
const findingsFor = (snap, extra = {}) => NF.buildNetworkFindings({ snapshot: snap, persistentPaths: procsFile, ...extra });

test('each rule fires on its evidence and stays quiet on benign activity', () => {
  const f = findingsFor(makeNetworkSnapshot());
  const rules = f.map((x) => x.rule);
  assert.ok(rules.includes('unsigned-outbound'), 'unsigned program with outbound connections');
  assert.ok(rules.includes('unexpected-listener'), 'unsigned service listening on RDP');
  assert.ok(rules.includes('firewall-off'));
  assert.ok(rules.includes('unknown-many-destinations'));
  assert.ok(rules.includes('persistent-unusual-remote'));
  const un = f.find((x) => x.rule === 'unsigned-outbound'); assert.strictEqual(un.risk, 'HIGH', 'persistent + user-writable path raises it');
  assert.ok(un.why.length >= 2 && un.evidence.some((e) => e.label === 'Path'));
  const rdp = f.find((x) => x.listener && x.listener.port === 3389); assert.strictEqual(rdp.risk, 'HIGH'); assert.match(rdp.title, /Remote Desktop/);
  assert.ok(!f.some((x) => x.process && x.process.name === 'chrome'), 'signed browser is not flagged');
  assert.ok(!f.some((x) => x.listener && x.listener.port === 445), 'normal Windows listener ignored');
  assert.ok(!f.some((x) => x.listener && x.listener.port === 5173), 'loopback dev server ignored');
  const quiet = makeNetworkSnapshot({ connections: [], firewall: { profiles: [{ name: 'Public', enabled: true }], rules: [] } });
  assert.deepStrictEqual(findingsFor(quiet), []);
});

test('thresholds are configurable and burst detection uses them', () => {
  const snap = makeNetworkSnapshot({ connections: Array.from({ length: 30 }, (_, i) => ({ proto: 'TCP', state: 'Established', localAddress: '192.168.1.20', localPort: 40000 + i, remoteAddress: '203.0.113.9', remotePort: 443, pid: 100 })), firewall: { profiles: [], rules: [] } });
  assert.ok(!findingsFor(snap).some((x) => x.rule === 'connection-burst'));
  assert.ok(findingsFor(snap, { thresholds: { burstConnections: 20 } }).some((x) => x.rule === 'connection-burst' && /30 established/.test(x.why.join(' '))));
});

test('Deep Network Guard events can raise a rapid-connection finding', () => {
  const now = Date.now();
  const events = Array.from({ length: 60 }, (_, i) => ({ ts: new Date(now - i * 500).toISOString(), type: 'open', proto: 'TCP', remoteAddress: `203.0.113.${i + 1}`, remotePort: 443, pid: 100 }));
  const f = findingsFor(makeNetworkSnapshot({ connections: [], firewall: { profiles: [], rules: [] } }), { deepEvents: events, now });
  assert.ok(f.some((x) => /opened 60 connections/.test(x.title)));
});

test('DNS policy conflict: a blocked name that still resolves to a real address', () => {
  const f = findingsFor(makeNetworkSnapshot({ connections: [], firewall: { profiles: [], rules: [] } }), { dnsBlocked: ['tracker.adnetwork.net', 'example.org'] });
  assert.deepStrictEqual(f.filter((x) => x.rule === 'dns-policy-conflict').map((x) => x.dnsName).sort(), ['example.org', 'tracker.adnetwork.net']);
  assert.strictEqual(findingsFor(makeNetworkSnapshot({ connections: [], firewall: { profiles: [], rules: [] } }), { dnsBlocked: [] }).filter((x) => x.rule === 'dns-policy-conflict').length, 0);
});

// ---------- offers: nothing automatic, only catalog actions ----------
const offerCtx = { identity: ['192.168.1.1', '1.1.1.1'], guardianRoot: 'C:\\Guardian', bridgePort: 7878 };

test('findings only OFFER allowlisted actions; high risk never blocks by itself; protected targets are ineligible', () => {
  const raw = findingsFor(makeNetworkSnapshot());
  assert.ok(raw.every((f) => !('actions' in f)), 'detection alone carries no actions');
  const all = NO.toActionFindings(raw, offerCtx);
  for (const f of all) for (const a of f.actions) assert.ok(R.byId.has(a.actionId), a.actionId);
  const un = all.find((f) => f.rule === 'unsigned-outbound');
  const labels = un.actions.map((a) => a.label);
  assert.deepStrictEqual(labels.slice(0, 4), ['Stop process', 'Block temporarily (24 h)', 'Create block rule', 'Block this address (24 h)']);
  assert.strictEqual(un.actions[1].params.duration, '24h'); assert.strictEqual(un.actions[2].params.duration, 'permanent');
  assert.strictEqual(un.investigate.label, 'Investigate'); assert.match(un.investigate.href, /#\/network\?finding=/);
  const listener = all.find((f) => f.listener);
  assert.ok(listener.actions.some((a) => a.actionId === 'firewall.block-port' && a.params.port === 3389 && a.eligible));
  const fw = all.find((f) => f.rule === 'firewall-off'); assert.deepStrictEqual(fw.actions.map((a) => a.actionId), ['firewall.enable-profile']);
  const sys = NO.toActionFindings([{ id: 'x', rule: 'unsigned-outbound', kind: 'network', title: 't', process: { pid: 9, name: 'svchost', path: 'C:\\Windows\\System32\\svchost.exe' }, evidence: [{ label: 'Examples', value: '1.1.1.1:443, 8.8.8.8:443' }], risk: 'HIGH', why: [] }], offerCtx)[0];
  assert.ok(sys.actions.filter((a) => a.actionId !== 'process.stop' || true).every((a) => a.eligible === false), 'every action on a protected Windows program is ineligible');
  assert.match(sys.actions.find((a) => a.actionId === 'firewall.block-remote').ineligibleReason, /gateway, DNS or DHCP/);
});

// ---------- storage ----------
test('snapshot storage keeps latest, history rows, de-duplicated DNS history, and prunes by age and size', () => {
  const root = tmp(); const cfg = { network: { snapshot: { retentionDays: 30, maxMB: 1 } } };
  const st = NS.createNetStore(root, () => cfg);
  try {
    const snap = makeNetworkSnapshot();
    st.saveSnapshot(snap, 5); st.saveSnapshot({ ...snap, generatedAt: new Date(Date.now() + 1000).toISOString() }, 4);
    assert.ok(st.readLatest().connections.length > 5);
    const h = st.readHistory('all'); assert.strictEqual(h.length, 2);
    assert.strictEqual(h[0].established, 18); assert.strictEqual(h[0].findings, 5); assert.strictEqual(h[0].firewallOff, 1); assert.strictEqual(h[0].unsignedProcesses, 1);
    assert.strictEqual(st.readDnsHistory().length, 2, 'the same name+address is stored once');
    // age: an old row is dropped
    fs.appendFileSync(st.dirs.history, `${JSON.stringify({ ts: new Date(Date.now() - 40 * 86400000).toISOString(), established: 1 })}\n`);
    st.prune(); assert.ok(!st.readHistory('all').some((r) => r.established === 1));
    // size cap: 1 MB cap with a flood of rows keeps the file under the cap and the newest rows
    for (let i = 0; i < 6000; i++) fs.appendFileSync(st.dirs.history, `${JSON.stringify({ ts: new Date().toISOString(), established: i, pad: 'x'.repeat(200) })}\n`);
    st.prune(); assert.ok(fs.statSync(st.dirs.history).size <= NS.MB, 'size cap enforced'); assert.strictEqual(st.readHistory('all').at(-1).established, 5999);
  } finally { clean(root); }
});

// ---------- Deep Network Guard ----------
const NETSTAT = (rows) => `\nActive Connections\n\n  Proto  Local Address          Foreign Address        State           PID\n${rows.join('\n')}\n`;
const rowA = '  TCP    192.168.1.20:50001     203.0.113.5:443        ESTABLISHED     1234';
const rowB = '  TCP    192.168.1.20:50002     203.0.113.6:443        ESTABLISHED     1234';
const rowW = '  TCP    192.168.1.20:50003     203.0.113.7:443        TIME_WAIT       0';
const rowL = '  TCP    0.0.0.0:3389           0.0.0.0:0              LISTENING       777';
const rowV6 = '  TCP    [::1]:135              [::]:0                 LISTENING       888';
const rowU = '  UDP    0.0.0.0:5353           *:*                                    1234';
const TASKS = '"chrome.exe","1234","Console","1","50,000 K"\r\n"remsvc.exe","777","Services","0","9,000 K"\r\n';

function deepHarness({ cfg, outputs }) {
  const root = tmp(); let i = 0; let t = Date.UTC(2026, 9, 5, 10, 0, 0); const logged = [];
  const config = { network: { deep: { enabled: false, retentionDays: 7, maxMB: 100, sampleSec: 5, ...(cfg || {}) } } };
  const d = ND.createDeep({ root, getConfig: () => config, log: (e) => logged.push(e), runNetstat: async () => outputs[Math.min(i++, outputs.length - 1)], runTasklist: async () => TASKS, now: () => t, setIntervalFn: () => ({ unref() {} }), clearIntervalFn: () => {} });
  return { d, root, logged, advance: (ms) => { t += ms; }, clean: () => clean(root) };
}

test('netstat parsing handles IPv4, IPv6, UDP and ignores noise', () => {
  const rows = ND.parseNetstat(NETSTAT([rowA, rowV6, rowU, rowL, 'garbage line']));
  assert.strictEqual(rows.length, 4);
  assert.deepStrictEqual(rows[0], { proto: 'TCP', localAddress: '192.168.1.20', localPort: 50001, remoteAddress: '203.0.113.5', remotePort: 443, state: 'Established', pid: 1234 });
  assert.strictEqual(rows[1].localAddress, '::1'); assert.strictEqual(rows[2].proto, 'UDP'); assert.strictEqual(rows[2].remotePort, 0); assert.strictEqual(rows[3].state, 'Listening');
});

test('deep sampling records open and close events with duration, skips TIME_WAIT, and keeps NO payload fields', async () => {
  const h = deepHarness({ outputs: [NETSTAT([rowA, rowW, rowL]), NETSTAT([rowA, rowB, rowL]), NETSTAT([rowB])] });
  try {
    assert.strictEqual(h.d.active(), false, 'off by default');
    await h.d.tick(); h.advance(5000); await h.d.tick(); h.advance(25000); await h.d.tick();
    const ev = h.d.readEvents({ limit: 100 }).reverse();
    assert.deepStrictEqual(ev.map((e) => `${e.type}:${e.localPort}`), ['open:50001', 'open:3389', 'open:50002', 'close:50001', 'close:3389']);
    const close = ev.find((e) => e.type === 'close' && e.localPort === 50001); assert.strictEqual(close.durationSec, 30); assert.strictEqual(close.process, 'chrome.exe');
    const allowed = new Set(['ts', 'type', 'proto', 'localAddress', 'localPort', 'remoteAddress', 'remotePort', 'state', 'pid', 'process', 'durationSec']);
    for (const e of ev) for (const k of Object.keys(e)) assert.ok(allowed.has(k), `unexpected field ${k}: only connection metadata is stored`);
    assert.ok(!/payload|packet|body|header|url|cookie/i.test(JSON.stringify(ev)));
  } finally { h.clean(); }
});

test('deep retention: old day files are deleted, and the size cap trims the oldest data first', async () => {
  const h = deepHarness({ cfg: { retentionDays: 2, maxMB: 5 }, outputs: [NETSTAT([rowA])] });
  try {
    const dir = path.join(h.root, 'data', 'network', 'deep'); fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'events-2026-09-20.jsonl'); fs.writeFileSync(old, '{"ts":"2026-09-20T10:00:00Z"}\n');
    const mid = path.join(dir, 'events-2026-10-04.jsonl'); fs.writeFileSync(mid, `${'{"ts":"2026-10-04T10:00:00Z","pad":"'.padEnd(10)}${'x'.repeat(5 * 1024 * 1024)}"}\n`);
    await h.d.tick();
    assert.ok(!fs.existsSync(old), 'older than retention: deleted');
    assert.ok(!fs.existsSync(mid), 'over the cap: oldest file removed first');
    assert.ok(h.d.status().storageMB <= 5);
    assert.strictEqual(h.d.status().retentionDays, 2);
  } finally { h.clean(); }
});

test('deep export (jsonl and csv), delete, start and stop', async () => {
  const h = deepHarness({ outputs: [NETSTAT([rowA, rowU]), NETSTAT([])] });
  try {
    await h.d.tick(); await h.d.tick();
    assert.strictEqual(h.d.exportData('jsonl').split('\n').length, 4);
    const csv = h.d.exportData('csv'); assert.match(csv.split('\n')[0], /^ts,type,proto,localAddress/); assert.strictEqual(csv.split('\n').length, 5);
    assert.strictEqual(h.d.start().active, true); assert.strictEqual(h.d.stop().active, false);
    assert.strictEqual(h.d.deleteAll().deletedFiles, 1); assert.strictEqual(h.d.readEvents().length, 0); assert.strictEqual(h.d.status().storageBytes, 0);
  } finally { h.clean(); }
});

// ---------- HTTP ----------
const snapshotRunner = (extra = {}) => fakeRunner({
  'Network/Get-NetworkSnapshot.ps1': () => ({ ok: true, data: makeNetworkSnapshot() }),
  'Actions/Invoke-GuardianAction.ps1': () => ({ ok: true, data: { ok: true, needsAdmin: true, needsElevation: true, identityKey: '', details: {}, errors: ['needs administrator'] } }),
  'Actions/Get-RemediationInfo.ps1': () => ({ ok: true, data: { ok: true, apps: [], revo: { available: false } } }),
  ...extra,
});
const hostsWith = (domains) => { const d = tmp('lg-hosts-'); const f = path.join(d, 'hosts'); fs.writeFileSync(f, `127.0.0.1 localhost\n${domains.length ? `# BEGIN LAPTOP GUARDIAN DNS BLOCKS (x)\n${domains.map((x) => `0.0.0.0 ${x}`).join('\n')}\n# END LAPTOP GUARDIAN DNS BLOCKS\n` : ''}`); return { f, d }; };

test('HTTP: snapshot on demand produces findings, rules (with expiry) and enriched connections; nothing runs by itself', async () => {
  const ps = snapshotRunner(); const h = hostsWith([]);
  const b = await startBridge({ ps, opts: { hostsPath: h.f } });
  try {
    const empty = (await b.get('/api/network/current')).json; assert.strictEqual(empty.snapshot, null);
    assert.strictEqual(ps.calls.filter((c) => c.rel.startsWith('Network/')).length, 0, 'viewing never runs a collector');
    const r = await b.post('/api/network/snapshot'); assert.strictEqual(r.status, 200);
    const v = r.json; assert.ok(v.snapshot.connections.length > 5); assert.strictEqual(v.snapshot.connections[0].process.name, 'chrome');
    assert.ok(v.findings.length >= 4); assert.ok(v.findings.every((f) => f.actions));
    const exp = v.rules.find((x) => x.name === 'LG-1759000000-aaaaaa'); assert.strictEqual(exp.expired, true); assert.match(exp.expiresAt, /^2026-10-02/);
    assert.strictEqual(v.rules.find((x) => x.name === 'LG-1759100000-bbbbbb').expired, false);
    assert.match(v.privacy, /never sent to Gemini/);
    const st = (await b.get('/api/status')).json.network; assert.strictEqual(st.deepActive, false); assert.ok(st.lastSnapshotAt);
    const hist = (await b.get('/api/network/history?range=30')).json.items; assert.strictEqual(hist.length, 1);
    const merged = (await b.get('/api/remediation/findings')).json.findings; assert.ok(merged.some((f) => f.source === 'network'));
    assert.ok((await b.get('/api/actions?limit=20')).json.some((e) => e.action === 'network.snapshot'));
  } finally { b.close(); clean(h.d); }
});

test('HTTP: the generic settings save cannot switch on Deep Network Guard or DNS filtering', async () => {
  const b = await startBridge({ ps: snapshotRunner() });
  try {
    assert.strictEqual((await b.put('/api/config', { network: { deep: { enabled: true } } })).status, 400);
    assert.strictEqual((await b.put('/api/config', { network: { dnsFiltering: { enabled: true } } })).status, 400);
    assert.strictEqual(b.readConfig().network.deep.enabled, false, 'nothing was enabled'); assert.strictEqual(b.readConfig().network.dnsFiltering.enabled, false);
    const ok = await b.put('/api/config', { network: { deep: { retentionDays: 3, maxMB: 50 } } });
    assert.strictEqual(ok.status, 200); assert.strictEqual(ok.json.network.deep.enabled, false); assert.strictEqual(ok.json.network.deep.retentionDays, 3);
    assert.strictEqual((await b.put('/api/config', { network: { deep: { maxMB: 99999 } } })).status, 400);
  } finally { b.close(); }
});

test('HTTP: Deep Network Guard is opt-in, needs confirmation and acknowledgement, is audited, and can be exported and deleted', async () => {
  const b = await startBridge({ ps: snapshotRunner() });
  try {
    assert.strictEqual((await b.get('/api/network/deep')).json.active, false);
    assert.strictEqual((await b.post('/api/network/deep/start', {})).status, 400);
    assert.strictEqual((await b.post('/api/network/deep/start', { confirm: true })).status, 400);
    const on = await b.post('/api/network/deep/start', { confirm: true, acknowledged: true });
    assert.strictEqual(on.status, 200); assert.strictEqual(on.json.active, true); assert.ok(on.json.startedAt);
    assert.strictEqual(b.readConfig().network.deep.enabled, true);
    assert.strictEqual((await b.get('/api/status')).json.network.deepActive, true);
    const exp = await b.get('/api/network/deep/export?format=csv'); assert.strictEqual(exp.status, 200); assert.match(exp.text, /^ts,type,proto/);
    assert.strictEqual((await b.get('/api/network/deep/export?format=zip')).status, 400);
    assert.strictEqual((await b.post('/api/network/deep/delete', {})).status, 400);
    assert.strictEqual((await b.post('/api/network/deep/delete', { confirm: true })).status, 200);
    const off = await b.post('/api/network/deep/stop', {}); assert.strictEqual(off.json.active, false); assert.strictEqual(b.readConfig().network.deep.enabled, false);
    const acts = (await b.get('/api/actions?limit=30')).json.map((e) => e.action);
    for (const a of ['network.deep.start', 'network.deep.export', 'network.deep.delete', 'network.deep.stop']) assert.ok(acts.includes(a), a);
  } finally { b.close(); }
});

test('HTTP: DNS filtering is opt-in with rollback gating, and domain blocks are refused until it is on', async () => {
  const h = hostsWith(['x.example.org']); const ps = snapshotRunner();
  const b = await startBridge({ ps, opts: { hostsPath: h.f } });
  try {
    const refused = await b.post('/api/remediation/plan', { actionId: 'dns.block-domain', params: { domain: 'tracker.adnetwork.net' } });
    assert.strictEqual(refused.status, 403); assert.match(refused.json.error, /filtering is off/);
    assert.strictEqual((await b.post('/api/network/dns-filtering', { enabled: true, confirm: true })).status, 400, 'acknowledgement required');
    const on = await b.post('/api/network/dns-filtering', { enabled: true, confirm: true, acknowledged: true });
    assert.strictEqual(on.status, 200); assert.strictEqual(on.json.filtering.enabled, true); assert.deepStrictEqual(on.json.filtering.blocked, ['x.example.org']);
    const plan = await b.post('/api/remediation/plan', { actionId: 'dns.block-domain', params: { domain: 'tracker.adnetwork.net' } });
    assert.strictEqual(plan.status, 200); assert.strictEqual(plan.json.adminRequired, true); assert.deepStrictEqual(plan.json.requiredAcks, ['dns-limits']);
    const protectedName = await b.post('/api/remediation/plan', { actionId: 'dns.block-domain', params: { domain: 'www.microsoft.com' } });
    assert.strictEqual(protectedName.status, 403);
    const off = await b.post('/api/network/dns-filtering', { enabled: false, confirm: true });
    assert.strictEqual(off.status, 409, 'cannot turn filtering off while blocks exist: roll them back first');
    fs.writeFileSync(h.f, '127.0.0.1 localhost\n');
    assert.strictEqual((await b.post('/api/network/dns-filtering', { enabled: false, confirm: true })).status, 200);
  } finally { b.close(); clean(h.d); }
});

test('HTTP: firewall plans refuse gateway/DNS addresses, protected programs and ports, and route admin work through the elevation script only', async () => {
  const ps = snapshotRunner({ 'Actions/Request-ElevatedAction.ps1': () => ({ ok: true, data: { ok: true, requested: true, message: 'asked' } }) });
  const b = await startBridge({ ps });
  try {
    await b.post('/api/network/snapshot');
    const plan = (actionId, params) => b.post('/api/remediation/plan', { actionId, params });
    assert.strictEqual((await plan('firewall.block-remote', { remote: '192.168.1.1' })).status, 403);
    assert.strictEqual((await plan('firewall.block-remote', { remote: '1.1.1.1' })).status, 403);
    assert.strictEqual((await plan('firewall.block-remote', { remote: '0.0.0.0/0' })).status, 403);
    assert.strictEqual((await plan('firewall.block-port', { port: 53, protocol: 'UDP' })).status, 403);
    assert.strictEqual((await plan('firewall.block-program', { path: 'C:\\Windows\\System32\\svchost.exe', direction: 'Outbound' })).status, 403);
    assert.strictEqual((await plan('firewall.remove-rule', { name: 'CoreNet-DNS-Out-UDP' })).status, 400, 'only Guardian rule names are even valid parameters');
    assert.strictEqual((await plan('firewall.block-program', { path: 'C:\\Tools\\x.exe', direction: 'Sideways' })).status, 400);
    const ok = await plan('firewall.block-remote', { remote: '203.0.113.9', duration: '24h' });
    assert.strictEqual(ok.status, 200); assert.strictEqual(ok.json.adminRequired, true); assert.deepStrictEqual(ok.json.requiredAcks, ['connectivity']); assert.match(ok.json.summary, /OUTBOUND traffic to 203\.0\.113\.9/);
    assert.strictEqual((await b.post('/api/remediation/execute', { token: ok.json.token, confirm: true })).status, 400, 'connectivity acknowledgement required');
    const run = await b.post('/api/remediation/execute', { token: ok.json.token, confirm: true, acknowledged: ['connectivity'] });
    assert.strictEqual(run.json.status, 'awaiting-permission');
    const call = ps.calls.find((c) => c.rel === 'Actions/Request-ElevatedAction.ps1'); assert.strictEqual(call.args[1], 'firewall.block-remote');
  } finally { b.close(); }
});
