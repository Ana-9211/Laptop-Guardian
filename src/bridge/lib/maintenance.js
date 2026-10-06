'use strict';
/**
 * Scheduled housekeeping for the JSONL files. Runs shortly after the bridge starts and then once a day (never while a scan is running).
 * Metrics: raw rows for METRICS_RAW_DAYS, older ones rolled into metrics-daily.jsonl. Audit log: raw rows for AUDIT_RAW_DAYS, older rows moved
 * to data/actions/archive/actions-YYYY-MM.jsonl (nothing is deleted) with a daily summary. Deep Network Guard day files are summarised by netdeep
 * before they expire.
 */
const path = require('path');
const C = require('./compact');
const { METRICS_RAW_DAYS, AUDIT_RAW_DAYS } = require('./constants');

function runMaintenance({ P, log, now = Date.now(), deep = null, running = false, retention = {} }) {
  // Settings values, clamped again here so a hand-edited config can never make the window absurdly small or turn compaction into deletion.
  const clamp = (v, d) => (Number.isFinite(Number(v)) ? Math.min(730, Math.max(30, Math.round(Number(v)))) : d);
  const metricsDays = clamp(retention.metricsRawDays, METRICS_RAW_DAYS); const auditDays = clamp(retention.auditRawDays, AUDIT_RAW_DAYS);
  if (running) return { skipped: 'a scan is running' };
  const out = {};
  const steps = [
    ['metrics', () => C.compactJsonl(P.metrics, { keepDays: metricsDays, now, summarize: C.summarizeMetrics, summaryFile: P.metricsDaily })],
    ['actions', () => C.compactJsonl(P.actions, { keepDays: auditDays, now, summarize: C.summarizeActions, summaryFile: P.actionsDaily, archiveDir: path.dirname(P.actions) + path.sep + 'archive', archivePrefix: 'actions' })],
  ];
  if (deep && deep.prune) steps.push(['deep', () => { deep.prune(now); return { pruned: true }; }]);
  for (const [name, fn] of steps) {
    try { out[name] = fn(); } catch (e) { out[name] = { error: String(e.message || e).slice(0, 200) }; }
  }
  const rolled = (out.metrics && out.metrics.rolled || 0) + (out.actions && out.actions.rolled || 0);
  if (rolled || Object.values(out).some((v) => v && v.error)) {
    const failed = Object.entries(out).filter(([, v]) => v && v.error);
    log({ category: 'system', action: 'maintenance.compact', result: failed.length ? 'failure' : 'success', severity: failed.length ? 'warning' : 'info', reason: `rolled ${out.metrics ? out.metrics.rolled || 0 : 0} metric row(s) and ${out.actions ? out.actions.rolled || 0 : 0} audit row(s) into daily summaries${failed.length ? `; failed: ${failed.map(([k, v]) => `${k}: ${v.error}`).join('; ')}` : ''}` });
  }
  return out;
}

module.exports = { runMaintenance };
