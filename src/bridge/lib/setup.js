'use strict';
/**
 * The first-run checklist: what Guardian found missing, each with the typed catalog action that fixes it (or a plain pointer when the step
 * has to happen in Settings). Built from facts the bridge already has. Nothing here runs by itself: every button goes through the normal
 * plan, confirm, verify flow, and the checklist can be hidden.
 */
function buildChecklist({ tasks = [], daily = null, config, aiKeyConfigured = false, networkSnapshot = null, untrustedRefused = false }) {
  const items = [];
  const add = (i) => items.push({ optional: false, action: null, link: null, ...i });
  const need = tasks.filter((t) => t.status === 'missing' || (t.repair && t.repair.needed));

  add({ id: 'tasks', title: 'Scheduled scans are registered', done: tasks.length > 0 && need.length === 0,
    detail: need.length ? `${need.length} Guardian task${need.length > 1 ? 's are' : ' is'} missing or out of date, so the daily and weekly checks will not run by themselves.` : 'The Daily, Weekly and Dashboard tasks match your settings.',
    action: need.length ? (need.some((t) => t.repair && t.repair.requiresElevation) ? { actionId: 'schedule.repair', label: 'Repair the schedule', params: {} } : { actionId: 'setup.register-tasks', label: 'Register the tasks', params: {} }) : null });
  add({ id: 'first-scan', title: 'A first scan has run', done: !!daily, detail: daily ? 'The latest daily report is available.' : 'Without a scan the dashboard has nothing to show yet. A daily scan only observes.',
    action: daily ? null : { actionId: 'scan.run-now', label: 'Run a daily scan now', params: { kind: 'daily' } } });
  add({ id: 'safe-mode', title: 'Safe Mode is on', done: !!(config.safety && config.safety.safeMode), detail: config.safety && config.safety.safeMode ? 'Guardian observes and recommends; nothing is changed automatically.' : 'Safe Mode is off, so cleanup and blacklist termination can run unattended.',
    action: config.safety && config.safety.safeMode ? null : { actionId: 'setup.enable-safe-defaults', label: 'Turn Safe Mode on', params: {} } });
  if (untrustedRefused) add({ id: 'admin-install', title: 'Administrator tasks can run', done: false, detail: 'Daily and Weekly refused to start with administrator rights from this folder. Install Laptop Guardian from an administrator PowerShell window (Install-LaptopGuardian.ps1).', link: '#/logs?q=untrusted' });
  add({ id: 'network-snapshot', title: 'A network snapshot has been taken', done: !!networkSnapshot, optional: true, detail: networkSnapshot ? 'Network Guard has data to show.' : 'Network Guard shows nothing until it reads the connection tables once. It never captures traffic.', link: networkSnapshot ? null : '#/network' });
  add({ id: 'dns-log', title: 'DNS history log (optional)', done: false, optional: true, unknown: true, detail: 'Lets Network Guard show which program asked for which name. It needs administrator permission and records names only. Skip it if you do not want that record.', action: { actionId: 'setup.enable-dns-log', label: 'Turn on the DNS history log', params: {} } });
  add({ id: 'firewall-log', title: 'Firewall connection logging (optional)', done: false, optional: true, unknown: true, detail: 'Windows records which program connected where and what the firewall blocked. Needs administrator permission and uses Security log space.', action: { actionId: 'setup.enable-firewall-audit', label: 'Turn on firewall connection logging', params: {} } });
  add({ id: 'ai', title: 'Gemini analysis (optional)', done: !!(config.ai && config.ai.enabled && aiKeyConfigured), optional: true, detail: aiKeyConfigured ? 'A key is stored.' : 'Everything works without it. Add a key in Settings for plain-language explanations.', link: aiKeyConfigured ? null : '#/settings' });
  const required = items.filter((i) => !i.optional);
  return { items, complete: required.every((i) => i.done), remaining: required.filter((i) => !i.done).length };
}

module.exports = { buildChecklist };
