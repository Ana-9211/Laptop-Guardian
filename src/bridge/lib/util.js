'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function readJson(file, fallback = null) {
  try {
    const t = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(t);
  } catch {
    return fallback;
  }
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  // Windows refuses a rename onto a file another process has open for a moment (an agent reading it, antivirus): retry with backoff.
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) { try { fs.unlinkSync(tmp); } catch { /* already gone */ } throw e; }
      sleepSync(15 * (attempt + 1));
    }
  }
}

// ---------- shared file locks ----------
// `<file>.lock` is created exclusively and the PowerShell agents use the same protocol (Invoke-WithFileLock), so a read-modify-write of a
// shared file is never interleaved with another writer. Rules:
//  * FAIL CLOSED: if the lock cannot be had in time the work does NOT run; the caller gets an error with code ELOCKED.
//  * A lock is taken over only when it is old (30 s) AND its owner is gone: the owner process no longer exists, or the pid now belongs to a
//    process that started after the lock was written (pid reuse). A live owner is never robbed. A lock without owner information (the agents
//    write none) is removed only if Windows lets us: a live agent holds the file open without delete sharing, so the removal fails.
//  * Waiting is a bounded retry. withFileLockAsync waits with timers, so a request handler never freezes the event loop while another process
//    holds the lock. withFileLock (sync) blocks for at most timeoutMs and is for the places that cannot await (the audit-log append and the
//    background maintenance job); lock hold times are milliseconds, so the wait is almost always zero.
const LOCK_STALE_MS = 30000;
const held = new Map();   // lock path -> depth, for nested use inside this one process (everything here is synchronous while held)

function lockError(file) { const e = new Error(`could not lock ${path.basename(file)}: another Guardian process is writing it`); e.code = 'ELOCKED'; return e; }

const probe = {
  alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } },
  /** Start time (ms) of another process, or null when it cannot be read. Only used for a lock that is already old, so the cost does not matter. */
  startTime(pid) {
    if (process.platform !== 'win32') return null;
    try {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const out = require('child_process').execFileSync(ps, ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)}).StartTime.ToUniversalTime().ToString('o')`], { timeout: 8000, windowsHide: true, encoding: 'utf8' });
      const t = Date.parse(out.trim()); return Number.isNaN(t) ? null : t;
    } catch { return null; }
  },
};
function setLockProbe(p) { Object.assign(probe, p); }

/** True when the lock file is old and nothing alive owns it. May remove it. */
function reclaimIfAbandoned(lock) {
  let st; try { st = fs.statSync(lock); } catch { return false; }
  if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return false;
  let text = ''; try { text = fs.readFileSync(lock, 'utf8'); } catch { return false; }
  let info = null; try { info = JSON.parse(text); } catch { info = null; }
  if (info && Number.isInteger(info.pid)) {
    if (probe.alive(info.pid)) {
      const started = probe.startTime(info.pid);
      const written = Date.parse(info.createdAt);
      // the pid is alive: it is the owner unless that process started after the lock was written (the pid was reused)
      if (!(started !== null && !Number.isNaN(written) && started > written + 2000)) return false;
    }
  }
  // Take the file by renaming it (atomic), then check it is the very lock we judged abandoned before deleting it.
  const mine = `${lock}.stale.${process.pid}.${crypto.randomBytes(3).toString('hex')}`;
  try { fs.renameSync(lock, mine); } catch { return false; }   // a live agent holds it open, or someone else got there first
  let moved = ''; try { moved = fs.readFileSync(mine, 'utf8'); } catch { /* unreadable: fall through */ }
  if (moved !== text) { try { fs.renameSync(mine, lock); } catch { /* the owner will notice its lock is gone */ } return false; }
  try { fs.unlinkSync(mine); } catch { /* best effort */ }
  return true;
}

/** One attempt: returns a release function, or null when someone else holds the lock. */
function tryLock(file) {
  const lock = `${file}.lock`;
  const token = crypto.randomBytes(8).toString('hex');
  for (let i = 0; i < 2; i++) {
    let fd;
    try { fd = fs.openSync(lock, 'wx'); } catch (e) {
      if (e.code === 'EEXIST' || e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') { if (i === 0 && reclaimIfAbandoned(lock)) continue; return null; }
      throw e;
    }
    try { fs.writeSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token })); } catch { /* an unreadable lock is treated like an agent's */ }
    return () => {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { if (JSON.parse(fs.readFileSync(lock, 'utf8')).token === token) fs.unlinkSync(lock); } catch { try { fs.unlinkSync(lock); } catch { /* gone */ } }
    };
  }
  return null;
}

function runHeld(file, release, fn) {
  const key = `${file}.lock`;
  held.set(key, 1);
  try { return fn(); } finally { held.delete(key); release(); }
}

/** Runs fn (synchronously) while holding the lock; throws ELOCKED without running it when the lock cannot be had within timeoutMs. */
function withFileLock(file, fn, timeoutMs = 4000) {
  if (held.has(`${file}.lock`)) return fn();   // nested use in this process
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = tryLock(file);
    if (release) return runHeld(file, release, fn);
    if (Date.now() > deadline) throw lockError(file);
    sleepSync(15 + Math.floor(Math.random() * 30));
  }
}

/** Like withFileLock but waits with timers, so the event loop keeps serving while another process holds the lock. fn must be synchronous. */
async function withFileLockAsync(file, fn, timeoutMs = 4000) {
  if (held.has(`${file}.lock`)) return fn();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const release = tryLock(file);
    if (release) return runHeld(file, release, fn);
    if (Date.now() > deadline) throw lockError(file);
    await new Promise((resolve) => setTimeout(resolve, 15 + Math.floor(Math.random() * 30)));
  }
}

/** Read the last `maxLines` parsable lines of a JSONL file, reading at most `maxBytes` from the end. */
function tailJsonl(file, maxLines = 500, maxBytes = 4 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (size > len) text = text.slice(text.indexOf('\n') + 1); // drop partial first line
    const out = [];
    for (const line of text.split('\n')) {
      const s = line.trim().replace(/^\uFEFF/, '');
      if (!s) continue;
      try { out.push(JSON.parse(s)); } catch { /* skip corrupt line */ }
    }
    return out.slice(-maxLines);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * tailJsonl, but the parsed rows are kept until the file changes (its size or modification time). The dashboard polls endpoints that look at the audit
 * log's tail on every request; with an unchanged file the second poll costs one stat instead of reading and parsing up to 4 MB again. A NEW array is
 * returned every time (callers reverse and sort their copy); the row objects are shared and must not be modified.
 */
const tailCache = new Map();
function tailJsonlCached(file, maxLines = 500, maxBytes = 4 * 1024 * 1024) {
  let st; try { st = fs.statSync(file); } catch { tailCache.delete(file); return []; }
  const key = `${st.size}:${st.mtimeMs}`; const hit = tailCache.get(file);
  if (hit && hit.key === key && hit.lines >= maxLines && hit.bytes >= maxBytes) return hit.rows.slice(-maxLines);
  const rows = tailJsonl(file, maxLines, maxBytes);
  tailCache.set(file, { key, lines: maxLines, bytes: maxBytes, rows });
  return rows.slice();
}

function readAllJsonl(file) {
  return tailJsonl(file, Number.MAX_SAFE_INTEGER, 256 * 1024 * 1024);
}

function appendJsonl(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
}

function uid(prefix = '') {
  return prefix + crypto.randomBytes(6).toString('hex');
}

/** One CSV cell. A text value that starts with = + - @ (or a tab/CR) would run as a formula in a spreadsheet, so it is prefixed with an apostrophe. */
function csvCell(v) {
  let s = String(v ?? '');
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function localIso(d = new Date()) {
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/**
 * install.json next to the program files marks an INSTALLED copy: { dataRoot, elevatedDir, ... } written by the installer.
 * Returns null for a development checkout. A damaged file throws: guessing which folders to trust would be worse than stopping.
 */
function readInstall(codeRoot = path.join(__dirname, '..', '..', '..')) {
  const f = path.join(codeRoot, 'install.json');
  if (!fs.existsSync(f)) return null;
  let j;
  try { j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { throw new Error(`install.json is damaged (${f}). Run Install-LaptopGuardian.ps1 again from an administrator PowerShell.`); }
  for (const k of ['dataRoot', 'elevatedDir']) {
    if (typeof j[k] !== 'string' || !path.win32.isAbsolute(j[k])) throw new Error(`install.json has no valid '${k}' (${f}). Run Install-LaptopGuardian.ps1 again from an administrator PowerShell.`);
  }
  return j;
}
// The installed copy and a development checkout must not fight over one port.
const DEFAULT_PORT = readInstall() ? 7878 : 7879;

const DEFAULT_CONFIG = {
  schemaVersion: 1,
  bridge: { host: '127.0.0.1', port: DEFAULT_PORT },
  schedule: {
    daily: { enabled: true, time: '19:00' },
    weekly: { enabled: true, day: 'Saturday', time: '02:00', shutdownTime: '05:00', shutdownEnabled: true },
  },
  safety: { safeMode: true, autoKillBlacklisted: true, automationPaused: false, weeklyShutdown: true },
  ai: { enabled: false, model: 'gemini-2.5-flash', maxRequestsPerRun: 15, maxProcessesPerRun: 10, dailyTokenBudget: 200000 },
  cleanup: { tempFiles: true, crashDumps: true, caches: true, recycleBin: 'never', tempMinAgeDays: 2 },
  storage: { drives: ['C:'], excludedDirs: [], protectedDirs: [], minLargeFileMB: 500, oldFileDays: 365, duplicateScan: true, duplicateMinMB: 50 },
  thresholds: { cpuPct: 50, memoryMB: 1500, diskFreeWarnPct: 15, diskFreeCritPct: 8 },
  // reportsDays 0 keeps every report. metricsRawDays and auditRawDays only decide when OLD ROWS ARE ROLLED UP: metrics become daily summaries,
  // audit rows are moved to monthly archive files. Neither setting ever deletes an audit row.
  retention: { reportsDays: 0, metricsRawDays: 180, auditRawDays: 90 },
  // Network Guard. Deep capture and DNS filtering are OFF by default and can only be switched on through their own
  // confirmed endpoints, never through the generic settings save.
  network: {
    snapshot: { auto: true, everyMinutes: 60, retentionDays: 30, maxMB: 20 },
    deep: { enabled: false, retentionDays: 7, maxMB: 100, sampleSec: 5 },
    dnsFiltering: { enabled: false },
    thresholds: { burstConnections: 100, burstDestinations: 40, unknownDestinations: 8, persistentDestinations: 5, newConnectionsPerMinute: 50 },
  },
};

const ENUMS = {
  'schedule.weekly.day': ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  'cleanup.recycleBin': ['never', 'always'],
};
const TIME_KEYS = new Set(['schedule.daily.time', 'schedule.weekly.time', 'schedule.weekly.shutdownTime']);
const RANGES = {
  'bridge.port': [1024, 65535], 'ai.maxRequestsPerRun': [0, 500], 'ai.maxProcessesPerRun': [0, 100], 'ai.dailyTokenBudget': [0, 50_000_000],
  'network.snapshot.everyMinutes': [5, 1440], 'network.snapshot.retentionDays': [1, 365], 'network.snapshot.maxMB': [1, 500],
  'network.deep.retentionDays': [1, 90], 'network.deep.maxMB': [5, 500], 'network.deep.sampleSec': [2, 60],
  'network.thresholds.burstConnections': [5, 100000], 'network.thresholds.burstDestinations': [5, 100000], 'network.thresholds.unknownDestinations': [2, 1000],
  'network.thresholds.persistentDestinations': [2, 1000], 'network.thresholds.newConnectionsPerMinute': [5, 100000],
};
Object.assign(RANGES, {
  'cleanup.tempMinAgeDays': [1, 365], 'storage.minLargeFileMB': [1, 1_000_000], 'storage.oldFileDays': [1, 3650], 'storage.duplicateMinMB': [1, 100_000],
  'thresholds.cpuPct': [1, 100], 'thresholds.memoryMB': [50, 1_000_000], 'thresholds.diskFreeWarnPct': [1, 90], 'thresholds.diskFreeCritPct': [1, 89],
  'retention.reportsDays': [0, 3650], 'retention.metricsRawDays': [30, 730], 'retention.auditRawDays': [30, 730],
});
const READONLY = new Set(['schemaVersion', 'bridge.host']);

/** Merge `patch` into a copy of `base`, accepting only keys that exist in DEFAULT_CONFIG with matching types. */
function mergeConfig(base, patch, defaults = DEFAULT_CONFIG, prefix = '') {
  const out = { ...base };
  const errors = [];
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { value: out, errors: ['body must be an object'] };
  for (const [k, v] of Object.entries(patch)) {
    const key = prefix + k;
    if (!(k in defaults)) { errors.push(`unknown key ${key}`); continue; }
    if (READONLY.has(key)) { errors.push(`${key} is read-only`); continue; }
    const d = defaults[k];
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      const sub = mergeConfig(base[k] || d, v, d, key + '.');
      out[k] = sub.value; errors.push(...sub.errors);
    } else if (Array.isArray(d)) {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length > 500 || x.includes('\0'))) errors.push(`${key} must be an array of strings`);
      else out[k] = v;
    } else if (typeof v !== typeof d) errors.push(`${key} must be ${typeof d}`);
    else if (ENUMS[key] && !ENUMS[key].includes(v)) errors.push(`${key} must be one of ${ENUMS[key].join(', ')}`);
    else if (TIME_KEYS.has(key) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) errors.push(`${key} must be HH:MM`);
    else if (typeof v === 'string' && (v.length > 200 || v.includes('\0'))) errors.push(`${key} too long`);
    else if (typeof v === 'number' && (!Number.isFinite(v) || v < (RANGES[key]?.[0] ?? 0) || v > (RANGES[key]?.[1] ?? 1e9))) errors.push(`${key} out of range`);
    else out[k] = v;
  }
  if (prefix === '' && !errors.length && out.thresholds && out.thresholds.diskFreeCritPct >= out.thresholds.diskFreeWarnPct) errors.push('thresholds.diskFreeCritPct must be lower than diskFreeWarnPct');
  return { value: out, errors };
}

/** Settings changes that lower a safety margin. They are applied only after an explicit confirmation (see PUT /api/config). */
function riskyChanges(before, after) {
  const out = [];
  const b = before || {}; const a = after || {};
  if (b.safety && a.safety) {
    if (b.safety.safeMode !== false && a.safety.safeMode === false) out.push('Turn Safe Mode off: agents may then clean files and end blacklisted processes on their own.');
    if (!b.safety.autoKillBlacklisted && a.safety.autoKillBlacklisted) out.push('Automatically terminate blacklisted processes (effective when Safe Mode is off).');
  }
  if (b.storage && a.storage) {
    const gone = (b.storage.protectedDirs || []).filter((d) => !(a.storage.protectedDirs || []).includes(d));
    if (gone.length) out.push(`Stop protecting ${gone.length} folder(s): ${gone.slice(0, 3).join(', ')}${gone.length > 3 ? ', ...' : ''}.`);
  }
  if (b.cleanup && a.cleanup && b.cleanup.recycleBin !== 'always' && a.cleanup.recycleBin === 'always') out.push('Empty the Recycle Bin permanently on every run. Items moved there by Guardian could then no longer be restored.');
  return out;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function nextRun(time, day, from = new Date()) {
  const [h, m] = time.split(':').map(Number);
  const d = new Date(from);
  d.setHours(h, m, 0, 0);
  if (day) {
    const target = DAYS.indexOf(day);
    d.setDate(d.getDate() + ((target - d.getDay() + 7) % 7));
  }
  if (d <= from) d.setDate(d.getDate() + (day ? 7 : 1));
  return localIso(d);
}

module.exports = {
  readInstall, DEFAULT_PORT, withFileLock, withFileLockAsync, setLockProbe, csvCell, riskyChanges, readJson, RANGES, writeJsonAtomic, tailJsonl, tailJsonlCached, readAllJsonl, appendJsonl, uid, localIso, DEFAULT_CONFIG, mergeConfig, nextRun };
