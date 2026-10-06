'use strict';
/**
 * Retention and compaction for the append-only JSONL files (metrics, audit log, Deep Network Guard events), so none of them grows without
 * bound and no request ever has to read a whole file.
 *
 *  - Rows newer than `keepDays` stay in the live file, exactly as written.
 *  - Older rows are rolled into ONE summary row per day (counts and averages), appended to a small summary file.
 *  - Audit rows are never destroyed: the original rows move to a monthly archive file next to the log.
 *  - The live file is rewritten through a temp file under the same lock the agents use, and replaced atomically. A crash leaves the old file.
 *  - The file is streamed in chunks; memory use does not depend on its size.
 */
const fs = require('fs');
const path = require('path');
const U = require('./util');

const CHUNK = 1024 * 1024;
const DAY_MS = 86400000;

/** Calls fn(line) for every non-empty line of a file without loading it whole. */
function eachLine(file, fn) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK); let carry = Buffer.alloc(0); let n;
    while ((n = fs.readSync(fd, buf, 0, CHUNK, null)) > 0) {
      let data = Buffer.concat([carry, buf.subarray(0, n)]);
      let start = 0; let i;
      while ((i = data.indexOf(10, start)) >= 0) { const l = data.toString('utf8', start, i).trim(); if (l) fn(l); start = i + 1; }
      carry = data.subarray(start);
    }
    const last = carry.toString('utf8').trim(); if (last) fn(last);
  } finally { fs.closeSync(fd); }
}

const dayOf = (ts) => { const t = Date.parse(ts); return Number.isNaN(t) ? null : U.localIso(new Date(t)).slice(0, 10); };

/** Summary of numeric fields for one day of metric rows: count, then the mean of every numeric field (max for counters of problems). */
function summarizeMetrics(day, rows) {
  const sums = {}; const counts = {}; const maxes = {};
  for (const r of rows) for (const [k, v] of Object.entries(r)) { if (typeof v !== 'number' || !Number.isFinite(v)) continue; sums[k] = (sums[k] || 0) + v; counts[k] = (counts[k] || 0) + 1; maxes[k] = Math.max(maxes[k] ?? -Infinity, v); }
  const out = { ts: `${day}T12:00:00`, runType: 'summary', summaryOf: rows.length };
  for (const k of Object.keys(sums)) out[k] = Math.round((sums[k] / counts[k]) * 100) / 100;
  for (const k of ['flaggedCount', 'errorCount', 'defenderThreats', 'serviceFailures']) if (k in maxes) out[k] = maxes[k];
  return out;
}

function summarizeActions(day, rows) {
  const by = (f) => rows.reduce((m, r) => { const k = String(r[f] || 'none'); m[k] = (m[k] || 0) + 1; return m; }, {});
  return { day, total: rows.length, byCategory: by('category'), bySeverity: by('severity'), errors: rows.filter((r) => r.severity === 'error').length };
}

/**
 * Rolls rows older than keepDays out of `file`.
 * opts: { keepDays, now, summarize(day, rows) -> row, summaryFile, archiveDir (audit logs: originals are kept here, by month), archivePrefix }
 * Returns { rolled, kept, days }. Does nothing (and reports 0) when no row is old enough.
 */
function compactJsonl(file, opts) {
  const { keepDays, now = Date.now(), summarize, summaryFile, archiveDir, archivePrefix = 'archive', lockTimeoutMs = 15000 } = opts;
  if (!fs.existsSync(file)) return { rolled: 0, kept: 0, days: 0 };
  const cutoff = now - keepDays * DAY_MS;
  // Cheap pre-check on the first line: files are append-only, so if the oldest row is recent there is nothing to do.
  let first = null; try { eachLine(file, (l) => { if (!first) { first = l; throw new Error('stop'); } }); } catch (e) { if (e.message !== 'stop') throw e; }
  try { if (first && Date.parse(JSON.parse(first).ts) >= cutoff) return { rolled: 0, kept: 0, days: 0 }; } catch { /* unreadable first row: go on */ }

  return U.withFileLock(file, () => {
    const tmp = `${file}.${process.pid}.compact.tmp`;
    const out = fs.openSync(tmp, 'w');
    const byDay = new Map(); const archives = new Map(); let kept = 0; let rolled = 0;
    try {
      eachLine(file, (l) => {
        let r; try { r = JSON.parse(l); } catch { fs.writeSync(out, l + '\n'); kept++; return; }   // never drop a row we cannot read
        const t = Date.parse(r.ts);
        if (Number.isNaN(t) || t >= cutoff) { fs.writeSync(out, l + '\n'); kept++; return; }
        const d = dayOf(r.ts);
        (byDay.get(d) || byDay.set(d, []).get(d)).push(r); rolled++;
        if (archiveDir) { const m = d.slice(0, 7); (archives.get(m) || archives.set(m, []).get(m)).push(l); }
      });
    } finally { fs.closeSync(out); }
    if (!rolled) { fs.rmSync(tmp, { force: true }); return { rolled: 0, kept, days: 0 }; }
    try {
      if (archiveDir) { fs.mkdirSync(archiveDir, { recursive: true }); for (const [m, lines] of archives) fs.appendFileSync(path.join(archiveDir, `${archivePrefix}-${m}.jsonl`), lines.join('\n') + '\n'); }
      if (summaryFile) {
        const have = new Set(); if (fs.existsSync(summaryFile)) eachLine(summaryFile, (l) => { try { const s = JSON.parse(l); have.add(s.day || dayOf(s.ts)); } catch { /* skip */ } });
        const add = [...byDay.keys()].sort().filter((d) => !have.has(d)).map((d) => JSON.stringify(summarize(d, byDay.get(d))));
        if (add.length) { fs.mkdirSync(path.dirname(summaryFile), { recursive: true }); fs.appendFileSync(summaryFile, add.join('\n') + '\n'); }
      }
      fs.renameSync(tmp, file);   // atomic replace; the lock is still held, so no agent appends between the read and the swap
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e; }
    return { rolled, kept, days: byDay.size };
  }, lockTimeoutMs, { strict: true });   // compaction never runs without the lock: another writer could lose a row in the swap
}

/** The newest rows of a file that stay under a byte cap, then older summary rows to fill the front. Never reads more than maxBytes from either. */
function tailWithSummaries(file, summaryFile, { maxBytes = 8 * 1024 * 1024, summaryBytes = 2 * 1024 * 1024 } = {}) {
  const live = U.tailJsonl(file, Number.MAX_SAFE_INTEGER, maxBytes);
  const firstTs = live.length ? Date.parse(live[0].ts) : Infinity;
  const sums = summaryFile ? U.tailJsonl(summaryFile, Number.MAX_SAFE_INTEGER, summaryBytes).filter((s) => Date.parse(s.ts || s.day) < firstTs) : [];
  return [...sums, ...live];
}

module.exports = { compactJsonl, eachLine, summarizeMetrics, summarizeActions, tailWithSummaries, dayOf };
