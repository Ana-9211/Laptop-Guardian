'use strict';
/** Run a scan now and change the schedule. */
const U = require('../lib/util');
const { HttpError } = require('../lib/http');

module.exports = function registerScheduleRoutes(ctx) {
  const { P, ps, config, log, need, route, currentRun, applySchedule } = ctx;
  // ---- scan / schedule ----
  const launchScan = (kind, args) => {
    const st = currentRun();
    need(!st.running, `a ${st.running?.type} run is already in progress`, 409);
    const r = ps.launch(`${kind}.ps1`, args);
    if (r.missing) throw new HttpError(501, r.error);
    log({ category: 'scan', action: `${kind.toLowerCase()}.start`, result: 'started', reason: 'user requested from dashboard' });
    return { started: true };
  };
  route('POST', '/api/scan/daily', () => launchScan('Daily', []));
  route('POST', '/api/scan/weekly', () => launchScan('Weekly', ['-NoShutdown']));

  route('PUT', '/api/schedule', async ({ body }) => {
    const before = config().schedule;
    const m = U.mergeConfig(config(), { schedule: body });
    need(m.errors.length === 0, m.errors.join('; '));
    const changed = JSON.stringify(m.value.schedule) !== JSON.stringify(before);
    if (!changed) return { saved: true, changed: false, registered: false, needsElevation: false, elevationRequested: false, message: 'Schedule unchanged; Task Scheduler was not touched.', report: [], schedule: m.value.schedule };
    U.writeJsonAtomic(P.config, m.value);
    log({ category: 'config', action: 'schedule.update', reason: JSON.stringify(body).slice(0, 200) });
    return { saved: true, changed: true, ...(await applySchedule()), schedule: m.value.schedule };
  });

  route('POST', '/api/schedule/apply', async ({ body }) => {
    need(body.elevate === undefined || typeof body.elevate === 'boolean', 'elevate must be boolean');
    return applySchedule({ elevate: body.elevate === true });
  });
};
