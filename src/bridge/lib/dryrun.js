'use strict';
/**
 * "What would happen if Safe Mode were off": a read-only preview built from the latest scan data and the current settings.
 * It never runs anything. It answers three questions: which blacklisted programs would be ended, which cleanup would run and roughly how
 * much, and whether the weekly run could shut the laptop down. Programs and folders that Guardian never touches are listed as such.
 */
const protectedTargets = require('./protected');

const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

function previewSafeModeOff({ config, policy, processes = [], daily = null, guardianRoot }) {
  const doing = []; const notDoing = []; const notes = [];
  const safety = config.safety || {};
  const sec = (daily && daily.sections) || {};

  // 1. blacklisted programs
  const black = ((policy && policy.blacklist) || []).filter((e) => e.enabled !== false && (!e.disabledUntil || Date.parse(e.disabledUntil) < Date.now()));
  const autoKill = !!safety.autoKillBlacklisted;
  for (const e of black) {
    const hits = processes.filter((p) => same(p.name, e.name) && (!e.path || same(p.path, e.path)));
    for (const p of hits) {
      const prot = protectedTargets.checkProcess({ name: p.name, pid: p.pid, path: p.path, guardianRoot });
      if (prot.protected) notDoing.push({ kind: 'process', label: `${p.name} (PID ${p.pid})`, detail: `Protected: ${prot.reason}. It stays running even though it is on your blacklist.` });
      else if (!autoKill) notDoing.push({ kind: 'process', label: `${p.name} (PID ${p.pid})`, detail: 'On your blacklist, but "Automatically terminate blacklisted processes" is off, so it would not be ended.' });
      else doing.push({ kind: 'process', label: `End ${p.name} (PID ${p.pid})`, detail: `Blacklisted${e.reason ? `: ${e.reason}` : ''}. Only the Daily run does this, and only for entries on your blacklist.` });
    }
  }
  if (!black.length) notes.push('Your blacklist is empty, so no program would be ended.');

  // 2. cleanup
  const c = config.cleanup || {}; const st = sec.storage || {};
  const mb = (v) => (typeof v === 'number' ? `${v.toFixed(0)} MB` : 'an unknown amount');
  if (c.tempFiles) doing.push({ kind: 'cleanup', label: 'Delete old temporary files', detail: `About ${mb(st.tempMB)} in your temp folder; only files older than ${c.tempMinAgeDays ?? 7} day(s), never folders or files in use.` }); else notDoing.push({ kind: 'cleanup', label: 'Temporary files', detail: 'Cleanup of temporary files is off in Settings.' });
  if (c.crashDumps) doing.push({ kind: 'cleanup', label: 'Delete crash dumps', detail: `About ${mb(st.crashDumpMB)} of crash dumps and error reports.` }); else notDoing.push({ kind: 'cleanup', label: 'Crash dumps', detail: 'Cleanup of crash dumps is off in Settings.' });
  if (c.caches) doing.push({ kind: 'cleanup', label: 'Delete known safe caches', detail: `About ${mb(st.cacheMB)} of thumbnail and error-report caches (rebuilt automatically).` }); else notDoing.push({ kind: 'cleanup', label: 'Caches', detail: 'Cleanup of caches is off in Settings.' });
  if (c.recycleBin === 'always') doing.push({ kind: 'cleanup', label: 'Empty the Recycle Bin', detail: 'Your Recycle Bin policy is "always empty". Emptied items cannot be restored.' }); else notDoing.push({ kind: 'cleanup', label: 'Recycle Bin', detail: 'Your policy is never to empty it.' });

  // 3. shutdown
  const wk = (config.schedule && config.schedule.weekly) || {};
  if (wk.enabled && wk.shutdownEnabled && safety.weeklyShutdown && !safety.automationPaused) doing.push({ kind: 'shutdown', label: 'Shut the laptop down after the weekly run', detail: `At ${wk.shutdownTime || 'the target time'} on ${wk.day || 'the weekly day'}. This does not depend on Safe Mode; it is listed because it can happen unattended.` });
  else notDoing.push({ kind: 'shutdown', label: 'Weekly shutdown', detail: 'Not armed (switched off, or automation is paused).' });
  if (safety.automationPaused) notes.push('Automation is paused, so none of the above would run until you resume it.');

  notDoing.push({ kind: 'always', label: 'Unknown processes, personal files, Downloads, Windows and security software', detail: 'These are never changed automatically, with or without Safe Mode.' });
  return { safeMode: !!safety.safeMode, wouldDo: doing, wouldNotDo: notDoing, notes, basedOn: { scan: (daily && daily.generatedAt) || null, processes: processes.length } };
}

module.exports = { previewSafeModeOff };
