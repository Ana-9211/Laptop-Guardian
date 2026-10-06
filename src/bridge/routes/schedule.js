'use strict';
/** Run a scan now and change the schedule. */
const U = require('../lib/util');

module.exports = function registerScheduleRoutes(ctx) {
  const { P, config, log, need, route, applySchedule, launchScan } = ctx;
  // ---- scan / schedule ----
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
