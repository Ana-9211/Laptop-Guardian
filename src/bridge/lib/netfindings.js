'use strict';
/**
 * Network findings: explainable rules over a network snapshot (and optional Deep Network Guard events). Pure and deterministic.
 * A finding never blocks anything by itself. HIGH risk findings only OFFER actions (Investigate, Stop process, Block, Create
 * rule); each one needs your explicit confirmation in the Action Center flow.
 */
const { isPrivateIp, isLoopback, isUnspecified } = require('./netguard');

const DEFAULTS = { burstConnections: 100, burstDestinations: 40, unknownDestinations: 8, persistentDestinations: 5, newConnectionsPerMinute: 50 };
const HIGH_RISK_PORTS = new Map([[23, 'Telnet'], [2323, 'Telnet'], [3389, 'Remote Desktop'], [5900, 'VNC'], [5985, 'WinRM'], [5986, 'WinRM'], [4444, 'a common backdoor port'], [31337, 'a common backdoor port'], [1337, 'a common backdoor port'], [6667, 'IRC']]);
// Ports Windows itself keeps open on a normal laptop (file sharing, RPC, device discovery, Delivery Optimization, mDNS).
const COMMON_LISTEN = new Set([135, 137, 138, 139, 445, 500, 1900, 3702, 4500, 5040, 5353, 5355, 5357, 7680, 123, 68]);
const COMMON_REMOTE_PORTS = new Set([80, 443, 53, 853, 993, 995, 587, 465, 143, 110, 22, 123, 8080, 8443]);

const winPath = (p) => !!p && !!process.env.SystemRoot && String(p).toLowerCase().startsWith(String(process.env.SystemRoot).toLowerCase());
const userWritable = (p) => /\\(appdata|temp|downloads|users\\public)\\/i.test(String(p || ''));
const procOf = (snap, pid) => (snap.processes && snap.processes[String(pid)]) || { name: `pid ${pid}`, path: null, signed: null };
const isPublic = (addr) => !!addr && !isPrivateIp(addr) && !isLoopback(addr) && !isUnspecified(addr);
const risk = (r) => r;

function groupBy(items, keyFn) { const m = new Map(); for (const i of items) { const k = keyFn(i); (m.get(k) || m.set(k, []).get(k)).push(i); } return m; }

function buildNetworkFindings({ snapshot, persistentPaths = new Set(), deepEvents = [], thresholds = {}, dnsBlocked = [], now = Date.now() }) {
  const T = { ...DEFAULTS, ...thresholds };
  const out = [];
  if (!snapshot) return out;
  const conns = (snapshot.connections || []).filter((c) => /established/i.test(c.state) && isPublic(c.remoteAddress));
  const byPid = groupBy(conns, (c) => c.pid);
  const isPersistent = (p) => !!p.path && persistentPaths.has(String(p.path).toLowerCase());

  for (const [pid, list] of byPid) {
    const p = procOf(snapshot, pid);
    const dests = [...new Set(list.map((c) => c.remoteAddress))];
    const ports = [...new Set(list.map((c) => c.remotePort))];
    const evidence = [{ label: 'Process', value: `${p.name} (PID ${pid})` }, { label: 'Path', value: p.path || 'unreadable (needs elevation)' }, { label: 'Signature', value: p.signed === true ? `valid${p.publisher ? ` (${p.publisher})` : ''}` : p.signed === false ? 'not signed' : 'unknown' }, { label: 'Connections', value: `${list.length} to ${dests.length} address${dests.length === 1 ? '' : 'es'}` }, { label: 'Examples', value: list.slice(0, 4).map((c) => `${c.remoteAddress}:${c.remotePort}`).join(', ') }];
    const base = { kind: 'network', process: { pid: Number(pid), name: p.name, path: p.path || null }, evidence, confidence: 0.6 };
    if (p.signed === false && !winPath(p.path)) {
      const high = userWritable(p.path) && isPersistent(p);
      out.push({ ...base, id: `net:unsigned-outbound:${pid}`, rule: 'unsigned-outbound', title: `Unsigned program ${p.name} is making outbound connections`, what: 'A program without a valid digital signature is talking to the internet.', why: ['It has no valid signature, so its publisher cannot be verified.', ...(userWritable(p.path) ? ['It runs from a user-writable folder (AppData, Temp or Downloads), where unwanted software often lives.'] : []), ...(isPersistent(p) ? ['It starts automatically with Windows.'] : [])], risk: risk(high ? 'HIGH' : 'MEDIUM'), confidence: high ? 0.75 : 0.55 });
    }
    if (isPersistent(p) && (dests.length >= T.persistentDestinations || ports.some((x) => !COMMON_REMOTE_PORTS.has(x)))) {
      out.push({ ...base, id: `net:persistent-unusual:${pid}`, rule: 'persistent-unusual-remote', title: `Auto-start program ${p.name} contacts unusual destinations`, what: 'A program that restarts by itself is connecting to many addresses or unusual ports.', why: [dests.length >= T.persistentDestinations ? `It has connections to ${dests.length} different addresses.` : null, ports.some((x) => !COMMON_REMOTE_PORTS.has(x)) ? `It uses uncommon remote ports (${ports.filter((x) => !COMMON_REMOTE_PORTS.has(x)).slice(0, 5).join(', ')}).` : null].filter(Boolean), risk: risk('MEDIUM'), confidence: 0.55 });
    }
    if (list.length > T.burstConnections || dests.length > T.burstDestinations) {
      out.push({ ...base, id: `net:burst:${pid}`, rule: 'connection-burst', title: `${p.name} has an unusually large number of connections`, what: 'One program holds many simultaneous connections, which can be normal for a browser or torrent client and unusual otherwise.', why: [`${list.length} established connections to ${dests.length} addresses (thresholds ${T.burstConnections} / ${T.burstDestinations}).`], risk: risk('MEDIUM'), confidence: 0.5 });
    }
    const unknown = p.signed !== true && !winPath(p.path) && !(p.classification === 'known-app');
    if (unknown && dests.length >= T.unknownDestinations && !out.some((f) => f.process && f.process.pid === Number(pid) && f.rule === 'unsigned-outbound')) {
      out.push({ ...base, id: `net:unknown-many:${pid}`, rule: 'unknown-many-destinations', title: `Unrecognised program ${p.name} contacts ${dests.length} destinations`, what: 'Guardian cannot vouch for this program and it talks to many different addresses.', why: [`${dests.length} distinct remote addresses (threshold ${T.unknownDestinations}).`], risk: risk('MEDIUM'), confidence: 0.5 });
    }
  }

  // listeners reachable from other machines
  for (const c of snapshot.connections || []) {
    if (!/listen/i.test(c.state) || isLoopback(c.localAddress)) continue;
    const p = procOf(snapshot, c.pid);
    const port = c.localPort;
    const known = HIGH_RISK_PORTS.get(port);
    const winOk = winPath(p.path) && p.signed !== false;
    if (known) {
      out.push({ id: `net:listener-risk:${port}:${c.pid}`, rule: 'unexpected-listener', kind: 'network', title: `${p.name} is listening on port ${port} (${known}) for other computers`, what: `A program accepts incoming connections on a port commonly used for ${known}.`, why: [`Port ${port} is reachable from the network, not just this laptop.`], risk: risk('HIGH'), confidence: 0.7, process: { pid: c.pid, name: p.name, path: p.path || null }, listener: { port, protocol: 'TCP', address: c.localAddress }, evidence: [{ label: 'Process', value: `${p.name} (PID ${c.pid})` }, { label: 'Path', value: p.path || 'unreadable' }, { label: 'Listening on', value: `${c.localAddress}:${port}` }] });
    } else if (!COMMON_LISTEN.has(port) && port < 49152 && !winOk && p.signed !== true) {
      out.push({ id: `net:listener-unexpected:${port}:${c.pid}`, rule: 'unexpected-listener', kind: 'network', title: `Unrecognised program ${p.name} listens on port ${port}`, what: 'An unsigned or unrecognised program accepts incoming connections from the network.', why: ['It is not a normal Windows listener and has no verifiable signature.'], risk: risk('MEDIUM'), confidence: 0.5, process: { pid: c.pid, name: p.name, path: p.path || null }, listener: { port, protocol: 'TCP', address: c.localAddress }, evidence: [{ label: 'Process', value: `${p.name} (PID ${c.pid})` }, { label: 'Listening on', value: `${c.localAddress}:${port}` }] });
    }
  }

  // firewall state
  for (const pr of (snapshot.firewall && snapshot.firewall.profiles) || []) {
    if (pr.enabled === false) out.push({ id: `net:firewall-off:${pr.name}`, rule: 'firewall-off', kind: 'network', title: `Windows Firewall is off for the ${pr.name} profile`, what: 'The firewall does not filter network traffic for this profile.', why: ['Windows Firewall should stay on; Guardian can turn it back on after you confirm.'], risk: risk('HIGH'), confidence: 0.95, firewallProfile: pr.name, evidence: [{ label: 'Profile', value: pr.name }, { label: 'Default inbound', value: String(pr.defaultInboundAction || 'unknown') }] });
  }

  // rapid new connections from Deep Network Guard
  const minuteAgo = now - 60000;
  const opens = groupBy(deepEvents.filter((e) => e.type === 'open' && e.proto === 'TCP' && Date.parse(e.ts) >= minuteAgo && isPublic(e.remoteAddress)), (e) => e.pid);
  for (const [pid, evs] of opens) {
    if (evs.length >= T.newConnectionsPerMinute) {
      const p = procOf(snapshot, pid);
      out.push({ id: `net:rapid:${pid}`, rule: 'connection-burst', kind: 'network', title: `${p.name} opened ${evs.length} connections in the last minute`, what: 'A program is creating connections very quickly.', why: [`${evs.length} new outbound connections in 60 seconds (threshold ${T.newConnectionsPerMinute}).`, 'Seen by Deep Network Guard sampling.'], risk: risk('MEDIUM'), confidence: 0.55, process: { pid: Number(pid), name: p.name, path: p.path || null }, evidence: [{ label: 'Process', value: `${p.name} (PID ${pid})` }, { label: 'New connections / minute', value: String(evs.length) }] });
    }
  }

  // DNS policy conflict: a blocked name is still resolving to a real address
  const blocked = new Set((dnsBlocked || []).map((d) => d.toLowerCase()));
  for (const e of snapshot.dns || []) {
    const name = String(e.name || '').toLowerCase();
    if (blocked.has(name) && e.data && !/^0\.0\.0\.0$/.test(e.data) && !/^::$/.test(e.data)) {
      out.push({ id: `net:dns-conflict:${name}`, rule: 'dns-policy-conflict', kind: 'network', title: `${name} is blocked but still resolving`, what: 'You blocked this name with Guardian, yet Windows has a real address cached for it.', why: ['The cache entry may be older than the block (flush the DNS cache), or a program is using its own encrypted DNS (DoH) and bypassing the hosts file.'], risk: risk('LOW'), confidence: 0.6, evidence: [{ label: 'Name', value: name }, { label: 'Resolves to', value: String(e.data) }], dnsName: name });
    }
  }

  return out.map((f) => ({ source: 'network', ai: null, consequences: null, ...f }));
}

module.exports = { buildNetworkFindings, DEFAULTS, HIGH_RISK_PORTS, COMMON_LISTEN };
