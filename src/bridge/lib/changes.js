'use strict';
/**
 * "What changed since the last run": the newest daily report compared with the one before it. Pure, so it is tested with two small reports.
 * Only facts both reports contain are compared; a missing field is skipped, never guessed.
 */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function change(label, before, after, { unit = '', digits = 1, goodWhen = null, tolerance = 0 } = {}) {
  const b = num(before); const a = num(after);
  if (b === null || a === null || Math.abs(a - b) <= tolerance) return null;
  const d = a - b;
  const tone = goodWhen === 'up' ? (d > 0 ? 'ok' : 'warn') : goodWhen === 'down' ? (d < 0 ? 'ok' : 'warn') : 'info';
  const r = (v) => Math.round(v * 10 ** digits) / 10 ** digits;
  return { label, from: `${r(b)}${unit}`, to: `${r(a)}${unit}`, delta: `${d > 0 ? '+' : ''}${r(d)}${unit}`, tone };
}

function names(list) { return new Set((list || []).map((p) => String(p.name || '').toLowerCase()).filter(Boolean)); }

function diffReports(cur, prev) {
  if (!cur || !prev) return { available: false, reason: !cur ? 'No daily report exists yet.' : 'Only one daily report exists, so there is nothing to compare with.', items: [] };
  const items = [];
  const push = (x) => { if (x) items.push(x); };
  const s = cur.sections || {}; const p = prev.sections || {};
  push(change('Health score', prev.healthScore, cur.healthScore, { goodWhen: 'up' }));
  push(change('Free disk space (C:)', (p.system && p.system.disks && p.system.disks[0] || {}).freeGB, (s.system && s.system.disks && s.system.disks[0] || {}).freeGB, { unit: ' GB', goodWhen: 'up', tolerance: 0.5 }));
  push(change('RAM in use', p.system && p.system.ram && p.system.ram.usedPct, s.system && s.system.ram && s.system.ram.usedPct, { unit: '%', digits: 0, goodWhen: 'down', tolerance: 3 }));
  push(change('Defender signature age', p.defender && p.defender.sigAgeDays, s.defender && s.defender.sigAgeDays, { unit: ' days', goodWhen: 'down', tolerance: 0.5 }));
  push(change('Startup programs', p.startup && p.startup.count, s.startup && s.startup.count, { digits: 0, goodWhen: 'down' }));
  push(change('Flagged processes', p.processes && p.processes.flagged, s.processes && s.processes.flagged, { digits: 0, goodWhen: 'down' }));
  push(change('Errors recorded', (prev.errors || []).length, (cur.errors || []).length, { digits: 0, goodWhen: 'down' }));
  const dEnabled = (x) => (x && x.defender ? x.defender.enabled : undefined); const dRt = (x) => (x && x.defender ? x.defender.realTimeProtection : undefined);
  if (dEnabled(p) !== undefined && dEnabled(s) !== undefined && dEnabled(p) !== dEnabled(s)) items.push({ label: 'Microsoft Defender', from: dEnabled(p) ? 'on' : 'off', to: dEnabled(s) ? 'on' : 'off', delta: 'changed', tone: dEnabled(s) ? 'ok' : 'crit' });
  if (dRt(p) !== undefined && dRt(s) !== undefined && dRt(p) !== dRt(s)) items.push({ label: 'Real-time protection', from: dRt(p) ? 'on' : 'off', to: dRt(s) ? 'on' : 'off', delta: 'changed', tone: dRt(s) ? 'ok' : 'crit' });
  const fwOff = (x) => ((x && x.firewall && x.firewall.profiles) || []).filter((f) => f.enabled === false).map((f) => f.name).sort().join(', ');
  if (fwOff(p) !== fwOff(s)) items.push({ label: 'Firewall profiles that are off', from: fwOff(p) || 'none', to: fwOff(s) || 'none', delta: 'changed', tone: fwOff(s) ? 'warn' : 'ok' });
  // programs that appear among the heaviest in this report but not the last
  const before = names([...((p.processes && p.processes.topCpu) || []), ...((p.processes && p.processes.topMemory) || [])]);
  const now = [...names([...((s.processes && s.processes.topCpu) || []), ...((s.processes && s.processes.topMemory) || [])])];
  const fresh = now.filter((n) => !before.has(n));
  if (fresh.length) items.push({ label: 'New among the busiest programs', from: '', to: fresh.slice(0, 6).join(', ') + (fresh.length > 6 ? ` and ${fresh.length - 6} more` : ''), delta: `${fresh.length} new`, tone: 'info' });
  return { available: true, from: prev.generatedAt || null, to: cur.generatedAt || null, items };
}

module.exports = { diffReports };
