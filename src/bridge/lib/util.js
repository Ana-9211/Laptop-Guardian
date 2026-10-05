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

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
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

function localIso(d = new Date()) {
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

const DEFAULT_CONFIG = {
  schemaVersion: 1,
  bridge: { host: '127.0.0.1', port: 7878 },
  schedule: {
    daily: { enabled: true, time: '19:00' },
    weekly: { enabled: true, day: 'Saturday', time: '02:00', shutdownTime: '05:00', shutdownEnabled: true },
  },
  safety: { safeMode: true, requireConfirmation: true, autoKillBlacklisted: true, automationPaused: false, weeklyShutdown: true },
  ai: { enabled: false, model: 'gemini-2.5-flash', maxRequestsPerRun: 15, maxProcessesPerRun: 10, scope: 'metadata', dailyTokenBudget: 200000 },
  cleanup: { tempFiles: true, crashDumps: true, caches: true, recycleBin: 'never', tempMinAgeDays: 2 },
  storage: { drives: ['C:'], excludedDirs: [], protectedDirs: [], minLargeFileMB: 500, oldFileDays: 365, duplicateScan: true, duplicateMinMB: 50 },
  thresholds: { cpuPct: 50, memoryMB: 1500, diskFreeWarnPct: 15, diskFreeCritPct: 8 },
  retention: { reportsDays: 0, metricsDays: 0, actionsDays: 0 },
  dashboard: { theme: 'system' },
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
  'ai.scope': ['metadata', 'metadata+paths'],
  'cleanup.recycleBin': ['never', 'older-than-30-days', 'always'],
  'dashboard.theme': ['system', 'light', 'dark'],
};
const TIME_KEYS = new Set(['schedule.daily.time', 'schedule.weekly.time', 'schedule.weekly.shutdownTime']);
const RANGES = {
  'bridge.port': [1024, 65535], 'ai.maxRequestsPerRun': [0, 500], 'ai.maxProcessesPerRun': [0, 100], 'ai.dailyTokenBudget': [0, 50_000_000],
  'network.snapshot.everyMinutes': [5, 1440], 'network.snapshot.retentionDays': [1, 365], 'network.snapshot.maxMB': [1, 500],
  'network.deep.retentionDays': [1, 90], 'network.deep.maxMB': [5, 2000], 'network.deep.sampleSec': [2, 60],
  'network.thresholds.burstConnections': [5, 100000], 'network.thresholds.burstDestinations': [5, 100000], 'network.thresholds.unknownDestinations': [2, 1000],
  'network.thresholds.persistentDestinations': [2, 1000], 'network.thresholds.newConnectionsPerMinute': [5, 100000],
};
Object.assign(RANGES, {
  'cleanup.tempMinAgeDays': [0, 365], 'storage.minLargeFileMB': [1, 1_000_000], 'storage.oldFileDays': [1, 3650], 'storage.duplicateMinMB': [1, 100_000],
  'thresholds.cpuPct': [1, 100], 'thresholds.memoryMB': [50, 1_000_000], 'thresholds.diskFreeWarnPct': [1, 90], 'thresholds.diskFreeCritPct': [1, 89],
  'retention.reportsDays': [0, 3650], 'retention.metricsDays': [0, 3650], 'retention.actionsDays': [0, 3650],
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

module.exports = { readJson, writeJsonAtomic, tailJsonl, readAllJsonl, appendJsonl, uid, localIso, DEFAULT_CONFIG, mergeConfig, nextRun };
