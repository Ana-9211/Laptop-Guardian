'use strict';
/**
 * Laptop Guardian local bridge. Binds 127.0.0.1 only. Serves the built dashboard and a JSON API.
 * Security model: Host allowlist, same-origin + custom-header on mutations, no CORS, fixed PowerShell scripts only.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const U = require('./lib/util');
const { makeRunner } = require('./lib/ps');

const MAX_BODY = 64 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
const RE_DAILY = /^\d{4}-\d{2}-\d{2}$/;
const RE_WEEKLY = /^\d{4}-W\d{2}$/;
const RE_HEX = /^[0-9a-f]{6,64}$/i;
const LISTS = ['blacklist', 'whitelist', 'ignored'];
const REC_STATUSES = ['open', 'dismissed', 'ignored', 'resolved', 'actioned'];

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function createApp(root, opts = {}) {
  const P = {
    config: path.join(root, 'config', 'config.json'),
    policy: path.join(root, 'config', 'process-policy.json'),
    cleanup: path.join(root, 'config', 'cleanup-policy.json'),
    actions: path.join(root, 'data', 'actions', 'actions.jsonl'),
    metrics: path.join(root, 'data', 'metrics', 'metrics.jsonl'),
    recs: path.join(root, 'data', 'recommendations', 'recommendations.json'),
    runState: path.join(root, 'data', 'state', 'run-state.json'),
    aiUsage: path.join(root, 'data', 'state', 'ai-usage.jsonl'),
    ignoredFiles: path.join(root, 'data', 'state', 'ignored-files.json'),
    latest: (n) => path.join(root, 'data', 'latest', n),
    key: path.join(root, 'data', 'secrets', 'gemini.dpapi'),
    reports: path.join(root, 'reports'),
    dist: opts.dist || path.join(root, 'src', 'dashboard', 'dist'),
  };
  const ps = makeRunner(root);
  let allowedHosts = new Set();

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

  const need = (cond, msg, status = 400) => { if (!cond) throw new HttpError(status, msg); };
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

  function filterMetrics(range) {
    const all = U.readAllJsonl(P.metrics);
    if (!range || range === 'all') return all;
    const days = Number(range);
    need([7, 30, 90].includes(days), 'range must be 7, 30, 90 or all');
    const cutoff = Date.now() - days * 86400000;
    return all.filter((m) => Date.parse(m.ts) >= cutoff);
  }

  function aiStatus() {
    const c = config();
    return { enabled: c.ai.enabled, keyConfigured: fs.existsSync(P.key), model: c.ai.model };
  }

  function csvEscape(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }
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

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler });
  };

  route('GET', '/api/overview', () => {
    const c = config();
    const recs = loadRecs().items;
    const metrics = filterMetrics('90');
    return {
      daily: U.readJson(P.latest('daily.json')), weekly: U.readJson(P.latest('weekly.json')), metrics,
      next: {
        daily: c.schedule.daily.enabled ? U.nextRun(c.schedule.daily.time) : null,
        weekly: c.schedule.weekly.enabled ? U.nextRun(c.schedule.weekly.time, c.schedule.weekly.day) : null,
        shutdown: c.schedule.weekly.enabled && c.schedule.weekly.shutdownEnabled && c.safety.weeklyShutdown ? U.nextRun(c.schedule.weekly.shutdownTime, c.schedule.weekly.day === 'Saturday' ? 'Saturday' : c.schedule.weekly.day) : null,
      },
      safety: c.safety, ai: aiStatus(), run: U.readJson(P.runState, {}),
      openRecommendations: recs.filter((r) => r.status === 'open').length,
    };
  });

  route('GET', '/api/metrics', ({ query }) => filterMetrics(query.get('range') || 'all'));

  route('GET', '/api/processes', () => U.readJson(P.latest('processes.json'), { generatedAt: null, processes: [] }));

  route('GET', '/api/processes/history', ({ query }) => {
    const name = str(query.get('name'), 'name', 128).toLowerCase();
    const appearances = [];
    for (const type of ['daily']) {
      for (const r of listReports(type).slice(0, 90)) {
        const rep = U.readJson(path.join(P.reports, type, r.id, 'report.json'));
        const pr = rep?.sections?.processes;
        const seen = [...(pr?.topCpu || []), ...(pr?.topMemory || [])].find((p) => String(p.name).toLowerCase() === name);
        if (seen) appearances.push({ ts: rep.generatedAt, cpuPct: seen.cpuPct, memoryMB: seen.memoryMB, flags: seen.flags || [] });
      }
    }
    const actions = U.tailJsonl(P.actions, 5000).filter((a) => a.target && String(a.target).toLowerCase().includes(name)).reverse().slice(0, 100);
    return { name, appearances, actions };
  });

  route('GET', '/api/recommendations', ({ query }) => {
    const status = query.get('status'); const kind = query.get('kind');
    const d = loadRecs();
    return { updatedAt: d.updatedAt, items: d.items.filter((r) => (!status || r.status === status) && (!kind || r.kind === kind)) };
  });

  route('POST', '/api/recommendations/:id/status', ({ params, body }) => {
    need(RE_HEX.test(params.id) || /^[\w.-]{1,80}$/.test(params.id), 'invalid id');
    need(REC_STATUSES.includes(body.status), `status must be one of ${REC_STATUSES.join(', ')}`);
    const d = loadRecs();
    const r = d.items.find((x) => x.id === params.id);
    need(r, 'recommendation not found', 404);
    const prev = r.status; r.status = body.status; d.updatedAt = U.localIso();
    U.writeJsonAtomic(P.recs, d);
    log({ category: 'policy', action: 'recommendation.status', target: r.title, reason: `${prev} -> ${body.status}`, relatedRecommendation: r.id });
    return r;
  });

  route('GET', '/api/actions', ({ query }) => {
    const limit = Math.min(Math.max(parseInt(query.get('limit') || '200', 10) || 200, 1), 2000);
    const cat = query.get('category'); const sev = query.get('severity'); const q = (query.get('q') || '').toLowerCase(); const before = query.get('before');
    let rows = U.tailJsonl(P.actions, 20000).reverse();
    if (cat) rows = rows.filter((r) => r.category === cat);
    if (sev) rows = rows.filter((r) => r.severity === sev);
    if (before) rows = rows.filter((r) => r.ts < before);
    if (q) rows = rows.filter((r) => JSON.stringify(r).toLowerCase().includes(q));
    return rows.slice(0, limit);
  });

  route('GET', '/api/reports', ({ query }) => {
    const t = query.get('type');
    if (t) { need(t === 'daily' || t === 'weekly', 'type must be daily or weekly'); return listReports(t); }
    return [...listReports('weekly'), ...listReports('daily')].sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  });

  route('GET', '/api/reports/export', ({ query }) => {
    const dir = reportDir(query.get('type'), query.get('id'));
    const r = U.readJson(path.join(dir, 'report.json'));
    need(r, 'report not found', 404);
    const fmt = query.get('format') || 'json';
    need(['json', 'csv'].includes(fmt), 'format must be json or csv');
    const name = `laptop-guardian-${query.get('type')}-${query.get('id')}.${fmt}`;
    if (fmt === 'json') return { __raw: JSON.stringify(r, null, 2), type: 'application/json; charset=utf-8', filename: name };
    const rows = flatten(r).map(([k, v]) => `${csvEscape(k)},${csvEscape(v)}`);
    return { __raw: 'key,value\n' + rows.join('\n'), type: 'text/csv; charset=utf-8', filename: name };
  });

  route('GET', '/api/reports/:type/:id', ({ params }) => {
    const r = U.readJson(path.join(reportDir(params.type, params.id), 'report.json'));
    need(r, 'report not found', 404);
    return r;
  });

  route('GET', '/api/reports/:type/:id/html', ({ params }) => {
    const f = path.join(reportDir(params.type, params.id), 'report.html');
    need(fs.existsSync(f), 'report html not found', 404);
    return { __raw: fs.readFileSync(f, 'utf8'), type: 'text/html; charset=utf-8', report: true };
  });

  route('DELETE', '/api/reports/:type/:id', ({ params }) => {
    const dir = reportDir(params.type, params.id);
    need(fs.existsSync(dir), 'report not found', 404);
    fs.rmSync(dir, { recursive: true, force: true });
    log({ category: 'system', action: 'report.delete', target: `${params.type}/${params.id}`, reason: 'user deleted historical report' });
    return { ok: true };
  });

  route('GET', '/api/files', () => {
    const d = U.readJson(P.latest('files.json'), { generatedAt: null, drives: [], candidates: [], largest: [], duplicates: [], downloads: {} }) || {};
    const ignored = new Set(U.readJson(P.ignoredFiles, []) || []);
    d.candidates = (d.candidates || []).map((c) => ({ ...c, ignored: c.ignored || ignored.has(c.id) }));
    return d;
  });

  route('POST', '/api/files/ignore', ({ body }) => {
    const id = str(body.id, 'id', 128);
    const set = new Set(U.readJson(P.ignoredFiles, []) || []);
    if (body.ignored === false) set.delete(id); else set.add(id);
    U.writeJsonAtomic(P.ignoredFiles, [...set]);
    log({ category: 'file', action: body.ignored === false ? 'file.unignore' : 'file.ignore', target: id });
    return { ok: true };
  });

  route('POST', '/api/files/recycle', async ({ body }) => {
    need(body.confirm === true, 'confirm:true required');
    const p = str(body.path, 'path', 1000);
    need(path.isAbsolute(p) && !p.startsWith('\\\\'), 'path must be an absolute local path');
    const files = U.readJson(P.latest('files.json'), {}) || {};
    const known = (files.candidates || []).some((c) => c.path === p);
    need(known, 'path is not a current Guardian file recommendation', 403);
    const r = await ps.run('Actions/Move-ToRecycleBin.ps1', ['-Path', p]);
    if (r.missing) throw new HttpError(501, r.error);
    const ok = r.ok && r.data && r.data.success !== false;
    log({ category: 'file', action: 'file.recycle', target: p, result: ok ? 'success' : 'failure', error: ok ? null : (r.error || r.data?.error || 'failed'), reason: 'user confirmed in dashboard' });
    need(ok, r.error || r.data?.error || 'recycle failed', 500);
    return r.data;
  });

  route('GET', '/api/config', () => ({ ...config(), _ai: aiStatus() }));
  route('PUT', '/api/config', ({ body }) => {
    const m = U.mergeConfig(config(), body);
    need(m.errors.length === 0, m.errors.join('; '));
    U.writeJsonAtomic(P.config, m.value);
    log({ category: 'config', action: 'config.update', target: Object.keys(body).join(','), reason: 'settings changed in dashboard' });
    return m.value;
  });

  route('GET', '/api/cleanup-policy', () => U.readJson(P.cleanup, {}) || {});
  route('PUT', '/api/cleanup-policy', ({ body }) => {
    need(body && typeof body === 'object' && !Array.isArray(body), 'body must be an object');
    need(JSON.stringify(body).length < 20000, 'too large');
    U.writeJsonAtomic(P.cleanup, body);
    log({ category: 'config', action: 'cleanup-policy.update', reason: 'cleanup policy changed' });
    return body;
  });

  route('GET', '/api/policy', () => policy());

  route('POST', '/api/policy', ({ body }) => {
    need(LISTS.includes(body.list), `list must be one of ${LISTS.join(', ')}`);
    const name = str(body.name, 'name', 128).replace(/\.exe$/i, '');
    need(/^[^\\/:*?"<>|\0]+$/.test(name), 'invalid process name');
    const p = body.path == null || body.path === '' ? null : str(body.path, 'path', 1000);
    const pol = policy();
    const key = name.toLowerCase();
    const matches = (e) => String(e.name).toLowerCase() === key && (!e.path || !p || e.path.toLowerCase() === p.toLowerCase());
    // A process lives in exactly one of blacklist/whitelist; moving it clears the opposite list.
    if (body.list === 'blacklist') pol.whitelist = pol.whitelist.filter((e) => !matches(e));
    if (body.list === 'whitelist') pol.blacklist = pol.blacklist.filter((e) => !matches(e));
    let entry = pol[body.list].find(matches);
    if (!entry) {
      entry = {
        id: U.uid('p_'), name, path: p, reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : '', addedAt: U.localIso(), addedBy: 'user',
        enabled: true, action: body.list === 'blacklist' ? 'terminate' : 'none', terminatedCount: 0, lastTerminatedAt: null, disabledUntil: null,
      };
      pol[body.list].push(entry);
    }
    U.writeJsonAtomic(P.policy, pol);
    log({ category: 'policy', action: `policy.${body.list}.add`, target: name, reason: entry.reason || null, relatedRecommendation: body.recommendationId || null });
    return entry;
  });

  route('PATCH', '/api/policy/:list/:id', ({ params, body }) => {
    need(LISTS.includes(params.list), 'invalid list');
    const pol = policy();
    const e = pol[params.list].find((x) => x.id === params.id);
    need(e, 'policy entry not found', 404);
    if (body.enabled !== undefined) { need(typeof body.enabled === 'boolean', 'enabled must be boolean'); e.enabled = body.enabled; }
    if (body.disabledUntil !== undefined) {
      need(body.disabledUntil === null || !Number.isNaN(Date.parse(body.disabledUntil)), 'disabledUntil must be date or null');
      e.disabledUntil = body.disabledUntil;
    }
    if (typeof body.reason === 'string') e.reason = body.reason.slice(0, 500);
    U.writeJsonAtomic(P.policy, pol);
    log({ category: 'policy', action: `policy.${params.list}.update`, target: e.name, reason: JSON.stringify(body).slice(0, 200) });
    return e;
  });

  route('DELETE', '/api/policy/:list/:id', ({ params }) => {
    need(LISTS.includes(params.list), 'invalid list');
    const pol = policy();
    const e = pol[params.list].find((x) => x.id === params.id);
    need(e, 'policy entry not found', 404);
    pol[params.list] = pol[params.list].filter((x) => x.id !== params.id);
    U.writeJsonAtomic(P.policy, pol);
    log({ category: 'policy', action: `policy.${params.list}.remove`, target: e.name });
    return { ok: true };
  });

  route('POST', '/api/process/kill', async ({ body }) => {
    need(body.confirm === true, 'confirm:true required');
    need(Number.isInteger(body.pid) && body.pid > 4 && body.pid < 4194304, 'pid must be an integer > 4');
    const name = str(body.name, 'name', 128);
    const p = body.path == null || body.path === '' ? '' : str(body.path, 'path', 1000);
    // The target must be a process Guardian has actually observed; the script re-validates against the live process and a protected list.
    const snap = U.readJson(P.latest('processes.json'), { processes: [] }) || {};
    need((snap.processes || []).some((x) => x.pid === body.pid && String(x.name).toLowerCase() === name.toLowerCase()), 'process is not in the latest Guardian snapshot; refresh first', 409);
    const r = await ps.run('Actions/Stop-GuardianProcess.ps1', ['-ProcessId', String(body.pid), '-Name', name, '-Path', p]);
    if (r.missing) throw new HttpError(501, r.error);
    const ok = r.ok && r.data && r.data.success !== false;
    log({ category: 'process', action: 'process.kill', target: `${name} (PID ${body.pid})`, result: ok ? 'success' : 'failure', reason: 'user clicked Kill once', relatedRecommendation: body.recommendationId || null, error: ok ? null : (r.error || r.data?.error || 'failed') });
    need(ok, r.error || r.data?.error || 'kill failed', 422);
    return r.data;
  });

  // ---- AI ----
  route('GET', '/api/ai/status', () => aiStatus());
  route('POST', '/api/ai/key', async ({ body }) => {
    const key = str(body.key, 'key', 200).trim();
    need(/^[A-Za-z0-9_\-]{20,200}$/.test(key), 'key has an unexpected format');
    const r = await ps.run('Actions/Set-GeminiKey.ps1', [], { stdin: key });
    if (r.missing) throw new HttpError(501, r.error);
    need(r.ok && r.data?.success !== false, r.error || r.data?.error || 'could not store key', 500);
    log({ category: 'config', action: 'ai.key.set', target: 'gemini', reason: 'API key stored (DPAPI, current user)' });
    return { keyConfigured: true };
  });
  route('DELETE', '/api/ai/key', async () => {
    const r = await ps.run('Actions/Set-GeminiKey.ps1', ['-Remove']);
    if (r.missing) {
      try { fs.rmSync(P.key, { force: true }); } catch { /* ignore */ }
    } else need(r.ok, r.error || 'could not remove key', 500);
    log({ category: 'config', action: 'ai.key.remove', target: 'gemini' });
    return { keyConfigured: false };
  });
  route('POST', '/api/ai/test', async () => {
    const r = await ps.run('AI/Test-Gemini.ps1', [], { timeoutMs: 45000 });
    if (r.missing) throw new HttpError(501, r.error);
    const ok = r.ok && r.data?.success !== false;
    log({ category: 'ai', action: 'ai.test', target: 'gemini', result: ok ? 'success' : 'failure', error: ok ? null : (r.error || r.data?.error || null) });
    return { ok, ...(r.data || {}), error: ok ? undefined : (r.error || r.data?.error) };
  });
  route('POST', '/api/ai/analyze', async ({ body }) => {
    const id = str(body.recommendationId, 'recommendationId', 80);
    need(/^[\w.-]+$/.test(id), 'invalid id');
    need(config().ai.enabled, 'AI analysis is disabled in Settings', 409);
    log({ category: 'ai', action: 'ai.analysis.requested', target: id, result: 'started', relatedRecommendation: id, reason: 'user requested; structured metadata is sent to Gemini' });
    const r = await ps.run('AI/Invoke-AiAnalyze.ps1', ['-RecommendationId', id], { timeoutMs: 90000 });
    if (r.missing) throw new HttpError(501, r.error);
    need(r.ok && r.data?.success !== false, r.error || r.data?.error || 'analysis failed', 502);
    return r.data;
  });
  route('GET', '/api/ai/usage', () => {
    const rows = U.tailJsonl(P.aiUsage, 500);
    const today = U.localIso().slice(0, 10);
    const sum = (f) => rows.filter(f).reduce((a, r) => a + (r.promptTokens || 0) + (r.outputTokens || 0), 0);
    return { requests: rows.slice(-50).reverse(), totals: { requests: rows.length, failures: rows.filter((r) => !r.ok).length, tokensToday: sum((r) => String(r.ts).startsWith(today)), tokensAll: sum(() => true) } };
  });

  // ---- scan / schedule ----
  route('GET', '/api/run', () => U.readJson(P.runState, {}) || {});
  const launchScan = (kind, args) => {
    const st = U.readJson(P.runState, {}) || {};
    need(!st.running, `a ${st.running?.type} run is already in progress`, 409);
    const r = ps.launch(`${kind}.ps1`, args);
    if (r.missing) throw new HttpError(501, r.error);
    log({ category: 'scan', action: `${kind.toLowerCase()}.start`, result: 'started', reason: 'user requested from dashboard' });
    return { started: true };
  };
  route('POST', '/api/scan/daily', () => launchScan('Daily', []));
  route('POST', '/api/scan/weekly', ({ body }) => launchScan('Weekly', ['-NoShutdown']));

  route('GET', '/api/schedule', async () => {
    const r = await ps.run('Scheduler.ps1', ['-Action', 'Status', '-Json']);
    if (r.missing) throw new HttpError(501, r.error);
    need(r.ok, r.error || 'scheduler query failed', 500);
    return { tasks: Array.isArray(r.data) ? r.data : (r.data.tasks || []), config: config().schedule };
  });
  route('PUT', '/api/schedule', async ({ body }) => {
    const m = U.mergeConfig(config(), { schedule: body });
    need(m.errors.length === 0, m.errors.join('; '));
    U.writeJsonAtomic(P.config, m.value);
    log({ category: 'config', action: 'schedule.update', reason: JSON.stringify(body).slice(0, 200) });
    const r = await ps.run('Scheduler.ps1', ['-Action', 'Register', '-Json']);
    if (r.missing) return { saved: true, registered: false, warning: r.error, schedule: m.value.schedule };
    log({ category: 'config', action: 'schedule.register', result: r.ok ? 'success' : 'failure', error: r.ok ? null : r.error });
    return { saved: true, registered: r.ok, warning: r.ok ? undefined : r.error, schedule: m.value.schedule };
  });

  // ---------- request pipeline ----------
  function securityHeaders(res, extra = {}) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
  }
  const sendJson = (res, status, obj) => {
    const b = JSON.stringify(obj);
    securityHeaders(res, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) });
    res.writeHead(status); res.end(b);
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, 'request body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); } catch { reject(new HttpError(400, 'invalid JSON')); }
      });
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    const base = path.resolve(P.dist);
    let rel = decodeURIComponent(pathname);
    if (rel.includes('\0')) throw new HttpError(400, 'bad path');
    let file = path.resolve(base, '.' + path.posix.normalize('/' + rel));
    if (file !== base && !file.startsWith(base + path.sep)) throw new HttpError(403, 'forbidden');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(base, 'index.html');
    if (!fs.existsSync(file)) {
      securityHeaders(res, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.writeHead(503); return res.end('Dashboard not built. Run: npm install && npm run build in src/dashboard');
    }
    const ext = path.extname(file).toLowerCase();
    securityHeaders(res, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-store',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
    });
    res.writeHead(200); fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    try {
      const host = String(req.headers.host || '').toLowerCase();
      need(allowedHosts.has(host), 'invalid Host header', 403);
      const url = new URL(req.url, `http://${host}`);
      const method = req.method;
      if (!url.pathname.startsWith('/api/')) {
        need(method === 'GET' || method === 'HEAD', 'method not allowed', 405);
        return serveStatic(req, res, url.pathname);
      }
      const mutating = method !== 'GET' && method !== 'HEAD';
      if (mutating) {
        need(req.headers['x-guardian'] === '1', 'missing X-Guardian header', 403);
        const origin = req.headers.origin;
        need(!!origin && origin.startsWith('http://') && allowedHosts.has(origin.replace(/^http:\/\//, '').toLowerCase()), 'same-origin Origin header required', 403);
      }
      const r = routes.find((x) => x.method === method && x.re.test(url.pathname));
      if (!r) {
        const pathMatch = routes.some((x) => x.re.test(url.pathname));
        throw new HttpError(pathMatch ? 405 : 404, pathMatch ? 'method not allowed' : 'not found');
      }
      const m = r.re.exec(url.pathname);
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      const body = mutating ? await readBody(req) : {};
      const out = await r.handler({ params, query: url.searchParams, body });
      if (out && out.__raw !== undefined) {
        const h = { 'Content-Type': out.type };
        if (out.filename) h['Content-Disposition'] = `attachment; filename="${out.filename}"`;
        if (out.report) h['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
        securityHeaders(res, h);
        res.writeHead(200); return res.end(out.__raw);
      }
      sendJson(res, 200, out === undefined ? { ok: true } : out);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) console.error('[bridge] unhandled', e);
      if (!res.headersSent) sendJson(res, status, { error: e instanceof HttpError ? e.message : 'internal error' });
      else res.end();
    }
  }

  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 120000;
  server.listen_ = (port, cb) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      allowedHosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
      if (opts.extraHosts) opts.extraHosts.forEach((h) => allowedHosts.add(h));
      cb && cb(actual);
    });
  };
  return server;
}

module.exports = { createApp };

if (require.main === module) {
  const root = path.resolve(process.env.GUARDIAN_ROOT || path.join(__dirname, '..', '..'));
  const cfg = U.mergeConfig(U.DEFAULT_CONFIG, U.readJson(path.join(root, 'config', 'config.json'), {}) || {}).value;
  const port = Number(process.env.GUARDIAN_PORT) || cfg.bridge.port;
  const dev = process.env.GUARDIAN_DEV_HOST; // e.g. 127.0.0.1:5173 when running Vite dev proxy
  const app = createApp(root, { extraHosts: dev ? [dev] : [] });
  app.on('error', (e) => { console.error(`[bridge] ${e.code === 'EADDRINUSE' ? `port ${port} already in use` : e.message}`); process.exit(1); });
  app.listen_(port, (p) => console.log(`Laptop Guardian dashboard: http://127.0.0.1:${p}/  (root: ${root})`));
}
