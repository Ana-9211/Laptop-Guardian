'use strict';
/** Guidance for the dashboard: the first-run checklist, what changed since the last run, and the Safe Mode dry-run preview. Read-only. */
const path = require('path');
const U = require('../lib/util');
const S = require('../lib/status');
const { buildChecklist } = require('../lib/setup');
const { diffReports } = require('../lib/changes');
const { previewSafeModeOff } = require('../lib/dryrun');
const { buildDiagnostics } = require('../lib/diagnostics');
const { VERSION } = require('../lib/constants');

module.exports = function registerGuidanceRoutes(ctx) {
  const { P, config, policy, route, listReports, cachedTasks, aiStatus, tailActions, netStore, guardianRoots, reportDir, root, codeRoot, startedAt, codeMtime, restartNeeded, state, deep, sampler, cachedJson } = ctx;

  route('GET', '/api/setup', () => {
    const c = config();
    const daily = U.readJson(P.latest('daily.json'), null);
    const refused = tailActions(200).some((a) => a.action === 'install:untrusted-refused' && Date.now() - Date.parse(a.ts) < 3 * 86400000);
    return buildChecklist({ tasks: S.assessTasks(cachedTasks(), c), daily, config: c, aiKeyConfigured: aiStatus().keyConfigured, networkSnapshot: netStore.readLatest(), untrustedRefused: refused });
  });

  route('GET', '/api/changes', () => {
    const rows = listReports('daily').slice(0, 2);
    const read = (r) => (r ? U.readJson(path.join(reportDir('daily', r.id), 'report.json'), null) : null);
    return diffReports(read(rows[0]), read(rows[1]));
  });

  // Facts for a bug report. The text is masked (user name, home paths); the structured fields are for the Settings page on this laptop.
  route('GET', '/api/diagnostics', () => {
    let install = null; try { install = U.readInstall(codeRoot); } catch { install = null; }
    const c = config();
    return buildDiagnostics({
      version: VERSION, startedAt, codeMtime: new Date(codeMtime()).toISOString(), restartNeeded: restartNeeded(), port: state.boundPort, install, root, codeRoot,
      runState: U.readJson(P.runState, {}) || {}, daily: cachedJson(P.latest('daily.json')), weekly: cachedJson(P.latest('weekly.json')),
      deep: deep.status(), sampler: sampler ? sampler.status() : null, tasks: S.assessTasks(cachedTasks(), c), config: c,
    });
  });

  route('GET', '/api/safemode/preview', () => {
    const procs = (U.readJson(P.latest('processes.json'), { processes: [] }) || {}).processes || [];
    return previewSafeModeOff({ config: config(), policy: policy(), processes: procs, daily: U.readJson(P.latest('daily.json'), null), guardianRoot: guardianRoots });
  });
};
