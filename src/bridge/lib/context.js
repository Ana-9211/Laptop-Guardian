'use strict';
/**
 * The shared state every route uses: file paths, config and policy readers, the audit log, input checks, the Task Scheduler cache,
 * the session token and the route table. Built once per bridge by createApp.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const U = require('./util');
const S = require('./status');
const { makeRunner } = require('./ps');
const { SCHED_CACHE_MS, SCHED_WAITING_MS, SCHED_READ_RETRIES, ELEVATION_WAIT_MS, ELEVATION_TIMEOUT_MS, RE_DAILY, RE_WEEKLY } = require('./constants');
const { need } = require('./http');

function createContext(root, opts = {}) {
  // `root` holds config, data, reports and logs. `codeRoot` holds the program files (the same folder in a development checkout and in tests).
  const codeRoot = opts.codeRoot || root;
  const elevatedDir = opts.elevatedDir || null;   // administrators-only folder of an installed copy: elevated results and audit lines
  const guardianRoots = codeRoot === root ? root : [root, codeRoot];
  const P = {
    config: path.join(root, 'config', 'config.json'),
    policy: path.join(root, 'config', 'process-policy.json'),
    actions: path.join(root, 'data', 'actions', 'actions.jsonl'),
    metrics: path.join(root, 'data', 'metrics', 'metrics.jsonl'),
    recs: path.join(root, 'data', 'recommendations', 'recommendations.json'),
    runState: path.join(root, 'data', 'state', 'run-state.json'),
    bridgePid: path.join(root, 'data', 'state', 'bridge.json'),
    aiUsage: path.join(root, 'data', 'state', 'ai-usage.jsonl'),
    ignoredFiles: path.join(root, 'data', 'state', 'ignored-files.json'),
    latest: (n) => path.join(root, 'data', 'latest', n),
    key: path.join(root, 'data', 'secrets', 'gemini.dpapi'),
    reports: path.join(root, 'reports'),
    dist: opts.dist || path.join(codeRoot, 'src', 'dashboard', 'dist'),
    elevatedAudit: elevatedDir ? path.join(elevatedDir, 'audit', 'actions.jsonl') : null,
    elevatedResults: elevatedDir ? path.join(elevatedDir, 'results') : null,
  };
  const ps = opts.ps || makeRunner(codeRoot, root);
  /** The audit trail: the user's log plus, for an installed copy, the lines elevated runs wrote to the administrators-only folder. Newest last. */
  const tailActions = (n) => {
    const rows = U.tailJsonl(P.actions, n);
    if (!P.elevatedAudit) return rows;
    return rows.concat(U.tailJsonl(P.elevatedAudit, n)).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)).slice(-n);
  };
  const state = { boundPort: null };   // read by routes: the port the server is actually listening on

  const config = () => U.mergeConfig(U.DEFAULT_CONFIG, U.readJson(P.config, {}) || {}).value;
  const policy = () => {
    const p = U.readJson(P.policy, {}) || {};
    return { blacklist: p.blacklist || [], whitelist: p.whitelist || [], ignored: p.ignored || [] };
  };

  function log(ev) {
    const e = {
      id: U.uid('a_'), ts: U.localIso(), category: 'system', severity: 'info', action: '', target: null,
      result: 'success', actor: 'user', reason: null, relatedRecommendation: null, error: null, runType: null, ...ev,
    };
    try { U.appendJsonl(P.actions, e); } catch { /* logging must never break a request */ }
    return e;
  }


  const str = (v, name, max = 300) => {
    need(typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0'), `${name} must be a non-empty string (max ${max})`);
    return v;
  };


  // ---------- helpers ----------
  function listReports(type) {
    const dir = path.join(P.reports, type);
    const re = type === 'daily' ? RE_DAILY : RE_WEEKLY;
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => re.test(n)); } catch { return []; }
    return names.sort().reverse().map((id) => {
      const f = path.join(dir, id, 'report.json');
      const r = U.readJson(f);
      if (!r) return null;
      let sizeKB = 0;
      try { sizeKB = Math.round(fs.statSync(f).size / 1024); } catch { /* ignore */ }
      return { type, id, generatedAt: r.generatedAt, status: r.status, healthScore: r.healthScore, summary: r.summary, sizeKB, hasHtml: fs.existsSync(path.join(dir, id, 'report.html')) };
    }).filter(Boolean);
  }
  function reportDir(type, id) {
    need(type === 'daily' || type === 'weekly', 'type must be daily or weekly');
    need(typeof id === 'string' && (type === 'daily' ? RE_DAILY : RE_WEEKLY).test(id), 'invalid report id');
    return path.join(P.reports, type, id);
  }

  function loadRecs() { return U.readJson(P.recs, { updatedAt: null, items: [] }) || { updatedAt: null, items: [] }; }

  // The metrics file only grows, and every dashboard poll asks for it: parse it only when it changed, and read a bounded tail.
  const METRICS_TAIL_BYTES = { ranged: 8 * 1024 * 1024, all: 32 * 1024 * 1024 };
  let metricsCache = { key: null, rows: [] };
  function readMetrics(maxBytes) {
    let st; try { st = fs.statSync(P.metrics); } catch { return []; }
    const key = `${st.size}:${st.mtimeMs}:${maxBytes}`;
    if (metricsCache.key !== key) metricsCache = { key, rows: U.tailJsonl(P.metrics, Number.MAX_SAFE_INTEGER, maxBytes) };
    return metricsCache.rows;
  }
  function filterMetrics(range) {
    if (!range || range === 'all') return readMetrics(METRICS_TAIL_BYTES.all);
    const days = Number(range);
    need([7, 30, 90].includes(days), 'range must be 7, 30, 90 or all');
    const cutoff = Date.now() - days * 86400000;
    return readMetrics(METRICS_TAIL_BYTES.ranged).filter((m) => Date.parse(m.ts) >= cutoff);
  }

  function aiStatus() {
    const c = config();
    return { enabled: c.ai.enabled, keyConfigured: fs.existsSync(P.key), model: c.ai.model };
  }

  const csvEscape = U.csvCell;
  function flatten(obj, prefix = '', out = []) {
    if (obj === null || obj === undefined) { out.push([prefix, '']); return out; }
    if (typeof obj !== 'object') { out.push([prefix, obj]); return out; }
    if (Array.isArray(obj)) {
      if (obj.every((x) => typeof x !== 'object' || x === null)) out.push([prefix, obj.join('; ')]);
      else obj.forEach((x, i) => flatten(x, `${prefix}[${i}]`, out));
      return out;
    }
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  }


  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  const startedAt = U.localIso();
  // Per-start session token. Every /api request except /api/ping must carry it as a Bearer token. `token: false` disables it (tests of other features only).
  const token = opts.token === false ? null : (opts.token || crypto.randomBytes(32).toString('hex'));
  const digest = (v) => crypto.createHash('sha256').update(String(v)).digest();
  const tokenOk = (header) => { if (!token) return true; const m = /^Bearer ([A-Za-z0-9_-]{16,200})$/.exec(String(header || '')); return !!m && crypto.timingSafeEqual(digest(m[1]), digest(token)); };
  const startedMs = Date.now();
  // Newest modification time among the bridge's own code. A newer file than the process start means this bridge runs old code.
  let codeCache = { at: 0, mtimeMs: 0 };
  function codeMtime() {
    if (Date.now() - codeCache.at < 10000) return codeCache.mtimeMs;
    let newest = 0;
    const walk = (dir) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f); else if (e.name.endsWith('.js')) newest = Math.max(newest, fs.statSync(f).mtimeMs); } };
    try { walk(path.join(codeRoot, 'src', 'bridge')); } catch { /* unreadable: report no change */ }
    try { newest = Math.max(newest, fs.statSync(path.join(codeRoot, 'src', 'shared', 'action-catalog.json')).mtimeMs); } catch { /* optional */ }
    codeCache = { at: Date.now(), mtimeMs: newest };
    return newest;
  }
  const restartNeeded = () => codeMtime() > startedMs + 2000;
  const isAlive = opts.isAlive || ((pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } });
  const currentRun = () => S.sanitizeRun(U.readJson(P.runState, {}) || {}, isAlive);
  const mtimeCache = new Map();
  /** readJson that only re-parses when the file's mtime/size changed (status polls must stay cheap). */
  function cachedJson(file, fallback = null) {
    try {
      const st = fs.statSync(file); const key = `${st.mtimeMs}:${st.size}`; const hit = mtimeCache.get(file);
      if (hit && hit.key === key) return hit.value;
      const value = U.readJson(file, fallback); mtimeCache.set(file, { key, value }); return value;
    } catch { return fallback; }
  }
  // Reading Task Scheduler costs a PowerShell start (~3-4 s). Polls never wait for it: they get the cached rows (or
  // `pending: true` on a cold start) while one shared background query refreshes them. Only `fresh` waits.
  // The cache keeps the last GOOD read (`okAt`) so a failed query shows old rows plus an honest error, never a fake "just now".
  let schedCache = null; // { at, okAt, tasks, error }
  let schedInFlight = null;
  let schedGen = 0; // bumped whenever the tasks are changed; a read that started before the change is discarded
  let elevationRequestedAt = null;
  async function readTasks() {
    for (let attempt = 0; ; attempt++) {
      const gen = schedGen;
      const r = await ps.run('Scheduler.ps1', ['-Action', 'Status', '-Json']);
      if (gen === schedGen || attempt >= SCHED_READ_RETRIES) return r;
    }
  }
  function storeTasks(tasks) { schedCache = { at: Date.now(), okAt: Date.now(), tasks, error: null }; return schedCache; }
  function queryTasks() {
    if (schedInFlight) return schedInFlight;
    schedInFlight = readTasks().then((r) => {
      if (r.missing || !r.ok) return (schedCache = { at: Date.now(), okAt: schedCache?.okAt ?? null, tasks: schedCache?.tasks || [], error: r.error || 'scheduler query failed' });
      return storeTasks(Array.isArray(r.data) ? r.data : (r.data.tasks || []));
    }).finally(() => { schedInFlight = null; });
    return schedInFlight;
  }
  async function getTasks(fresh = false) {
    if (fresh) return queryTasks();
    if (!schedCache) { void queryTasks(); return { at: Date.now(), okAt: null, tasks: [], error: null, pending: true }; }
    if (Date.now() - schedCache.at >= (elevationRequestedAt ? SCHED_WAITING_MS : SCHED_CACHE_MS)) void queryTasks();
    return schedCache;
  }
  const dirCount = (type, re) => { try { return fs.readdirSync(path.join(P.reports, type)).filter((n) => re.test(n)).length; } catch { return 0; } };

  /** True while a UAC request is outstanding and the tasks still need the repair it was asked for. */
  function elevationPending(assessed) {
    if (!elevationRequestedAt) return null;
    const waiting = Date.now() - elevationRequestedAt < ELEVATION_WAIT_MS && assessed.some((t) => t.repair.needed);
    if (!waiting) { elevationRequestedAt = null; return null; }
    return { since: new Date(elevationRequestedAt).toISOString() };
  }

  let schedApplying = false;
  /**
   * The ONLY place that changes Task Scheduler. `elevate:false` registers as the current (standard) user and never replaces
   * an elevated Daily/Weekly task (the script reports `needsElevation` instead). `elevate:true` asks Windows for a UAC prompt
   * to run that same fixed Register action; it never runs anything else.
   */
  async function applySchedule({ elevate = false } = {}) {
    need(!schedApplying, 'a schedule change is already in progress', 409);
    schedApplying = true;
    try {
      schedGen++;
      const args = ['-Action', 'Register', '-Json'].concat(elevate ? ['-Elevate'] : []);
      const r = await ps.run('Scheduler.ps1', args, { timeoutMs: elevate ? ELEVATION_TIMEOUT_MS : 60000 });
      if (r.missing) return { registered: false, needsElevation: false, elevationRequested: false, message: r.error, report: [] };
      const d = r.data || {};
      const ok = r.ok && d.ok !== false;
      if (elevate) { if (d.elevationRequested) elevationRequestedAt = Date.now(); if (schedCache) schedCache.at = 0; }
      else if (Array.isArray(d.tasks) && d.tasks.length) storeTasks(d.tasks); else if (schedCache) schedCache.at = 0;
      const message = d.message || r.error || (ok ? '' : 'scheduler failed');
      log({ category: 'config', action: elevate ? 'schedule.elevate' : 'schedule.register', result: ok ? 'success' : 'failure', error: ok ? null : message, reason: message || null });
      return { registered: ok && !elevate, needsElevation: !!d.needsElevation, elevationRequested: !!d.elevationRequested, message, report: d.report || [] };
    } finally { schedApplying = false; }
  }

  /** Runs a synchronous handler while holding the shared lock for `file`, so a read-modify-write is not interleaved with the agents. */
  function locked(file, handler) { return (args) => U.withFileLock(file, () => handler(args)); }

  /** One definition of "a weekly shutdown can happen", shared by /api/status and /api/overview. */
  function shutdownArmed(c) { return !!(c.schedule.weekly.enabled && c.schedule.weekly.shutdownEnabled && c.safety.weeklyShutdown && !c.safety.automationPaused); }
  const cachedTasks = () => (schedCache && schedCache.tasks) || [];

  return { root, codeRoot, elevatedDir, guardianRoots, opts, P, ps, tailActions, config, policy, log, need, str, listReports, reportDir, loadRecs, filterMetrics, aiStatus, csvEscape, flatten, route, routes, locked, shutdownArmed, dirCount, startedAt, token, tokenOk, codeMtime, restartNeeded, currentRun, cachedJson, storeTasks, queryTasks, getTasks, cachedTasks, elevationPending, applySchedule, state };
}

module.exports = { createContext };
