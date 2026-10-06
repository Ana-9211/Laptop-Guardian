'use strict';
/**
 * Diagnostics for bug reports after a real install. buildDiagnostics gathers facts the bridge already has; maskText removes the user name and
 * home paths so the "Copy diagnostics" text can be pasted into a report. Nothing here reads secrets, the config contents, process lists or logs.
 */
const os = require('os');

/** Replaces the account name and anything under the user's profile or the data/program folders with placeholders. Pure. */
function maskText(text, { userName, userProfile, dataRoot, codeRoot, computerName } = {}) {
  let s = String(text);
  const esc = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const swap = (v, to) => { if (v && String(v).length >= 3) s = s.replace(new RegExp(esc(v), 'gi'), to); };
  // longest and most specific first, so a data folder inside the profile is named as the data folder
  swap(dataRoot, '<data folder>'); swap(codeRoot, '<program folder>'); swap(userProfile, '%USERPROFILE%');
  s = s.replace(/([A-Za-z]:\\Users\\)[^\\\s"']+/gi, '$1<user>');
  swap(userName, '<user>'); swap(computerName, '<computer>');
  return s;
}

function buildDiagnostics({ version, startedAt, codeMtime, restartNeeded, port, install, root, codeRoot, runState = {}, daily = null, weekly = null, deep = {}, sampler = null, tasks = [], config = {}, env = process.env }) {
  const res = (x) => (x ? { startedAt: x.startedAt || null, finishedAt: x.finishedAt || null, status: x.status || null } : null);
  const d = {
    bridge: { version, startedAt, codeMtime, restartNeeded: !!restartNeeded, port, node: process.version, platform: `${os.platform()} ${os.release()}`, uptimeSec: Math.round(process.uptime()) },
    install: { mode: install ? 'installed' : 'checkout', dataFolder: root, programFolder: codeRoot, administratorsFolder: install ? install.elevatedDir : null },
    lastRuns: { daily: res(runState.lastDaily), weekly: res(runState.lastWeekly), dailyReport: daily ? { id: daily.id, status: daily.status, healthScore: daily.healthScore } : null, weeklyReport: weekly ? { id: weekly.id, status: weekly.status, healthScore: weekly.healthScore } : null },
    sampler: { deepNetworkGuardOn: !!deep.active, source: deep.source || null, running: !!(sampler && sampler.running), alive: !!(sampler && sampler.alive), gaveUp: !!(sampler && sampler.gaveUp), restarts: sampler ? sampler.restarts : 0 },
    tasks: tasks.map((t) => ({ kind: t.kind, state: t.state, runLevel: t.runLevel || null, status: t.status || null })),
    safety: { safeMode: !!(config.safety && config.safety.safeMode), automationPaused: !!(config.safety && config.safety.automationPaused) },
  };
  const lines = [
    `Laptop Guardian ${version} (${d.install.mode})`,
    `Bridge: port ${port}, started ${startedAt}, code ${codeMtime}${restartNeeded ? ', RESTART NEEDED' : ''}, node ${process.version}, ${d.bridge.platform}`,
    `Data folder: ${root}`, `Program folder: ${codeRoot}`, ...(install ? [`Administrators folder: ${install.elevatedDir}`] : []),
    `Last daily: ${d.lastRuns.daily ? `${d.lastRuns.daily.status || '?'} finished ${d.lastRuns.daily.finishedAt || '?'}` : 'none'}`,
    `Last weekly: ${d.lastRuns.weekly ? `${d.lastRuns.weekly.status || '?'} finished ${d.lastRuns.weekly.finishedAt || '?'}` : 'none'}`,
    `Sampler: deep mode ${d.sampler.deepNetworkGuardOn ? 'on' : 'off'}, source ${d.sampler.source || 'none'}, running ${d.sampler.running}, alive ${d.sampler.alive}, gave up ${d.sampler.gaveUp}, restarts ${d.sampler.restarts}`,
    `Tasks: ${d.tasks.map((t) => `${t.kind}=${t.state}/${t.runLevel || '?'}`).join(', ') || 'none'}`,
    `Safe Mode: ${d.safety.safeMode ? 'on' : 'off'}${d.safety.automationPaused ? ', automation paused' : ''}`,
  ];
  const maskOpts = { userName: env.USERNAME, userProfile: env.USERPROFILE, dataRoot: root, codeRoot: root === codeRoot ? null : codeRoot, computerName: env.COMPUTERNAME };
  return { ...d, text: maskText(lines.join('\n'), maskOpts), masked: true };
}

module.exports = { buildDiagnostics, maskText };
