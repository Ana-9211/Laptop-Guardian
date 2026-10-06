'use strict';
/**
 * Firewall posture and local, rule-based detection. Pure functions over a snapshot (and the previous one): no I/O, no AI.
 * Windows Firewall is the enforcement engine; this is the audit and advice layer. Findings about rules that are not Guardian's own
 * have no one-click fix (Guardian only changes rules it created), so each carries a manual step and the reason.
 */
const FW_PAGE = { label: 'Open Windows Firewall settings', actionId: 'system.open-settings', params: { page: 'windows-firewall' } };
const manual = (reason) => ({ label: 'Fix it in Windows Firewall', href: '#/network', reason, action: FW_PAGE });
const winPathRe = /^[A-Za-z]:\\Windows\\/i;
const COMMON_RULE_NAMES = /^(core networking|network discovery|file and printer|wi-fi direct|mdns|cast)/i;

function ruleKey(r) { return [r.direction, r.action, String(r.program || '').toLowerCase(), r.protocol, r.localPort, r.remoteAddress].join('|'); }

/** Audit of the profiles and the enabled inbound-allow rules. */
function postureFindings(snapshot) {
  const out = [];
  const fw = (snapshot && snapshot.firewall) || {};
  for (const p of fw.profiles || []) {
    if (p.enabled !== false && String(p.defaultInboundAction).toLowerCase() === 'allow') {
      out.push({ id: `net:fw-default-inbound:${p.name}`, rule: 'fw-default-inbound-allow', kind: 'network', firewallProfile: p.name, risk: 'HIGH', title: `The ${p.name} firewall profile allows inbound connections by default`,
        what: 'Windows normally blocks inbound connections that no rule allows. Here the default is Allow, so anything listening is reachable.', why: [`DefaultInboundAction = ${p.defaultInboundAction}`], evidence: [{ label: 'Profile', value: p.name }], confidence: 0.9,
        manual: manual('Changing a default policy is a system-wide security decision that Guardian leaves to Windows Security > Firewall.') });
    }
  }
  const rules = (fw.posture || []).filter((r) => r.enabled !== false && String(r.direction).toLowerCase() === 'inbound' && String(r.action).toLowerCase() === 'allow');
  const anyRemote = rules.filter((r) => /^(any|\*)?$/i.test(String(r.remoteAddress || 'Any')) && !winPathRe.test(r.program || '') && !COMMON_RULE_NAMES.test(r.displayName || ''));
  if (anyRemote.length >= 5) {
    out.push({ id: 'net:fw-inbound-any', rule: 'fw-inbound-allow-any', kind: 'network', risk: 'MEDIUM', title: `${anyRemote.length} inbound allow rules accept connections from any address`,
      what: 'Each of these rules lets any computer on the network reach a program on this laptop. Many are normal (apps asking for access once), but old ones are worth pruning.', why: ['Inbound, Allow, remote address Any, program outside the Windows folder.'],
      evidence: anyRemote.slice(0, 8).map((r) => ({ label: r.displayName || r.name, value: r.program || `port ${r.localPort}` })), confidence: 0.6, manual: manual('These rules belong to other programs or to Windows; review them in Windows Defender Firewall with Advanced Security and disable the ones you do not recognise.') });
  }
  for (const r of rules.filter((x) => x.program && x.programMissing)) {
    out.push({ id: `net:fw-missing-program:${r.name}`, rule: 'fw-rule-missing-program', kind: 'network', risk: 'LOW', title: `Firewall rule "${r.displayName || r.name}" points at a program that is not there`,
      what: 'The program this rule allows no longer exists. If another program is later placed at that path it inherits the permission.', why: [`Missing: ${r.program}`], evidence: [{ label: 'Rule', value: r.displayName || r.name }, { label: 'Program', value: r.program }], confidence: 0.8,
      manual: manual('The rule is not one of Guardian\'s own, so Guardian will not remove it; delete it in Windows Defender Firewall with Advanced Security.') });
  }
  for (const r of rules.filter((x) => x.program && x.programUserWritable && !x.programMissing)) {
    out.push({ id: `net:fw-writable-program:${r.name}`, rule: 'fw-rule-user-writable-program', kind: 'network', risk: 'MEDIUM', title: `Inbound allow rule for a program in a user-writable folder: ${r.displayName || r.name}`,
      what: 'Any program running as you can replace that file and receive the permission the rule grants.', why: [`Program: ${r.program}`], evidence: [{ label: 'Rule', value: r.displayName || r.name }, { label: 'Program', value: r.program }], confidence: 0.6,
      manual: manual('The rule is not one of Guardian\'s own; review it in Windows Defender Firewall with Advanced Security.') });
  }
  const seen = new Map();
  for (const r of rules) { const k = ruleKey(r); seen.set(k, [...(seen.get(k) || []), r]); }
  const dups = [...seen.values()].filter((v) => v.length > 1);
  if (dups.length) {
    out.push({ id: 'net:fw-duplicates', rule: 'fw-duplicate-rules', kind: 'network', risk: 'LOW', title: `${dups.length} set${dups.length > 1 ? 's' : ''} of duplicate inbound allow rules`, what: 'Several rules grant exactly the same access. They are harmless but clutter the rule list.', why: ['Same direction, action, program, protocol, port and address.'],
      evidence: dups.slice(0, 6).map((v) => ({ label: v[0].displayName || v[0].name, value: `${v.length} copies` })), confidence: 0.8, manual: manual('The duplicates are not Guardian\'s own rules; remove the extra copies in Windows Defender Firewall with Advanced Security.') });
  }
  return out;
}

/** A 0 to 100 posture score with every deduction listed. */
function postureScore(snapshot, findings) {
  const reasons = []; let score = 100;
  const d = (n, why) => { score -= n; reasons.push({ points: -n, reason: why }); };
  for (const p of (snapshot && snapshot.firewall && snapshot.firewall.profiles) || []) if (p.enabled === false) d(20, `${p.name} firewall profile is off`);
  for (const f of findings) {
    if (f.rule === 'fw-default-inbound-allow') d(15, f.title);
    else if (f.rule === 'unexpected-listener') d(f.risk === 'HIGH' ? 10 : 4, f.title);
    else if (f.rule === 'unsigned-outbound') d(f.risk === 'HIGH' ? 8 : 3, f.title);
    else if (f.rule === 'fw-inbound-allow-any') d(5, f.title);
    else if (f.rule === 'fw-rule-user-writable-program') d(3, f.title);
    else if (f.rule === 'connection-burst' || f.rule === 'beaconing') d(4, f.title);
  }
  if (!reasons.length) reasons.push({ points: 0, reason: 'No firewall or connection problems found in the latest snapshot.' });
  return { score: Math.max(0, Math.min(100, score)), reasons };
}

/** New listeners and first-seen programs compared with the previous snapshot. */
function changeFindings(snapshot, previous) {
  if (!snapshot || !previous) return [];
  const out = [];
  const listen = (s) => new Map((s.connections || []).filter((c) => /listen/i.test(c.state) && !/^(127\.|::1$)/.test(c.localAddress)).map((c) => [`${c.localPort}:${(s.processes && s.processes[c.pid] && s.processes[c.pid].path) || c.pid}`, c]));
  const before = listen(previous);
  for (const [k, c] of listen(snapshot)) {
    if (before.has(k)) continue;
    const p = (snapshot.processes && snapshot.processes[c.pid]) || {};
    out.push({ id: `net:new-listener:${k}`, rule: 'new-listener', kind: 'network', risk: p.signed === true ? 'LOW' : 'MEDIUM', title: `${p.name || `pid ${c.pid}`} started listening on port ${c.localPort} since the last snapshot`, what: 'A program began accepting connections that was not doing so before.',
      why: ['Not present in the previous network snapshot.'], evidence: [{ label: 'Port', value: String(c.localPort) }, { label: 'Program', value: p.path || p.name || 'unknown' }], confidence: 0.5, listener: { port: c.localPort, pid: c.pid }, process: { pid: c.pid, name: p.name, path: p.path || null } });
  }
  const known = new Set(Object.values(previous.processes || {}).map((p) => String(p.path || '').toLowerCase()).filter(Boolean));
  for (const [pid, p] of Object.entries(snapshot.processes || {})) {
    if (!p.path || known.has(p.path.toLowerCase()) || winPathRe.test(p.path) || !(snapshot.connections || []).some((c) => String(c.pid) === pid && /established/i.test(c.state))) continue;
    out.push({ id: `net:first-seen:${p.path.toLowerCase()}`, rule: 'first-seen-program', kind: 'network', risk: p.signed === true ? 'LOW' : 'MEDIUM', title: `${p.name} is using the network for the first time`, what: 'Guardian did not see this program connect in the previous snapshot.',
      why: ['Not in the previous snapshot.'], evidence: [{ label: 'Path', value: p.path }, { label: 'Signature', value: p.signed === true ? `valid (${p.publisher || 'unknown publisher'})` : 'not valid' }], confidence: 0.4, process: { pid: Number(pid), name: p.name, path: p.path } });
  }
  return out;
}

/** Regular-interval connections from one program to one destination (beaconing), from Deep Network Guard open events. */
function beaconFindings(deepEvents, { minHits = 6, maxJitter = 0.15 } = {}) {
  const by = new Map();
  for (const e of deepEvents || []) { if (e.type !== 'open' || !e.remoteAddress) continue; const k = `${e.pid}|${e.remoteAddress}|${e.remotePort}`; if (!by.has(k)) by.set(k, []); by.get(k).push(Date.parse(e.ts)); }
  const out = [];
  for (const [k, ts] of by) {
    if (ts.length < minHits) continue;
    ts.sort((a, b) => a - b);
    const gaps = ts.slice(1).map((t, i) => t - ts[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    if (mean < 5000) continue;
    const dev = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length) / mean;
    if (dev > maxJitter) continue;
    const [pid, addr, port] = k.split('|');
    const ev = deepEvents.find((e) => String(e.pid) === pid) || {};
    out.push({ id: `net:beacon:${k}`, rule: 'beaconing', kind: 'network', risk: 'MEDIUM', title: `${(ev.process && ev.process.name) || `pid ${pid}`} connects to ${addr}:${port} at a steady rhythm`, what: `${ts.length} connections roughly every ${Math.round(mean / 1000)} seconds. Regular check-ins are normal for sync tools and also how some malware reports in.`,
      why: [`${ts.length} connections, interval variation ${Math.round(dev * 100)}%.`], evidence: [{ label: 'Destination', value: `${addr}:${port}` }, { label: 'Interval', value: `${Math.round(mean / 1000)} s` }], confidence: 0.4, process: { pid: Number(pid), name: ev.process && ev.process.name, path: (ev.process && ev.process.path) || null }, remote: { address: addr, port: Number(port) } });
  }
  return out;
}

module.exports = { postureFindings, postureScore, changeFindings, beaconFindings };
