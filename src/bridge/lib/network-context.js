'use strict';
/** Network Guard's shared pieces: the snapshot store, Deep Network Guard, snapshots, findings and the views the routes return. */
const U = require('./util');
const NS = require('./netstore');
const NF = require('./netfindings');
const NO = require('./netoffers');
const ND = require('./netdeep');
const NG = require('./netguard');
const NP = require('./netposture');
const NSM = require('./netsampler');
const { HttpError } = require('./http');

function createNetworkContext(ctx) {
  const { root, guardianRoots, opts, P, ps, config, log, state } = ctx;
  const netStore = NS.createNetStore(root, config);
  const hostsPath = opts.hostsPath || NG.defaultHostsPath();
  // The Get-NetTCPConnection sampler is used when the runner can stream (the real one); tests that inject netstat output keep the fallback.
  const sampler = ps.stream && !opts.runNetstat ? NSM.createSampler({ ps, intervalSec: Math.max(2, ((config().network.deep || {}).sampleSec) || 5), log }) : null;
  const deep = ND.createDeep({ root, getConfig: config, log, sampler, runNetstat: opts.runNetstat, runTasklist: opts.runTasklist });
  let snapInFlight = null;
  const netTimers = [];
  const persistentPaths = () => {
    const procs = (U.readJson(P.latest('processes.json'), { processes: [] }) || {}).processes || [];
    return new Set(procs.filter((p) => p.persistent && p.path).map((p) => String(p.path).toLowerCase()));
  };
  const netCtx = () => {
    const s = netStore.readLatest(); const id = s && s.identity ? [...(s.identity.gateway || []), ...(s.identity.dns || []), ...(s.identity.dhcp || [])] : [];
    return { identity: id, bridgePort: state.boundPort, dnsFilteringEnabled: !!config().network.dnsFiltering.enabled };
  };
  const dnsBlocked = () => NG.readHostsBlock(hostsPath).domains;
  let prevSnapshot = null;   // the snapshot before the latest one (memory only): lets Guardian say what changed
  function computeNetFindings(snapshot) {
    const deepEv = deep.active() ? deep.readEvents({ limit: 2000, sinceMs: Date.now() - 120000 }) : [];
    const extra = [...NP.postureFindings(snapshot), ...NP.dnsFindings(snapshot), ...NP.changeFindings(snapshot, prevSnapshot), ...NP.beaconFindings(deep.active() ? deep.readEvents({ limit: 5000, sinceMs: Date.now() - 3600000 }) : [])];
    const raw0 = NF.buildNetworkFindings({
      snapshot, persistentPaths: persistentPaths(), thresholds: config().network.thresholds, dnsBlocked: dnsBlocked(),
      deepEvents: deepEv,
    });
    const raw = [...raw0, ...extra];
    return NO.toActionFindings(raw, { ...netCtx(), guardianRoot: guardianRoots }, ctx.remediation.history(300));
  }
  async function takeSnapshot(reason = 'manual') {
    if (snapInFlight) return snapInFlight;
    snapInFlight = (async () => {
      const r = await ps.run('Network/Get-NetworkSnapshot.ps1', [], { timeoutMs: 90000 });
      if (r.missing) throw new HttpError(501, r.error);
      if (!r.ok || !r.data || !Array.isArray(r.data.connections)) throw new HttpError(502, r.error || 'the network snapshot failed');
      const snap = r.data; snap.generatedAt = snap.generatedAt || U.localIso();
      const count = computeNetFindings(snap).length;
      prevSnapshot = netStore.readLatest() || prevSnapshot;
      netStore.saveSnapshot(snap, count);
      log({ category: 'network', action: 'network.snapshot', result: 'success', actor: reason === 'manual' ? 'user' : 'agent', reason: `${reason}: ${snap.connections.length} connections, ${count} findings` });
      return snap;
    })().finally(() => { snapInFlight = null; });
    return snapInFlight;
  }
  function enrich(snap) {
    const persistent = persistentPaths();
    const procs = snap.processes || {};
    return { ...snap, connections: (snap.connections || []).map((c) => { const p = procs[String(c.pid)] || {}; return { ...c, process: { name: p.name || `pid ${c.pid}`, path: p.path || null, signed: p.signed ?? null, publisher: p.publisher || null, owner: p.owner || null, startTime: p.startTime || null, persistent: !!(p.path && persistent.has(String(p.path).toLowerCase())) } }; }) };
  }
  function rulesView(snap) {
    const reg = new Map(netStore.readRuleRegistry().map((r) => [r.name, r]));
    return ((snap.firewall && snap.firewall.rules) || []).map((r) => {
      const meta = reg.get(r.name) || {};
      const expiresAt = meta.expiresAt || ((/after (\d{4}-\d{2}-\d{2}T[\d:+-]+)/.exec(r.description || '') || [])[1] || null);
      return { ...r, createdAt: meta.createdAt || null, expiresAt, expired: !!(expiresAt && Date.parse(expiresAt) < Date.now()) };
    });
  }
  const deepView = () => ({ ...deep.status(), enabled: !!config().network.deep.enabled, startedAt: state.deepStartedAt });
  const dnsView = (snap) => ({ filtering: { enabled: !!config().network.dnsFiltering.enabled, blocked: dnsBlocked() }, cache: (snap && snap.dns) || [], history: netStore.readDnsHistory(200) });
  function currentView() {
    const s = netStore.readLatest();
    const c = config();
    const findings = s ? computeNetFindings(s) : [];
    return {
      snapshot: s ? enrich(s) : null, ageSec: s ? Math.round((Date.now() - Date.parse(s.generatedAt)) / 1000) : null,
      findings: s ? findings : [], posture: s ? NP.postureScore(s, findings) : null, rules: s ? rulesView(s) : [], deep: deepView(), dns: dnsView(s), settings: c.network, privacy: NET_PRIVACY,
    };
  }
  const NET_PRIVACY = 'Network data stays on this laptop in data/network. It is never sent to Gemini or anywhere else, and Guardian never records packet contents.';
  function setNetworkFlag(path1, path2, value) {
    const c = config(); c.network[path1][path2] = value;
    U.writeJsonAtomic(P.config, c);
  }
  return { netStore, hostsPath, deep, netTimers, persistentPaths, netCtx, dnsBlocked, computeNetFindings, takeSnapshot, enrich, rulesView, deepView, dnsView, currentView, NET_PRIVACY, setNetworkFlag };
}

module.exports = { createNetworkContext };
