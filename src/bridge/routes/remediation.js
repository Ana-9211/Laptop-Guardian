'use strict';
/** Action Center: findings, plan, execute, undo, history. */
const U = require('../lib/util');
const S = require('../lib/status');
const R = require('../lib/remediation');
const F = require('../lib/findings');
const { HttpError } = require('../lib/http');

module.exports = function registerRemediationRoutes(ctx) {
  const { root, guardianRoots, P, ps, tailActions, config, log, str, loadRecs, route, cachedTasks, applySchedule, netStore, netCtx, computeNetFindings } = ctx;
  const remediation = R.createRemediation({
    root, ps, log, tailJsonl: () => tailActions(5000), resultsDir: P.elevatedResults || undefined, guardianRoot: guardianRoots, readJson: U.readJson, config, applySchedule, netCtx,
    assessedTasks: () => S.assessTasks(cachedTasks(), config()),
  });
  ctx.remediation = remediation;
  const remed = async (fn) => { try { return await fn(); } catch (e) { if (e instanceof R.RemediationError) { const h = new HttpError(e.status, e.message); h.errors = e.errors; throw h; } throw e; } };
  // Read-only facts that cost a PowerShell start are cached for a few minutes.
  const FACT_TTL_MS = 10 * 60 * 1000;
  const facts = { apps: null, revo: null };
  const factInFlight = {};
  const FACT_WAIT_MS = 6000; // a slow registry read never blocks the findings list; the result is cached for the next load
  async function fact(topic) {
    const hit = facts[topic];
    if (hit && Date.now() - hit.at < FACT_TTL_MS) return hit.value;
    if (!factInFlight[topic]) {
      factInFlight[topic] = ps.run('Actions/Get-RemediationInfo.ps1', ['-Topic', topic]).then((r) => {
        const value = r.ok && r.data && r.data.ok !== false ? (topic === 'apps' ? (r.data.apps || []) : r.data.revo) : null;
        facts[topic] = { at: Date.now(), value };
        return value;
      }).finally(() => { factInFlight[topic] = null; });
    }
    return Promise.race([factInFlight[topic], new Promise((resolve) => setTimeout(() => resolve(hit ? hit.value : null), FACT_WAIT_MS))]);
  }
  route('GET', '/api/remediation/findings', async () => {
    const [apps, revo] = await Promise.all([fact('apps'), fact('revo')]);
    const procs = U.readJson(P.latest('processes.json'), { processes: [] }) || {};
    const c = config();
    const findings = F.buildFindings({
      recs: loadRecs().items, processes: procs.processes || [], files: U.readJson(P.latest('files.json'), null), daily: U.readJson(P.latest('daily.json'), null), weekly: U.readJson(P.latest('weekly.json'), null),
      tasks: S.assessTasks(cachedTasks(), c), apps, revo, history: remediation.history(300), protectedDirs: c.storage.protectedDirs || [], guardianRoot: guardianRoots, now: Date.now(),
    });
    const latest = netStore.readLatest();
    const merged = [...findings, ...(latest ? computeNetFindings(latest) : [])];
    const rank = { HIGH: 0, MEDIUM: 1, LOW: 2, UNKNOWN: 3 };
    merged.sort((a, b) => (rank[a.risk] ?? 3) - (rank[b.risk] ?? 3));
    return { generatedAt: U.localIso(), revo, findings: merged };
  });
  route('POST', '/api/remediation/plan', ({ body }) => remed(() => remediation.plan(str(body.actionId, 'actionId', 80), body.params || {})));
  route('POST', '/api/remediation/cancel', ({ body }) => remediation.cancel(str(body.token, 'token', 64)));
  route('POST', '/api/remediation/execute', ({ body }) => remed(() => remediation.execute(body.token, { confirm: body.confirm, acknowledged: body.acknowledged })));
  route('GET', '/api/remediation/result/:ticket', ({ params }) => remed(async () => remediation.result(params.ticket)));
  route('GET', '/api/remediation/history', ({ query }) => ({ items: remediation.history(Math.min(Math.max(parseInt(query.get('limit') || '100', 10) || 100, 1), 500)) }));
  route('POST', '/api/remediation/undo', ({ body }) => remed(() => remediation.undo(str(body.eventId, 'eventId', 80))));
};
