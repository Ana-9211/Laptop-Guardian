'use strict';
// Firewall posture audit, change detection, beaconing, posture score, and the firewall-log route. Synthetic data only.
const test = require('node:test');
const assert = require('node:assert');
const { startBridge, fakeRunner } = require('./lib/harness');
const { makeNetworkSnapshot } = require('./fixtures/network-fixture');
const NP = require('../src/bridge/lib/netposture');
const NO = require('../src/bridge/lib/netoffers');
const R = require('../src/bridge/lib/remediation');

const rule = (o) => ({ name: 'r' + Math.random(), displayName: 'App', enabled: true, direction: 'Inbound', action: 'Allow', program: 'C:\\Apps\\a.exe', protocol: 'TCP', localPort: '8080', remoteAddress: 'Any', programMissing: false, programUserWritable: false, ...o });
const snapWith = (posture, profiles) => makeNetworkSnapshot({ firewall: { profiles: profiles || [{ name: 'Private', enabled: true, defaultInboundAction: 'Block', defaultOutboundAction: 'Allow' }], rules: [], posture } });

test('posture: default-inbound-allow, many any-address rules, missing and user-writable programs, duplicates', () => {
  const posture = [
    ...Array.from({ length: 5 }, (_, i) => rule({ name: 'any' + i, displayName: 'Tool ' + i, program: `C:\\Apps\\t${i}.exe` })),
    rule({ name: 'gone', displayName: 'Old game', program: 'D:\\Games\\old.exe', programMissing: true, remoteAddress: '10.0.0.0/8' }),
    rule({ name: 'wr', displayName: 'Portable', program: 'C:\\Users\\u\\Downloads\\p.exe', programUserWritable: true, remoteAddress: '10.0.0.0/8' }),
    rule({ name: 'd1', displayName: 'Dup', program: 'C:\\Apps\\dup.exe', remoteAddress: '10.0.0.0/8' }), rule({ name: 'd2', displayName: 'Dup', program: 'C:\\Apps\\dup.exe', remoteAddress: '10.0.0.0/8' }),
    rule({ name: 'win', displayName: 'Core Networking', program: 'C:\\Windows\\System32\\svchost.exe' }),
    rule({ name: 'off', enabled: false, program: 'D:\\x.exe', programMissing: true }),
    rule({ name: 'out', direction: 'Outbound', program: 'D:\\y.exe', programMissing: true }),
  ];
  const f = NP.postureFindings(snapWith(posture, [{ name: 'Public', enabled: true, defaultInboundAction: 'Allow', defaultOutboundAction: 'Allow' }]));
  const rules = f.map((x) => x.rule);
  for (const r of ['fw-default-inbound-allow', 'fw-inbound-allow-any', 'fw-rule-missing-program', 'fw-rule-user-writable-program', 'fw-duplicate-rules']) assert.ok(rules.includes(r), r);
  assert.strictEqual(f.filter((x) => x.rule === 'fw-rule-missing-program').length, 1, 'disabled and outbound rules are ignored');
  for (const x of f) assert.ok(x.manual && x.manual.reason && x.manual.action.actionId === 'system.open-settings', `${x.id}: manual step with a reason`);
});

test('posture findings become Action Center findings with the manual step kept, and never offer enable-profile for a default-policy finding', () => {
  const f = NP.postureFindings(snapWith([], [{ name: 'Public', enabled: true, defaultInboundAction: 'Allow', defaultOutboundAction: 'Allow' }]));
  const out = NO.toActionFindings(f, { identity: [], guardianRoot: 'C:\\g' }, []);
  assert.strictEqual(out[0].actions.length, 0);
  assert.ok(out[0].manual.reason.length > 20);
});

test('posture score lists every deduction and a clean snapshot scores 100 with an explanation', () => {
  const clean = snapWith([]);
  assert.deepStrictEqual(NP.postureScore(clean, []), { score: 100, reasons: [{ points: 0, reason: 'No firewall or connection problems found in the latest snapshot.' }] });
  const bad = makeNetworkSnapshot();   // Public profile is off in the fixture
  const s = NP.postureScore(bad, [{ rule: 'unexpected-listener', risk: 'HIGH', title: 'rdp' }, { rule: 'beaconing', title: 'b' }]);
  assert.strictEqual(s.score, 100 - 20 - 10 - 4);
  assert.strictEqual(s.reasons.reduce((a, r) => a + r.points, 0), s.score - 100);
});

test('changes since the previous snapshot: new listeners and first-seen programs, nothing for an identical snapshot', () => {
  const before = makeNetworkSnapshot();
  assert.deepStrictEqual(NP.changeFindings(before, before), []);
  const after = makeNetworkSnapshot();
  after.connections = [...after.connections, { proto: 'TCP', state: 'Listen', localAddress: '0.0.0.0', localPort: 8081, remoteAddress: '', remotePort: 0, pid: 700 }, { proto: 'TCP', state: 'Established', localAddress: '192.168.1.20', localPort: 52000, remoteAddress: '203.0.113.50', remotePort: 443, pid: 700 }];
  after.processes[700] = { name: 'newtool', path: 'C:\\Tools\\newtool.exe', signed: false };
  const f = NP.changeFindings(after, before);
  assert.deepStrictEqual(f.map((x) => x.rule).sort(), ['first-seen-program', 'new-listener']);
  const acts = NO.toActionFindings(f, { identity: [], guardianRoot: 'C:\\g', bridgePort: 7878 }, []);
  for (const x of acts) assert.ok(x.actions.length > 0 || x.manual, x.id);
  assert.ok(acts.every((x) => x.actions.every((a) => R.byId.get(a.actionId))));
});

test('beaconing: a steady interval is flagged with a block offer; irregular or fast traffic is not', () => {
  const t0 = Date.parse('2026-10-07T08:00:00Z');
  const mk = (gaps, pid = 5) => { let t = t0; return gaps.map((g) => { t += g; return { type: 'open', ts: new Date(t).toISOString(), pid, remoteAddress: '203.0.113.9', remotePort: 443, process: { name: 'agent', path: 'C:\\Tools\\agent.exe' } }; }); };
  const steady = NP.beaconFindings(mk([60000, 60500, 59800, 60200, 60100, 59900, 60000]));
  assert.strictEqual(steady.length, 1);
  assert.match(steady[0].title, /steady rhythm/);
  const acts = NO.toActionFindings(steady, { identity: [], guardianRoot: 'C:\\g' }, []);
  assert.ok(acts[0].actions.some((a) => a.actionId === 'firewall.block-remote'));
  assert.ok(acts[0].actions.some((a) => a.actionId === 'process.stop'));
  assert.deepStrictEqual(NP.beaconFindings(mk([5000, 90000, 2000, 150000, 20000, 70000, 1000])), []);
  assert.deepStrictEqual(NP.beaconFindings(mk([1000, 1000, 1000, 1000, 1000, 1000, 1000])), [], 'faster than 5 s is ordinary traffic');
  assert.deepStrictEqual(NP.beaconFindings(mk([60000, 60000, 60000])), [], 'too few hits');
});

test('Network Guard through the bridge: findings include the posture audit, the view carries a posture score, and the firewall log route degrades honestly', async () => {
  const snap = snapWith([rule({ name: 'gone', displayName: 'Old game', program: 'D:\\Games\\old.exe', programMissing: true })]);
  const ps = fakeRunner({
    'Network/Get-NetworkSnapshot.ps1': () => ({ ok: true, data: snap }),
    'Network/Get-FirewallEvents.ps1': () => ({ ok: true, data: { available: false, reason: 'Reading the Security log needs administrator rights.', items: [] } }),
  });
  const b = await startBridge({ ps });
  try {
    const r = await b.post('/api/network/snapshot', {});
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    assert.ok(r.json.findings.some((f) => f.rule === 'fw-rule-missing-program'));
    assert.ok(typeof r.json.posture.score === 'number' && r.json.posture.reasons.length > 0);
    const e = await b.get('/api/network/fw-events?hours=6');
    assert.strictEqual(e.json.available, false); assert.match(e.json.reason, /administrator/);
    assert.deepStrictEqual(ps.calls.find((c) => c.rel === 'Network/Get-FirewallEvents.ps1').args, ['-Max', '500', '-Hours', '6']);
  } finally { b.close(); }
});

test('DNS findings: odd servers offer a restore, plain public resolvers offer DoH, app-level DoH explains the bypass; provider table matches PowerShell', () => {
  const snap = makeNetworkSnapshot({ identity: { gateway: ['192.168.1.1'], dns: [], dhcp: [] }, dnsConfig: { interfaces: [{ index: 7, alias: 'Wi-Fi', dhcp: true, dnsServers: ['203.0.113.53'] }, { index: 9, alias: 'Ethernet', dhcp: false, dnsServers: ['1.1.1.1', '1.0.0.1'] }, { index: 3, alias: 'Home', dhcp: true, dnsServers: ['192.168.1.1'] }], doh: [] } });
  snap.connections = [...snap.connections, { proto: 'TCP', state: 'Established', localAddress: '192.168.1.20', localPort: 55000, remoteAddress: '8.8.8.8', remotePort: 443, pid: 100 }];
  const f = NP.dnsFindings(snap);
  assert.deepStrictEqual(f.map((x) => x.rule).sort(), ['app-level-doh', 'plain-public-dns', 'unusual-dns-server']);
  const acts = NO.toActionFindings(f, { identity: [], guardianRoot: 'C:\\g' }, []);
  const odd = acts.find((x) => x.rule === 'unusual-dns-server'); assert.deepStrictEqual(odd.actions.map((a) => a.actionId), ['dns.doh-restore']); assert.strictEqual(odd.actions[0].eligible, true);
  const plain = acts.find((x) => x.rule === 'plain-public-dns'); assert.deepStrictEqual(plain.actions.map((a) => [a.actionId, a.params.provider, a.params.interfaceIndex]), [['dns.doh-enable', 'cloudflare', '9']]);
  assert.deepStrictEqual(plain.actions[0].requiredAcks, ['dns-provider']);
  const app = acts.find((x) => x.rule === 'app-level-doh'); assert.match(app.what, /bypasses/); assert.ok(app.manual.reason);
  const registered = NP.dnsFindings({ ...snap, dnsConfig: { ...snap.dnsConfig, doh: [{ server: '1.1.1.1', template: 't' }, { server: '1.0.0.1', template: 't' }] } });
  assert.ok(!registered.some((x) => x.rule === 'plain-public-dns'), 'no finding once DoH is registered');
  const ps = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'powershell', 'Actions', 'NetworkActions', 'Doh.ps1'), 'utf8');
  for (const [k, p] of Object.entries(NP.DOH_PROVIDERS)) { for (const s of p.servers) assert.ok(ps.includes(`'${s}'`), `${k} ${s} in Doh.ps1`); }
});

test('per-program summary and timeline: counts, distinct hosts, first seen only from real events, bytes null, and the route', async () => {
  const NPG = require('../src/bridge/lib/netprograms');
  const snap = makeNetworkSnapshot();
  const rows = NPG.summarizePrograms({ snapshot: snap, events: [{ ts: '2026-10-07T08:00:00+05:30', type: 'open', process: 'helper.exe' }, { ts: '2026-10-07T09:00:00+05:30', type: 'open', process: 'helper.exe' }] });
  const helper = rows.find((r) => r.name === 'helper'); const mystery = rows.find((r) => r.name === 'mystery');
  assert.strictEqual(helper.connections, 3); assert.strictEqual(helper.remoteHosts, 3); assert.strictEqual(helper.firstSeen, '2026-10-07T08:00:00+05:30'); assert.strictEqual(helper.bytes, null);
  assert.strictEqual(mystery.connections, 12); assert.strictEqual(mystery.firstSeen, null, 'no event, no guess');
  assert.strictEqual(rows[0].name, 'mystery', 'busiest first'); assert.ok(rows.find((r) => r.name === 'remsvc').listening === 1);
  const now = Date.parse('2026-10-07T12:00:00+05:30');
  const tl = NPG.buildTimeline({ events: [{ ts: '2026-10-07T11:10:00+05:30', type: 'open' }, { ts: '2026-10-07T11:20:00+05:30', type: 'open' }, { ts: '2026-10-07T11:30:00+05:30', type: 'close' }], now });
  assert.strictEqual(tl.source, 'deep'); const hour = tl.buckets.find((x) => x.opens === 2); assert.strictEqual(hour.closes, 1);
  const tl2 = NPG.buildTimeline({ events: [], history: [{ ts: '2026-10-07T10:00:00+05:30', established: 5 }, { ts: '2026-09-01T10:00:00+05:30', established: 9 }], now });
  assert.deepStrictEqual(tl2, { source: 'snapshots', unit: 'snapshot', buckets: [{ ts: '2026-10-07T10:00:00+05:30', opens: 5, closes: 0 }] });
});

test('GET /api/network/programs answers read-only from the snapshot and runs nothing', async () => {
  const snap = makeNetworkSnapshot();
  const ps = fakeRunner({ 'Network/Get-NetworkSnapshot.ps1': () => ({ ok: true, data: snap }) });
  const b = await startBridge({ ps });
  try {
    let r = await b.get('/api/network/programs'); assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.json.programs, []);
    await b.post('/api/network/snapshot', {});
    const before = ps.calls.length;
    r = await b.get('/api/network/programs');
    assert.ok(r.json.programs.length >= 4); assert.ok(r.json.programs.every((p) => p.bytes === null)); assert.match(r.json.bytesNote, /never does/);
    assert.ok(['deep', 'snapshots'].includes(r.json.timeline.source));
    assert.strictEqual(ps.calls.length, before, 'no PowerShell call for a read');
  } finally { b.close(); }
});
