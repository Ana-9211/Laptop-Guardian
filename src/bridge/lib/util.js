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

/**
 * Runs fn while holding `<file>.lock` (created exclusively; the PowerShell agents use the same protocol), so a read-modify-write of a shared
 * JSON file is not interleaved with another writer. A lock older than 30 s is treated as left behind by a crash. If the lock cannot be
 * obtained within `timeoutMs` the work still runs: a stuck lock must never freeze the dashboard.
 */
function withFileLock(file, fn, timeoutMs = 4000) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs; let fd = null;
  while (fd === null) {
    try { fd = fs.openSync(lock, 'wx'); } catch (e) {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 30000) fs.unlinkSync(lock); } catch { /* raced with the holder */ }
      if (Date.now() > deadline) break;
      sleepSync(15 + Math.floor(Math.random() * 30));
    }
  }
  try { return fn(); } finally { if (fd !== null) { try { fs.closeSync(fd); fs.unlinkSync(lock); } catch { /* best effort */ } } }
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
  retention: { reportsDays: 0 },
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
  'cleanup.tempMinAgeDays': [0, 365], 'storage.minLargeFileMB': [1, 1_000_000], 'storage.oldFileDays': [1, 3650], 'storage.duplicateMinMB': [1, 100_000],
  'thresholds.cpuPct': [1, 100], 'thresholds.memoryMB': [50, 1_000_000], 'thresholds.diskFreeWarnPct': [1, 90], 'thresholds.diskFreeCritPct': [1, 89],
  'retention.reportsDays': [0, 3650],
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
  readInstall, DEFAULT_PORT, withFileLock, csvCell, riskyChanges, readJson, writeJsonAtomic, tailJsonl, readAllJsonl, appendJsonl, uid, localIso, DEFAULT_CONFIG, mergeConfig, nextRun };
