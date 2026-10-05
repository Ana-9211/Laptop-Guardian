'use strict';
/**
 * Pure helpers for the live-status endpoint: scheduled-task assessment, run-state sanity, pending shutdown
 * and the prioritised "what needs attention" list. No I/O so they are unit-testable.
 */

// Task Scheduler HRESULT / SCHED_S_* codes that people actually meet.
const RESULT_TEXT = {
  0: 'Completed successfully',
  267008: 'Ready to run',                  // 0x41300
  267009: 'Running now',                   // 0x41301
  267010: 'Task is disabled',              // 0x41302
  267011: 'Has not run yet',               // 0x41303 - normal for a newly registered task
  267012: 'No more scheduled runs',        // 0x41304
  267013: 'No valid triggers',             // 0x41305
  267014: 'Stopped before it finished',    // 0x41306
  2147750687: 'Already running (second instance ignored)', // 0x8004131F
  2147942402: 'File not found (script path missing?)',     // 0x80070002
  2147942667: 'Working directory invalid',                 // 0x8007010B
  2147946720: 'Logon failed / user not logged on',         // 0x800710E0
};
const toUnsigned = (n) => (typeof n === 'number' ? n >>> 0 : null);
const hex = (n) => (n == null ? null : '0x' + n.toString(16).toUpperCase());

function describeResult(code) {
  const u = toUnsigned(code);
  if (u == null) return { code: null, hex: null, text: 'Unknown', kind: 'unknown' };
  const text = RESULT_TEXT[u] || (u === 1 ? 'Failed (generic error 1)' : `Failed (${hex(u)})`);
  const kind = u === 0 ? 'success' : u === 267011 ? 'never-run' : u === 267009 ? 'running' : u === 267008 ? 'ready' : u === 267014 ? 'stopped' : 'failed';
  return { code: u, hex: hex(u), text, kind };
}

const hhmm = (iso) => { const m = /T(\d\d):(\d\d)/.exec(String(iso || '')); return m ? `${m[1]}:${m[2]}` : null; };

/**
 * Turn raw Scheduler.ps1 rows plus config into readable, level-tagged rows.
 * level: ok | info | warn | crit. "never run" for a freshly registered task is info, not a problem.
 */
function assessTasks(tasks, config) {
  const sched = config.schedule;
  const want = { daily: sched.daily.enabled, weekly: sched.weekly.enabled, dashboard: true };
  return (tasks || []).map((t) => {
    const res = describeResult(t.lastResult);
    const base = {
      kind: t.kind, name: t.name, state: t.state, nextRun: t.nextRun || null, lastRun: t.lastRun || null, runLevel: t.runLevel || null,
      lastResult: res, trigger: t.trigger || null,
    };
    const issues = [];
    let status; let level; let summary;
    if (t.state === 'NotRegistered') {
      if (!want[t.kind]) { status = 'off'; level = 'info'; summary = 'Turned off in Settings'; }
      else if (t.kind === 'dashboard') { status = 'missing'; level = 'info'; summary = 'Not registered - the dashboard will not auto-start at logon'; }
      else { status = 'missing'; level = 'warn'; summary = 'Not registered - this maintenance will not run'; }
    } else if (t.state === 'Disabled') {
      status = 'disabled'; level = want[t.kind] ? 'warn' : 'info'; summary = 'Registered but disabled in Task Scheduler';
    } else if (t.state === 'Running' || res.kind === 'running') {
      status = 'running'; level = 'ok'; summary = 'Running now';
    } else if (res.kind === 'never-run') {
      status = 'never-run'; level = 'info'; summary = t.nextRun ? 'Registered - waiting for its first run' : 'Registered - has not run yet';
    } else if (res.kind === 'success' || res.kind === 'ready') {
      status = 'ok'; level = 'ok'; summary = 'Last run succeeded';
    } else {
      status = 'failed'; level = res.kind === 'stopped' ? 'warn' : 'crit'; summary = `Last run: ${res.text}`;
    }
    // `drift` = the registered task no longer matches Settings or this installation and needs re-registering.
    // `upgrade` = a Daily/Weekly task that runs without administrator rights (fixable only by an elevated registration).
    let drift = false; let upgrade = false;
    const maintenance = t.kind === 'daily' || t.kind === 'weekly';
    if (t.state !== 'NotRegistered') {
      if (maintenance && !want[t.kind]) issues.push('Registered but the schedule is turned off in Settings');
      const cfgTime = t.kind === 'daily' ? sched.daily.time : t.kind === 'weekly' ? sched.weekly.time : null;
      const got = hhmm(t.trigger);
      if (cfgTime && got && got !== cfgTime) { drift = true; issues.push(`Task trigger is ${got} but Settings say ${cfgTime}; apply the schedule to re-register`); }
      if (t.kind === 'weekly' && Array.isArray(t.days) && t.days.length && !t.days.includes(sched.weekly.day)) { drift = true; issues.push(`Task runs on ${t.days.join(', ')} but Settings say ${sched.weekly.day}`); }
      if (maintenance && t.scheduledFlag === false) {
        drift = true;
        issues.push(t.kind === 'weekly'
          ? 'Weekly task was registered without -Scheduled, so it will never schedule the shutdown; re-register it'
          : 'Daily task was registered without -Scheduled, so its runs are recorded as manual; re-register it');
      }
      if (t.scriptCurrent === false) { drift = true; issues.push('Task points at a different Guardian installation or a missing script; re-register it'); }
      if (maintenance && t.runLevel && t.runLevel !== 'Highest') { upgrade = true; issues.push('Runs without administrator rights: SFC, DISM and the filesystem scan are skipped'); }
      if (issues.length && level === 'ok') level = 'info';
      if (drift && level !== 'crit') level = 'warn';
    }
    // Re-registering an elevated task (or raising a standard one) needs a UAC prompt; a standard process must never replace it.
    const repair = {
      needed: drift || upgrade || (status === 'missing' && want[t.kind]),
      requiresElevation: (drift && t.runLevel === 'Highest') || upgrade,
    };
    return { ...base, status, level, summary, issues, repair };
  });
}

/** A run-state "running" marker whose process is gone (crash, reboot, kill) is stale and must not look like a live scan. */
function sanitizeRun(run, isAlive, now = Date.now()) {
  const r = run && typeof run === 'object' ? { ...run } : {};
  const cur = r.running;
  if (!cur) return { ...r, running: null, stale: null };
  const started = Date.parse(cur.startedAt);
  const age = Number.isNaN(started) ? null : Math.max(0, Math.round((now - started) / 1000));
  const alive = typeof cur.pid === 'number' ? isAlive(cur.pid) : age != null && age < 6 * 3600; // old markers without pid: fall back to age
  if (!alive) return { ...r, running: null, stale: { ...cur, elapsedSec: age } };
  return { ...r, running: { ...cur, elapsedSec: age }, stale: null };
}

/** Pending shutdown: last shutdown:initiated that is still in the future and not followed by an abort/skip. */
function pendingShutdown(actions, now = Date.now()) {
  const rel = (actions || []).filter((a) => /^shutdown:/.test(a.action || ''));
  for (let i = rel.length - 1; i >= 0; i--) {
    const a = rel[i];
    if (a.action !== 'shutdown:initiated' || a.result !== 'success') continue;
    const m = /in (\d+) s/.exec(a.reason || '');
    const at = Date.parse(a.ts) + (m ? Number(m[1]) * 1000 : 0);
    if (at > now) return { at: new Date(at).toISOString(), initiatedAt: a.ts, cancelCommand: 'shutdown /a' };
    return null;
  }
  return null;
}

const LEVEL_RANK = { crit: 0, warn: 1, info: 2 };

/** Prioritised list: safety first (security), then data-at-risk, then maintenance health, then housekeeping. */
function buildAttention({ daily, tasks, run, openRecs, highRiskRecs, config, now = Date.now(), bridgeOk = true, stale }) {
  const out = [];
  const add = (level, id, title, detail, href, cta) => out.push({ id, level, title, detail, href: href || null, cta: cta || null });
  const sec = daily?.sections || {};
  const def = sec.defender; const fw = sec.firewall;
  if (def) {
    if (def.enabled === false) add('crit', 'defender-off', 'Microsoft Defender is off', 'Real-time malware protection is not active.', '#/health', 'Open Health');
    else if (def.realTimeProtection === false) add('crit', 'defender-rt', 'Defender real-time protection is off', 'Files are not being scanned as they are opened.', '#/health', 'Open Health');
    if ((def.threats || 0) > 0) {
      // Defender threat history keeps quarantined/removed items; only unresolved ones are urgent.
      // ThreatStatusID: 2 cleaned, 3 quarantined, 4 removed, 102/103/104 blocked/cleaned/removed.
      const HANDLED = new Set(['2', '3', '4', '102', '103', '104', 'cleaned', 'quarantined', 'removed']);
      const list = Array.isArray(def.scan?.threats) ? def.scan.threats : null;
      const active = list ? list.filter((t) => !HANDLED.has(String(t.status).toLowerCase())).length : def.threats;
      if (active > 0) add('crit', 'defender-threats', `${active} unresolved Defender threat${active > 1 ? 's' : ''}`, 'Open Windows Security > Protection history to review and remove them.', '#/health', 'Open Health');
      else add('info', 'defender-history', `${def.threats} past Defender detection${def.threats > 1 ? 's' : ''} already handled`, 'They were quarantined or removed. Check Windows Security > Protection history if you want details.', '#/health', 'Open Health');
    }
    if ((def.sigAgeDays ?? 0) > 3) add('warn', 'defender-sigs', `Defender signatures are ${def.sigAgeDays} days old`, 'Updates may be failing; check Windows Update and connectivity. Guardian can run the Defender update after you confirm.', '#/actions?finding=health:defender-sigs', 'Fix options');
  }
  const fwOff = fw?.profiles?.find((p) => p.enabled === false);
  if (fwOff) add('warn', 'firewall', 'A firewall profile is disabled', 'Guardian can turn a profile back ON after you confirm; it never turns the firewall off.', `#/actions?finding=health:firewall-${fwOff.name}`, 'Fix options');
  const disk = sec.system?.disks?.[0];
  if (disk && disk.freePct != null) {
    const crit = config.thresholds.diskFreeCritPct; const warn = config.thresholds.diskFreeWarnPct;
    if (disk.freePct < crit) add('crit', 'disk-crit', `Only ${Math.round(disk.freePct)}% disk space free`, 'Windows and updates may fail soon. Review large files.', '#/files', 'Review files');
    else if (disk.freePct < warn) add('warn', 'disk-low', `Disk is ${Math.round(100 - disk.freePct)}% full`, 'Free space is below your threshold.', '#/files', 'Review files');
  }
  if (highRiskRecs > 0) add('warn', 'recs-high', `${highRiskRecs} high-risk recommendation${highRiskRecs > 1 ? 's' : ''} open`, 'Review the evidence before deciding. Nothing is changed automatically.', '#/recommendations', 'Review');
  if (!bridgeOk) add('crit', 'bridge', 'Dashboard bridge is unreachable', 'Data on screen may be out of date.', null, null);
  for (const t of tasks || []) {
    if (t.level === 'crit' || t.level === 'warn') add(t.level, `task-${t.kind}`, `${t.name}: ${t.summary}`, t.issues[0] || (t.lastResult?.hex ? `Result ${t.lastResult.hex}` : ''), t.repair?.needed ? '#/actions?finding=task:schedule' : '#/settings', t.repair?.needed ? 'Fix options' : 'Open Settings');
  }
  if (stale) add('warn', 'stale-run', `A previous ${stale.type} run never finished`, 'The machine probably shut down or the run crashed. The next run recovers automatically.', '#/logs', 'Open logs');
  if (!daily) add('info', 'no-scan', 'No scan has completed yet', 'Run a daily scan from the Overview page, or wait for the scheduled run.', '#/overview', null);
  else {
    const age = now - Date.parse(daily.generatedAt);
    if (!Number.isNaN(age) && age > 36 * 3600 * 1000 && !run?.running) add('warn', 'scan-old', 'The last daily scan is over 36 hours old', 'Check that the Daily Audit task is registered and the laptop is logged in around its run time.', '#/settings', 'Open Settings');
    if (daily.status && daily.status !== 'complete') add('info', 'scan-partial', 'The last scan finished with gaps', (daily.incomplete || []).slice(0, 2).join('; ') || 'Some checks were skipped or timed out.', '#/daily', 'Open report');
  }
  if (openRecs > 0 && !highRiskRecs) add('info', 'recs-open', `${openRecs} open recommendation${openRecs > 1 ? 's' : ''}`, 'Process and file suggestions are waiting for your review.', '#/recommendations', 'Review');
  if (!config.safety.safeMode) add('info', 'safe-off', 'Safe Mode is off', 'Blacklisted processes and allowlisted temp cleanup can run automatically.', '#/settings', 'Open Settings');
  if (config.safety.automationPaused) add('info', 'paused', 'Automation is paused', 'Scans still observe; automatic actions and the weekly shutdown are suspended.', '#/settings', 'Open Settings');
  return out.map((x, i) => ({ ...x, _i: i })).sort((a, b) => (LEVEL_RANK[a.level] - LEVEL_RANK[b.level]) || (a._i - b._i)).map(({ _i, ...x }) => x);
}

module.exports = { describeResult, assessTasks, sanitizeRun, pendingShutdown, buildAttention, hhmm };
