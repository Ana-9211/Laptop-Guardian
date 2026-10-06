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
