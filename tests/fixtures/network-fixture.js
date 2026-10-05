'use strict';
/** A synthetic network snapshot (documentation-range addresses, invented programs). Never read from the real system. */
function makeNetworkSnapshot(over = {}) {
  const now = over.now || new Date().toISOString();
  const conn = (state, la, lp, ra, rp, pid) => ({ proto: 'TCP', state, localAddress: la, localPort: lp, remoteAddress: ra, remotePort: rp, pid, created: null });
  const many = (pid, n, port = 443) => Array.from({ length: n }, (_, i) => conn('Established', '192.168.1.20', 50000 + i, `203.0.113.${(i % 200) + 1}`, port, pid));
  return {
    generatedAt: now, durationMs: 1200, elevated: false, mode: 'standard',
    connections: [
      ...many(100, 3), // chrome: signed
      ...many(200, 3, 9001), // helper: unsigned, user-writable, auto-start
      conn('Listen', '0.0.0.0', 3389, '', 0, 300), // unsigned service listening on RDP
      conn('Listen', '0.0.0.0', 445, '', 0, 4), // normal Windows listener
      conn('Listen', '127.0.0.1', 5173, '', 0, 400), // dev server on loopback: ignored
      ...many(500, 12), // unknown program with many destinations
    ],
    udp: [{ proto: 'UDP', localAddress: '0.0.0.0', localPort: 5353, pid: 100 }],
    processes: {
      100: { name: 'chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', signed: true, signature: 'Valid', publisher: 'Google LLC' },
      200: { name: 'helper', path: 'C:\\Users\\TestUser\\AppData\\Roaming\\Helper\\helper.exe', signed: false, signature: 'NotSigned', publisher: null },
      300: { name: 'remsvc', path: 'C:\\Tools\\remsvc.exe', signed: false, signature: 'NotSigned', publisher: null },
      4: { name: 'System', path: null, signed: null },
      400: { name: 'node', path: 'C:\\Program Files\\nodejs\\node.exe', signed: true, signature: 'Valid', publisher: 'OpenJS Foundation' },
      500: { name: 'mystery', path: 'C:\\Tools\\mystery.exe', signed: null, signature: 'Unknown', publisher: null },
    },
    dns: [{ name: 'example.org', type: 'A', data: '203.0.113.5', ttl: 60 }, { name: 'tracker.adnetwork.net', type: 'A', data: '203.0.113.77', ttl: 120 }],
    firewall: {
      profiles: [{ name: 'Public', enabled: false, defaultInboundAction: 'Block', defaultOutboundAction: 'Allow' }, { name: 'Private', enabled: true, defaultInboundAction: 'Block', defaultOutboundAction: 'Allow' }],
      rules: [
        { name: 'LG-1759000000-aaaaaa', displayName: 'Laptop Guardian: block helper.exe (Outbound)', enabled: true, direction: 'Outbound', action: 'Block', program: 'C:\\Users\\TestUser\\AppData\\Roaming\\Helper\\helper.exe', protocol: 'Any', localPort: 'Any', remoteAddress: 'Any', description: 'Created by Laptop Guardian 2026-10-01T10:00:00+05:30. Review or remove after 2026-10-02T10:00:00+05:30.' },
        { name: 'LG-1759100000-bbbbbb', displayName: 'Laptop Guardian: block inbound TCP port 4444', enabled: false, direction: 'Inbound', action: 'Block', program: '', protocol: 'TCP', localPort: '4444', remoteAddress: 'Any', description: 'Created by Laptop Guardian 2026-10-03T10:00:00+05:30. No expiry.' },
      ],
    },
    identity: { gateway: ['192.168.1.1'], dns: ['1.1.1.1'], dhcp: ['192.168.1.1'] },
    errors: [],
    ...over,
  };
}
module.exports = { makeNetworkSnapshot };
