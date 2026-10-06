'use strict';
/** Network Guard: snapshots, history, DNS log, Deep Network Guard, DNS filtering. */
const U = require('../lib/util');
const { HttpError } = require('../lib/http');
const { summarizePrograms, buildTimeline } = require('../lib/netprograms');

module.exports = function registerNetworkRoutes(ctx) {
  const { ps, config, log, need, route, state, netStore, deep, dnsBlocked, takeSnapshot, deepView, dnsView, currentView, setNetworkFlag } = ctx;
  route('GET', '/api/network/current', () => currentView());
  route('POST', '/api/network/snapshot', async () => { await takeSnapshot('manual'); return currentView(); });
  route('GET', '/api/network/history', ({ query }) => ({ items: netStore.readHistory(query.get('range') || '30') }));
  let dnsLogCache = { at: 0, value: null };
  route('GET', '/api/network/dns-log', async () => {
    if (dnsLogCache.value && Date.now() - dnsLogCache.at < 30000) return dnsLogCache.value;
    const r = await ps.run('Network/Get-DnsHistory.ps1', ['-Max', '300'], { timeoutMs: 60000 });
    if (r.missing) throw new HttpError(501, r.error);
    const value = r.ok && r.data ? r.data : { available: false, reason: r.error || 'DNS log unavailable', items: [] };
    if (r.ok) dnsLogCache = { at: Date.now(), value };
    return value;
  });
  // Allowed and blocked connections from the Windows Filtering Platform audit log (Security events 5156, 5157, 5152, 5158).
  let fwLogCache = { at: 0, value: null };
  route('GET', '/api/network/fw-events', async ({ query }) => {
    if (fwLogCache.value && Date.now() - fwLogCache.at < 20000) return fwLogCache.value;
    const hours = Math.min(Math.max(parseInt(query.get('hours') || '24', 10) || 24, 1), 168);
    const r = await ps.run('Network/Get-FirewallEvents.ps1', ['-Max', '500', '-Hours', String(hours)], { timeoutMs: 60000 });
    if (r.missing) throw new HttpError(501, r.error);
    const value = r.ok && r.data ? r.data : { available: false, reason: r.error || 'The firewall log is unavailable.', items: [] };
    if (r.ok) fwLogCache = { at: Date.now(), value };
    return value;
  });
  // CSV export of the firewall connection log: POST (it records an audit event), streamed row by row, with the same formula guard as every export.
  route('POST', '/api/network/fw-events/export', async ({ body }) => {
    const hours = Math.min(Math.max(parseInt(body.hours || '24', 10) || 24, 1), 168);
    const r = await ps.run('Network/Get-FirewallEvents.ps1', ['-Max', '2000', '-Hours', String(hours)], { timeoutMs: 60000 });
    if (r.missing) throw new HttpError(501, r.error);
    if (!r.ok || !r.data || r.data.available === false) throw new HttpError(409, (r.data && r.data.reason) || r.error || 'The firewall log is unavailable, so there is nothing to export.');
    const items = Array.isArray(r.data.items) ? r.data.items : [];
    const cols = ['ts', 'eventId', 'result', 'direction', 'protocol', 'pid', 'application', 'localAddress', 'localPort', 'remoteAddress', 'remotePort'];
    log({ category: 'network', action: 'network.fwlog.export', result: 'success', actor: 'user', reason: `exported ${items.length} firewall log row(s) as csv` });
    function* rows() { yield `${cols.join(',')}\r\n`; for (let i = 0; i < items.length; i += 200) yield `${items.slice(i, i + 200).map((e) => cols.map((c) => U.csvCell(e[c])).join(',')).join('\r\n')}\r\n`; }
    return { __stream: rows(), type: 'text/csv; charset=utf-8', filename: 'laptop-guardian-firewall-log.csv' };
  });
  // Per-program summary and activity timeline (read-only; from the latest snapshot, the stored history and Deep Network Guard events when it has run).
  route('GET', '/api/network/programs', () => {
    const snap = netStore.readLatest();
    const events = deep.readEvents({ limit: 5000, sinceMs: Date.now() - 24 * 3600000 });
    return { generatedAt: snap ? snap.generatedAt : null, programs: summarizePrograms({ snapshot: snap, events }), timeline: buildTimeline({ events, history: netStore.readHistory('1') }), bytesNote: 'Windows does not report bytes per connection without capturing traffic, which Guardian never does.' };
  });
  route('GET', '/api/network/deep', () => deepView());
  route('POST', '/api/network/deep/start', ({ body }) => {
    need(body.confirm === true && body.acknowledged === true, 'Deep Network Guard needs your explicit confirmation and acknowledgement of what it records.');
    if (!deep.active()) {
      setNetworkFlag('deep', 'enabled', true); state.deepStartedAt = U.localIso(); deep.start();
      log({ category: 'network', action: 'network.deep.start', result: 'success', actor: 'user', reason: `Deep Network Guard started (${config().network.deep.sampleSec}s sampling, ${config().network.deep.retentionDays} days, ${config().network.deep.maxMB} MB cap). Connection metadata only.` });
    }
    return deepView();
  });
  route('POST', '/api/network/deep/stop', () => {
    if (deep.active() || config().network.deep.enabled) { deep.stop(); state.deepStartedAt = null; setNetworkFlag('deep', 'enabled', false); log({ category: 'network', action: 'network.deep.stop', result: 'success', actor: 'user', reason: 'Deep Network Guard stopped. Recorded data is kept until you delete it or retention expires.' }); }
    return deepView();
  });
  route('GET', '/api/network/deep/events', ({ query }) => ({ items: deep.readEvents({ limit: Math.min(Math.max(parseInt(query.get('limit') || '300', 10) || 300, 1), 2000) }) }));
  route('POST', '/api/network/deep/export', ({ body }) => {
    const fmt = body.format || 'jsonl'; need(['jsonl', 'csv'].includes(fmt), 'format must be jsonl or csv');
    log({ category: 'network', action: 'network.deep.export', result: 'success', actor: 'user', reason: `exported as ${fmt}` });
    return { __stream: deep.exportStream(fmt), type: fmt === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8', filename: `laptop-guardian-network-events.${fmt}` };
  });
  route('POST', '/api/network/deep/delete', ({ body }) => {
    need(body.confirm === true, 'confirm:true required');
    const r = deep.deleteAll(); log({ category: 'network', action: 'network.deep.delete', result: 'success', actor: 'user', reason: `deleted ${r.deletedFiles} recorded file(s)` });
    return r;
  });
  route('POST', '/api/network/dns-filtering', ({ body }) => {
    need(body.confirm === true, 'confirm:true required');
    const enable = body.enabled === true;
    if (enable) need(body.acknowledged === true, 'Acknowledge how DNS filtering works and its limits first.');
    else need(dnsBlocked().length === 0, 'Roll back the active DNS blocks first (Network Guard, DNS), then turn filtering off.', 409);
    setNetworkFlag('dnsFiltering', 'enabled', enable);
    log({ category: 'network', action: enable ? 'network.dns.filtering.enable' : 'network.dns.filtering.disable', result: 'success', actor: 'user', reason: enable ? 'DNS filtering opted in: blocks are written only to the Laptop Guardian section of the hosts file.' : 'DNS filtering turned off' });
    return dnsView(netStore.readLatest());
  });
};
