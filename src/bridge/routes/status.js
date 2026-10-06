'use strict';
/** Live status, overview, metrics, processes, recommendations and the audit log. */
const fs = require('fs');
const path = require('path');
const U = require('../lib/util');
const S = require('../lib/status');
const { VERSION, RE_DAILY, RE_WEEKLY, REC_STATUSES } = require('../lib/constants');

const ARCHIVE_SEARCH_BYTES = 8 * 1024 * 1024;

module.exports = function registerStatusRoutes(ctx) {
  const { root, codeRoot, P, tailActions, config, log, need, str, listReports, loadRecs, filterMetrics, aiStatus, route, locked, shutdownArmed, dirCount, startedAt, codeMtime, restartNeeded, currentRun, cachedJson, getTasks, elevationPending, state, netStore, deep } = ctx;
  // `root` lets the launcher confirm a bridge belongs to THIS installation before it ever considers stopping it.
  route('GET', '/api/ping', () => ({ app: 'laptop-guardian', version: VERSION, pid: process.pid, startedAt, codeMtime: new Date(codeMtime()).toISOString(), restartNeeded: restartNeeded(), port: state.boundPort, root: codeRoot, dataRoot: root, distBuilt: fs.existsSync(path.join(P.dist, 'index.html')) }));

  route('GET', '/api/status', async ({ query }) => {
    const c = config();
    const run = currentRun();
    const st = await getTasks(query.get('fresh') === '1');
    const tasks = S.assessTasks(st.tasks, c);
    const acts = tailActions(400);
    const dayAgo = Date.now() - 86400000;
    const recent = acts.filter((a) => Date.parse(a.ts) >= dayAgo);
    const lastErr = [...acts].reverse().find((a) => a.severity === 'error');
    const recs = loadRecs().items.filter((r) => r.status === 'open');
    const daily = cachedJson(P.latest('daily.json')); const weekly = cachedJson(P.latest('weekly.json'));
    const procs = cachedJson(P.latest('processes.json'), null); const files = cachedJson(P.latest('files.json'), null);
    const shutdownGates = shutdownArmed(c);
    const worst = tasks.some((t) => t.level === 'crit') ? 'crit' : tasks.some((t) => t.level === 'warn') ? 'warn' : tasks.some((t) => t.level === 'info' && t.status !== 'never-run' && t.status !== 'off') ? 'info' : 'ok';
    return {
      now: U.localIso(),
      bridge: { ok: true, pid: process.pid, version: VERSION, startedAt, restartNeeded: restartNeeded(), port: state.boundPort, uptimeSec: Math.round(process.uptime()) },
      run,
      lastAction: acts.length ? acts[acts.length - 1] : null,
      actions24h: { total: recent.length, warnings: recent.filter((a) => a.severity === 'warning').length, errors: recent.filter((a) => a.severity === 'error').length, lastError: lastErr ? { ts: lastErr.ts, action: lastErr.action, error: lastErr.error || lastErr.reason } : null },
      reports: {
        daily: daily ? { id: daily.id, generatedAt: daily.generatedAt, status: daily.status, healthScore: daily.healthScore } : null,
        weekly: weekly ? { id: weekly.id, generatedAt: weekly.generatedAt, status: weekly.status, healthScore: weekly.healthScore } : null,
        counts: { daily: dirCount('daily', RE_DAILY), weekly: dirCount('weekly', RE_WEEKLY) },
      },
      snapshots: { processes: procs ? { generatedAt: procs.generatedAt, count: (procs.processes || []).length } : null, files: files ? { generatedAt: files.generatedAt, candidates: (files.candidates || []).length } : null },
      schedule: {
        tasks, fetchedAt: st.okAt ? new Date(st.okAt).toISOString() : null, error: st.error, pending: !!st.pending, level: st.error ? 'warn' : st.pending ? 'info' : worst,
        elevationPending: elevationPending(tasks),
      },
      next: {
        daily: c.schedule.daily.enabled ? U.nextRun(c.schedule.daily.time) : null,
        weekly: c.schedule.weekly.enabled ? U.nextRun(c.schedule.weekly.time, c.schedule.weekly.day) : null,
      },
      shutdown: {
        armed: shutdownGates, target: shutdownGates ? U.nextRun(c.schedule.weekly.shutdownTime, c.schedule.weekly.day) : null,
        pending: S.pendingShutdown(acts.filter((a) => a.category === 'shutdown')), cancelCommand: 'shutdown /a',
        note: 'Only the scheduled weekly run can start a shutdown. Manual and dashboard runs never do.',
      },
      safety: c.safety, ai: aiStatus(),
      network: { deepActive: deep.active(), deepSince: state.deepStartedAt, lastSnapshotAt: (netStore.readLatest() || {}).generatedAt || null, dnsFiltering: !!c.network.dnsFiltering.enabled },
      openRecommendations: recs.length,
      attention: S.buildAttention({ daily, tasks, run, openRecs: recs.length, highRiskRecs: recs.filter((r) => r.risk === 'HIGH').length, config: c, stale: run.stale, recentActions: acts }),
    };
  });

  route('GET', '/api/overview', () => {
    const c = config();
    const recs = loadRecs().items;
    const metrics = filterMetrics('90');
    return {
      daily: U.readJson(P.latest('daily.json')), weekly: U.readJson(P.latest('weekly.json')), metrics,
      next: {
        daily: c.schedule.daily.enabled ? U.nextRun(c.schedule.daily.time) : null,
        weekly: c.schedule.weekly.enabled ? U.nextRun(c.schedule.weekly.time, c.schedule.weekly.day) : null,
        shutdown: shutdownArmed(c) ? U.nextRun(c.schedule.weekly.shutdownTime, c.schedule.weekly.day) : null,
      },
      safety: c.safety, ai: aiStatus(), run: currentRun(),
      openRecommendations: recs.filter((r) => r.status === 'open').length,
    };
  });

  route('GET', '/api/metrics', ({ query }) => filterMetrics(query.get('range') || 'all'));

  route('GET', '/api/processes', () => U.readJson(P.latest('processes.json'), { generatedAt: null, processes: [] }));

  // A finished report never changes, so the few fields this endpoint needs are read from it once and kept.
  const dailyIndex = new Map();
  function dailyProcessIndex(id) {
    if (!dailyIndex.has(id)) {
      const rep = U.readJson(path.join(P.reports, 'daily', id, 'report.json'));
      const pr = rep && rep.sections && rep.sections.processes;
      dailyIndex.set(id, { ts: rep ? rep.generatedAt : null, list: [...((pr && pr.topCpu) || []), ...((pr && pr.topMemory) || [])].map((p) => ({ name: p.name, cpuPct: p.cpuPct, memoryMB: p.memoryMB, flags: p.flags })) });
      if (dailyIndex.size > 400) dailyIndex.delete(dailyIndex.keys().next().value);
    }
    return dailyIndex.get(id);
  }
  route('GET', '/api/processes/history', ({ query }) => {
    const name = str(query.get('name'), 'name', 128).toLowerCase();
    const appearances = [];
    for (const r of listReports('daily').slice(0, 90)) {
      const procs = dailyProcessIndex(r.id);
      const seen = procs.list.find((p) => String(p.name).toLowerCase() === name);
      if (seen) appearances.push({ ts: procs.ts, cpuPct: seen.cpuPct, memoryMB: seen.memoryMB, flags: seen.flags || [] });
    }
    const actions = tailActions(5000).filter((a) => a.target && String(a.target).toLowerCase().includes(name)).reverse().slice(0, 100);
    return { name, appearances, actions };
  });

  route('GET', '/api/recommendations', ({ query }) => {
    const status = query.get('status'); const kind = query.get('kind');
    const d = loadRecs();
    return { updatedAt: d.updatedAt, items: d.items.filter((r) => (!status || r.status === status) && (!kind || r.kind === kind)) };
  });

  route('POST', '/api/recommendations/:id/status', locked(P.recs, ({ params, body }) => {
    need(/^[\w.-]{1,80}$/.test(params.id), 'invalid id');
    need(REC_STATUSES.includes(body.status), `status must be one of ${REC_STATUSES.join(', ')}`);
    const d = loadRecs();
    const r = d.items.find((x) => x.id === params.id);
    need(r, 'recommendation not found', 404);
    const prev = r.status; r.status = body.status; d.updatedAt = U.localIso();
    U.writeJsonAtomic(P.recs, d);
    log({ category: 'policy', action: 'recommendation.status', target: r.title, reason: `${prev} -> ${body.status}`, relatedRecommendation: r.id });
    return r;
  }));

  route('GET', '/api/actions', ({ query }) => {
    const limit = Math.min(Math.max(parseInt(query.get('limit') || '200', 10) || 200, 1), 2000);
    const cat = query.get('category'); const sev = query.get('severity'); const q = (query.get('q') || '').toLowerCase(); const before = query.get('before');
    const keep = (r) => (!cat || r.category === cat) && (!sev || r.severity === sev) && (!before || r.ts < before) && (!q || JSON.stringify(r).toLowerCase().includes(q));
    let rows = tailActions(20000).reverse().filter(keep);
    // Older rows live in monthly archive files (see lib/maintenance.js). They are searched only on request, newest month first, and never more than
    // ARCHIVE_SEARCH_BYTES in total, so one search cannot read an unbounded amount of history.
    if (query.get('archived') === '1' && rows.length < limit) {
      const dir = path.join(path.dirname(P.actions), 'archive');
      let files = []; try { files = fs.readdirSync(dir).filter((n) => /^actions-\d{4}-\d{2}\.jsonl$/.test(n)).sort().reverse(); } catch { /* no archive yet */ }
      let budget = ARCHIVE_SEARCH_BYTES;
      for (const n of files) {
        if (budget <= 0 || rows.length >= limit) break;
        const f = path.join(dir, n); let size = 0; try { size = fs.statSync(f).size; } catch { continue; }
        budget -= Math.min(size, budget);
        rows = rows.concat(U.tailJsonl(f, Number.MAX_SAFE_INTEGER, Math.min(size, ARCHIVE_SEARCH_BYTES)).reverse().filter(keep).map((r) => ({ ...r, archived: true })));
      }
    }
    return rows.slice(0, limit);
  });
};
