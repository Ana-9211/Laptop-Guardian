'use strict';
/**
 * Per-program view of Network Guard: one row per program from the latest snapshot (connections, distinct remote hosts, first seen) and a simple
 * activity timeline. Pure functions. Byte counts are null on purpose: Windows does not report bytes per connection without capturing traffic,
 * which Guardian never does.
 */
const HOUR_MS = 3600000;

function summarizePrograms({ snapshot, events = [] }) {
  if (!snapshot) return [];
  const procs = snapshot.processes || {};
  const by = new Map();
  const keyOf = (p, pid) => String((p && p.path) || (p && p.name) || `pid ${pid}`).toLowerCase();
  const rowFor = (pid) => {
    const p = procs[String(pid)] || {};
    const k = keyOf(p, pid);
    if (!by.has(k)) by.set(k, { name: p.name || `pid ${pid}`, path: p.path || null, signed: p.signed ?? null, publisher: p.publisher || null, pid: Number(pid), startTime: p.startTime || null, connections: 0, established: 0, listening: 0, remotes: new Set(), firstSeen: null, lastSeen: null, bytes: null });
    return by.get(k);
  };
  for (const c of snapshot.connections || []) {
    const r = rowFor(c.pid);
    if (/listen/i.test(c.state)) r.listening++;
    else { r.connections++; if (/established/i.test(c.state)) r.established++; if (c.remoteAddress) r.remotes.add(c.remoteAddress); }
  }
  for (const u of snapshot.udp || []) rowFor(u.pid).listening++;
  // first and last seen come from Deep Network Guard events when it has been on; otherwise they stay null (never guessed)
  const idx = new Map([...by.values()].map((r) => [String(r.name).toLowerCase(), r]));
  for (const e of events) {
    const r = idx.get(String(e.process || '').toLowerCase().replace(/\.exe$/, '')) || idx.get(String(e.process || '').toLowerCase());
    if (!r || !e.ts) continue;
    if (!r.firstSeen || e.ts < r.firstSeen) r.firstSeen = e.ts;
    if (!r.lastSeen || e.ts > r.lastSeen) r.lastSeen = e.ts;
  }
  return [...by.values()].map((r) => { const { remotes, ...rest } = r; return { ...rest, remoteHosts: remotes.size }; }).sort((a, b) => b.connections - a.connections || a.name.localeCompare(b.name));
}

/** Connection opens per hour from Deep Network Guard events, or per snapshot from the stored history when it has not been on. */
function buildTimeline({ events = [], history = [], now = Date.now(), hours = 24 }) {
  if (events.length) {
    // buckets are whole LOCAL hours (the laptop's clock), so a half-hour time zone still lines up with what the user sees
    const floor = (ms) => { const d = new Date(ms); d.setMinutes(0, 0, 0); return d.getTime(); };
    const start = floor(now - hours * HOUR_MS);
    const buckets = new Map();
    for (let t = start; t <= now; t += HOUR_MS) buckets.set(floor(t), { ts: new Date(floor(t)).toISOString(), opens: 0, closes: 0 });
    for (const e of events) { const b = buckets.get(floor(Date.parse(e.ts))); if (!b) continue; if (e.type === 'open') b.opens++; else if (e.type === 'close') b.closes++; }
    return { source: 'deep', unit: 'hour', buckets: [...buckets.values()] };
  }
  const rows = history.filter((h) => Date.parse(h.ts) >= now - hours * HOUR_MS).map((h) => ({ ts: h.ts, opens: h.established || 0, closes: 0 }));
  return { source: 'snapshots', unit: 'snapshot', buckets: rows };
}

module.exports = { summarizePrograms, buildTimeline };
