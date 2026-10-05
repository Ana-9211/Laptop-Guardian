'use strict';
/**
 * Deep Network Guard: an explicit opt-in mode that samples the Windows connection table every few seconds and records when
 * each connection opens and closes (so you get connection age, history and burst detection).
 *
 * What it records: protocol, local and remote address and port, state, owning process id and image name, timestamps.
 * What it NEVER records: packet contents, payloads, URLs, headers, passwords or file data. It does not capture packets at all.
 * Data stays in data/network/deep on this laptop, is never sent to Gemini or anywhere else, is bounded by a retention age and
 * a size cap, and can be exported or deleted at any time. It is off by default and a banner shows whenever it is running.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const MB = 1024 * 1024;
const DAY_MS = 86400000;
const MAX_EVENTS_PER_TICK = 500;
const MAX_OPEN_TRACKED = 5000;
const NAME_REFRESH_MS = 60000;
const IGNORED_STATES = new Set(['TIME_WAIT', 'CLOSE_WAIT', 'FIN_WAIT_2', 'LAST_ACK', 'CLOSING']);

/** Parses `netstat -ano` output into rows. Pure, so it is tested with captured text. */
function parseNetstat(text) {
  const rows = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim().split(/\s+/);
    if (line[0] === 'TCP' && line.length >= 5) {
      const l = splitAddr(line[1]); const r = splitAddr(line[2]);
      if (l && r) rows.push({ proto: 'TCP', localAddress: l.addr, localPort: l.port, remoteAddress: r.addr, remotePort: r.port, state: titleState(line[3]), pid: Number(line[4]) });
    } else if (line[0] === 'UDP' && line.length >= 4) {
      const l = splitAddr(line[1]);
      if (l) rows.push({ proto: 'UDP', localAddress: l.addr, localPort: l.port, remoteAddress: '', remotePort: 0, state: 'Endpoint', pid: Number(line[line.length - 1]) });
    }
  }
  return rows;
}
function splitAddr(s) {
  const m = /^\[?(.*?)\]?:(\d+|\*)$/.exec(s || '');
  return m ? { addr: m[1] === '*' ? '' : m[1], port: m[2] === '*' ? 0 : Number(m[2]) } : null;
}
const titleState = (s) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/(^|\s)\S/g, (c) => c.toUpperCase());
const key = (r) => `${r.proto}|${r.localAddress}:${r.localPort}|${r.remoteAddress}:${r.remotePort}|${r.pid}`;

function parseTasklist(text) {
  const map = new Map();
  for (const raw of String(text || '').split(/\r?\n/)) { const m = /^"([^"]+)","(\d+)"/.exec(raw); if (m) map.set(Number(m[2]), m[1]); }
  return map;
}

const realNetstat = () => new Promise((resolve, reject) => execFile('netstat.exe', ['-ano'], { timeout: 10000, windowsHide: true, maxBuffer: 8 * MB }, (e, out) => (e ? reject(e) : resolve(out))));
const realTasklist = () => new Promise((resolve, reject) => execFile('tasklist.exe', ['/FO', 'CSV', '/NH'], { timeout: 10000, windowsHide: true, maxBuffer: 8 * MB }, (e, out) => (e ? reject(e) : resolve(out))));

function createDeep({ root, getConfig, setDeepState, log, runNetstat = realNetstat, runTasklist = realTasklist, now = Date.now, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  const dir = path.join(root, 'data', 'network', 'deep');
  const open = new Map(); let names = new Map(); let namesAt = 0;
  let timer = null; let ticking = false; let lastTick = null; let eventCount = 0;
  const cfg = () => { const d = ((getConfig() || {}).network || {}).deep || {}; return { retentionDays: d.retentionDays || 7, maxBytes: (d.maxMB || 100) * MB, sampleSec: d.sampleSec || 5 }; };
  const dayFile = (t) => path.join(dir, `events-${new Date(t).toISOString().slice(0, 10)}.jsonl`);
  const files = () => { try { return fs.readdirSync(dir).filter((f) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().map((f) => path.join(dir, f)); } catch { return []; } };
  const storageBytes = () => files().reduce((a, f) => { try { return a + fs.statSync(f).size; } catch { return a; } }, 0);

  /** Retention by age, then the size cap by deleting the oldest day files and finally the oldest lines of the newest. */
  function prune() {
    const c = cfg(); const cutoff = now() - c.retentionDays * DAY_MS;
    for (const f of files()) { const d = Date.parse(/events-(\d{4}-\d{2}-\d{2})/.exec(f)[1]); if (d + DAY_MS < cutoff) fs.rmSync(f, { force: true }); }
    let list = files(); let total = storageBytes();
    while (total > c.maxBytes && list.length > 1) { total -= fs.statSync(list[0]).size; fs.rmSync(list[0], { force: true }); list = list.slice(1); }
    if (total > c.maxBytes && list.length === 1) {
      const lines = fs.readFileSync(list[0], 'utf8').split('\n').filter(Boolean);
      let size = lines.reduce((a, l) => a + Buffer.byteLength(l) + 1, 0);
      while (lines.length && size > c.maxBytes) { size -= Buffer.byteLength(lines.shift()) + 1; }
      fs.writeFileSync(list[0], lines.length ? `${lines.join('\n')}\n` : '');
    }
  }

  async function tick() {
    if (ticking) return { skipped: true };
    ticking = true;
    try {
      const t = now(); const ts = new Date(t).toISOString();
      if (t - namesAt > NAME_REFRESH_MS) { try { names = parseTasklist(await runTasklist()); namesAt = t; } catch { /* names are optional */ } }
      const rows = parseNetstat(await runNetstat()).filter((r) => !IGNORED_STATES.has(String(r.state).toUpperCase().replace(/ /g, '_')));
      const seen = new Set(); const events = [];
      for (const r of rows) {
        const k = key(r); seen.add(k);
        if (!open.has(k) && open.size < MAX_OPEN_TRACKED) { open.set(k, { firstSeen: t, row: r }); events.push({ ts, type: 'open', ...r, process: names.get(r.pid) || null }); }
      }
      for (const [k, v] of open) {
        if (!seen.has(k)) { open.delete(k); events.push({ ts, type: 'close', ...v.row, process: names.get(v.row.pid) || null, durationSec: Math.round((t - v.firstSeen) / 1000) }); }
      }
      const batch = events.slice(0, MAX_EVENTS_PER_TICK);
      if (batch.length) { fs.mkdirSync(dir, { recursive: true }); fs.appendFileSync(dayFile(t), `${batch.map((e) => JSON.stringify(e)).join('\n')}\n`); eventCount += batch.length; prune(); }
      lastTick = ts;
      return { events: batch.length, tracking: open.size };
    } finally { ticking = false; }
  }

  function start() {
    if (timer) return status();
    timer = setIntervalFn(() => { tick().catch((e) => log({ category: 'network', action: 'network.deep.error', result: 'failure', severity: 'warning', error: String(e.message || e).slice(0, 200) })); }, cfg().sampleSec * 1000);
    if (timer && timer.unref) timer.unref();
    return status();
  }
  function stop() { if (timer) { clearIntervalFn(timer); timer = null; } open.clear(); return status(); }
  const active = () => !!timer;
  function status() {
    const c = cfg();
    return { active: active(), lastSampleAt: lastTick, eventsThisSession: eventCount, tracking: open.size, storageBytes: storageBytes(), storageMB: Math.round((storageBytes() / MB) * 10) / 10, files: files().length, retentionDays: c.retentionDays, maxMB: c.maxBytes / MB, sampleSec: c.sampleSec };
  }

  function readEvents({ limit = 500, sinceMs } = {}) {
    const out = [];
    for (const f of files().reverse()) {
      const lines = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) { try { const e = JSON.parse(lines[i]); if (!sinceMs || Date.parse(e.ts) >= sinceMs) out.push(e); } catch { /* skip */ } }
      if (out.length >= limit) break;
    }
    return out;
  }
  function exportData(format = 'jsonl') {
    const rows = []; for (const f of files()) for (const l of fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)) { try { rows.push(JSON.parse(l)); } catch { /* skip */ } }
    if (format === 'csv') {
      const cols = ['ts', 'type', 'proto', 'localAddress', 'localPort', 'remoteAddress', 'remotePort', 'state', 'pid', 'process', 'durationSec'];
      return `${cols.join(',')}\n${rows.map((r) => cols.map((c) => { const s = String(r[c] ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }).join(',')).join('\n')}`;
    }
    return rows.map((r) => JSON.stringify(r)).join('\n');
  }
  function deleteAll() { const n = files().length; for (const f of files()) fs.rmSync(f, { force: true }); eventCount = 0; return { deletedFiles: n }; }

  return { tick, start, stop, status, active, readEvents, exportData, deleteAll, prune, _open: open, setDeepState };
}

module.exports = { createDeep, parseNetstat, parseTasklist };
