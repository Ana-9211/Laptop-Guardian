'use strict';
/**
 * Local, bounded storage for network data under data/network (never leaves this laptop, never sent to Gemini).
 *   data/latest/network.json          the most recent snapshot
 *   data/network/history.jsonl        one small summary row per snapshot (for trends)
 *   data/network/dns-history.jsonl    DNS names seen in the Windows DNS cache over time
 *   data/network/deep/events-*.jsonl  Deep Network Guard connection events (opt-in)
 * Every file has a retention age and a size cap; pruning drops the oldest lines first.
 */
const fs = require('fs');
const path = require('path');
const U = require('./util');

const MB = 1024 * 1024;
const DAY_MS = 86400000;
const DNS_HISTORY_MAX_LINES = 20000;

function dirs(root) {
  const base = path.join(root, 'data', 'network');
  return { base, latest: path.join(root, 'data', 'latest', 'network.json'), history: path.join(base, 'history.jsonl'), dns: path.join(base, 'dns-history.jsonl'), deep: path.join(base, 'deep'), rules: path.join(base, 'rules.json') };
}

/** Drop lines older than `days`, then the oldest lines until the file is under `maxBytes`. Returns lines kept. */
function pruneJsonl(file, { days, maxBytes, tsKey = 'ts', now = Date.now() }) {
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return 0; }
  let lines = text.split('\n').filter(Boolean);
  const cutoff = now - days * DAY_MS;
  lines = lines.filter((l) => { try { const t = Date.parse(JSON.parse(l)[tsKey]); return Number.isNaN(t) || t >= cutoff; } catch { return false; } });
  let size = lines.reduce((a, l) => a + Buffer.byteLength(l) + 1, 0);
  while (lines.length && size > maxBytes) { size -= Buffer.byteLength(lines[0]) + 1; lines.shift(); }
  fs.writeFileSync(file, lines.length ? `${lines.join('\n')}\n` : '');
  return lines.length;
}

function summarize(snapshot, findingsCount) {
  const conns = snapshot.connections || [];
  const est = conns.filter((c) => /established/i.test(c.state));
  const remotes = new Set(est.map((c) => c.remoteAddress));
  const unsignedOutbound = new Set(est.filter((c) => { const p = (snapshot.processes || {})[String(c.pid)]; return p && p.signed === false; }).map((c) => c.pid));
  return { ts: snapshot.generatedAt, established: est.length, listening: conns.filter((c) => /listen/i.test(c.state)).length + (snapshot.udp || []).length, remoteAddresses: remotes.size, unsignedProcesses: unsignedOutbound.size, dnsEntries: (snapshot.dns || []).length, findings: findingsCount, firewallOff: ((snapshot.firewall && snapshot.firewall.profiles) || []).filter((p) => p.enabled === false).length, guardianRules: ((snapshot.firewall && snapshot.firewall.rules) || []).length };
}

function createNetStore(root, getConfig) {
  const D = dirs(root);
  const cfg = () => { const n = (getConfig() || {}).network || {}; return { days: (n.snapshot && n.snapshot.retentionDays) || 30, maxBytes: ((n.snapshot && n.snapshot.maxMB) || 20) * MB }; };

  function saveSnapshot(snapshot, findingsCount) {
    U.writeJsonAtomic(D.latest, snapshot);
    U.appendJsonl(D.history, summarize(snapshot, findingsCount));
    // DNS history: remember each (name, data) the first time it is seen so the history grows without storing duplicates
    const seen = new Set(U.readAllJsonl(D.dns).map((r) => `${r.name}|${r.data}`));
    for (const e of snapshot.dns || []) { const k = `${e.name}|${e.data}`; if (!seen.has(k)) { seen.add(k); U.appendJsonl(D.dns, { ts: snapshot.generatedAt, name: e.name, type: e.type, data: e.data }); } }
    prune();
  }
  function prune(now = Date.now()) {
    const c = cfg();
    pruneJsonl(D.history, { days: c.days, maxBytes: c.maxBytes, now });
    pruneJsonl(D.dns, { days: c.days, maxBytes: Math.min(c.maxBytes, DNS_HISTORY_MAX_LINES * 200), now });
  }
  const readLatest = () => U.readJson(D.latest, null);
  const readHistory = (range) => { const all = U.readAllJsonl(D.history); const days = Number(range); return Number.isFinite(days) && days > 0 ? all.filter((r) => Date.parse(r.ts) >= Date.now() - days * DAY_MS) : all; };
  const readDnsHistory = (limit = 500) => U.readAllJsonl(D.dns).slice(-limit).reverse();
  const readRuleRegistry = () => { const r = U.readJson(D.rules, null); return r && Array.isArray(r.rules) ? r.rules : []; };
  return { dirs: D, saveSnapshot, prune, readLatest, readHistory, readDnsHistory, readRuleRegistry, summarize };
}

module.exports = { createNetStore, pruneJsonl, summarize, dirs, MB };
