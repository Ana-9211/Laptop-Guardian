'use strict';
/**
 * Findings: turns Guardian's observations (recommendations, file candidates, health sections, scheduled-task drift) into the
 * unified, actionable list shown in the Action Center. Pure and deterministic: no I/O, no AI. Every offered action is an
 * allowlisted catalog template with this finding's exact parameters; AI text is explanation only and never an action.
 */
const { byId, describeAction, validateParams } = require('./remediation');
const protectedTargets = require('./protected');

const DAY_MS = 86400000;
const SIG_OLD_DAYS = 3;
const QUICK_SCAN_OLD_DAYS = 7;
const MAX_FILE_FINDINGS = 40;
const RISK_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2, UNKNOWN: 3 };

const utcStart = (iso) => { const t = Date.parse(iso); return Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 19); };
const splitTask = (full) => { const i = String(full).lastIndexOf('\\'); return { taskPath: full.slice(0, i + 1), taskName: full.slice(i + 1) }; };
const sizeText = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`);

/** One action offer: spec text with these parameters filled in, plus static eligibility. Never executes anything. */
function offer(actionId, params, extra = {}) {
  const spec = byId.get(actionId);
  const clean = {}; for (const [k, v] of Object.entries(params)) { if (v !== undefined && v !== null && v !== '') clean[k] = v; }
  const errs = validateParams(spec, clean);
  const d = describeAction(spec, clean);
  let eligible = errs.length === 0; let ineligibleReason = errs[0] || null;
  if (eligible && extra.protectedReason) { eligible = false; ineligibleReason = extra.protectedReason; }
  return { ...d, eligible, ineligibleReason, ...(extra.label ? { label: extra.label } : {}) };
}

const manual = (label, href, reason) => ({ kind: 'manual', label, href, reason });

function processFinding(rec, ctx) {
  const t = rec.target || {}; const live = (ctx.processes || []).find((p) => p.pid === t.pid && String(p.name).toLowerCase() === String(t.name).toLowerCase()) || null;
  const actions = [];
  const prot = protectedTargets.checkProcess({ name: t.name, pid: t.pid, path: t.path || (live && live.path), guardianRoot: ctx.guardianRoot });
  if (t.pid && t.name) {
    actions.push(offer('process.stop', { pid: t.pid, name: String(t.name).replace(/\.exe$/i, ''), path: t.path || (live && live.path), startTime: live && live.startTime ? utcStart(live.startTime) : undefined }, { protectedReason: prot.protected ? `Protected: ${prot.reason}.` : null }));
  }
  for (const m of (rec.persistence && rec.persistence.mechanisms) || []) {
    if (m.kind === 'registry' || m.kind === 'folder') actions.push(offer('startup.disable', { kind: m.kind, name: m.name, location: m.location }));
    else if (m.kind === 'task' && String(m.name).startsWith('\\')) actions.push(offer('task.disable', splitTask(m.name), { protectedReason: /^\\Microsoft\\/i.test(m.name) ? 'Protected: Windows tasks are never changed by Guardian.' : null }));
    else if (m.kind === 'service') { const sp = protectedTargets.checkService(m.name); actions.push(offer('service.disable', { name: m.name }, { protectedReason: sp.protected ? `Protected: ${sp.reason}.` : null })); }
  }
  const exe = t.path || (live && live.path);
  const app = exe && ctx.apps ? ctx.apps.find((a) => a.installLocation && exe.toLowerCase().startsWith(`${a.installLocation.toLowerCase()}\\`) && !a.systemComponent && !a.isUpdate) : null;
  if (app && ctx.revo && ctx.revo.available) actions.push(offer('app.revo-launch', { appName: app.name }));
  const evidence = [
    t.name && { label: 'Process', value: `${t.name}${t.pid ? ` (PID ${t.pid})` : ''}` },
    exe && { label: 'Path', value: exe },
    prot.suspicious && { label: 'Suspicious', value: prot.reason },
    rec.identity && rec.identity.publisher && { label: 'Publisher', value: `${rec.identity.publisher}${rec.identity.signature ? ` (signature ${rec.identity.signature})` : ''}` },
    rec.persistence && rec.persistence.persistent && { label: 'Restarts via', value: rec.persistence.mechanisms.map((m) => `${m.kind}: ${m.name}`).join('; ') },
    app && { label: 'Installed application', value: app.name },
  ].filter(Boolean);
  return {
    id: `rec:${rec.id}`, source: 'recommendation', recommendationId: rec.id, kind: 'process', title: rec.title, what: rec.whatIsIt || rec.title, why: rec.whyFlagged || [],
    evidence, risk: rec.risk, confidence: rec.confidence, consequences: rec.consequences || null, ai: rec.ai || null,
    actions, manual: actions.length ? null : manual('Review manually', '#/recommendations', 'Guardian has no safe, deterministic fix for this one.'),
    investigate: { label: 'Investigate', href: `#/processes?rec=${rec.id}` },
    attemptKey: { actionIds: ['process.stop', 'startup.disable', 'task.disable', 'service.disable', 'app.revo-launch'], needle: t.name || rec.title },
  };
}

function fileFindings(files, ctx) {
  const out = [];
  const cands = (files && files.candidates) || [];
  for (const c of cands) {
    if (c.ignored || !['REVIEW', 'LIKELY_UNNECESSARY'].includes(c.classification)) continue;
    const prot = protectedTargets.checkPath(c.path, { protectedDirs: ctx.protectedDirs, guardianRoot: ctx.guardianRoot });
    out.push({
      id: `file:${c.id}`, source: 'file', kind: 'file', title: `${c.name} (${sizeText(c.sizeMB)})`, what: c.whatIsIt || 'A file Guardian flagged as probably unnecessary.',
      why: c.whyFlagged || [], risk: c.classification === 'LIKELY_UNNECESSARY' ? 'LOW' : 'MEDIUM', confidence: c.classification === 'LIKELY_UNNECESSARY' ? 0.7 : 0.5,
      evidence: [{ label: 'Path', value: c.path }, { label: 'Size', value: sizeText(c.sizeMB) }, { label: 'Age', value: c.ageDays != null ? `${c.ageDays} days` : 'unknown' }, { label: 'Classification', value: c.classification }].concat(c.ifDeleted ? [{ label: 'If removed', value: c.ifDeleted }] : []),
      consequences: c.ifDeleted || null, ai: null, sizeMB: c.sizeMB,
      actions: [offer('file.recycle', { path: c.path }, { protectedReason: prot.protected ? `Protected path: ${prot.reason}.` : null })], manual: null,
      investigate: { label: 'Investigate', href: '#/files' }, attemptKey: { actionIds: ['file.recycle'], needle: c.path },
    });
  }
  return out.sort((a, b) => b.sizeMB - a.sizeMB).slice(0, MAX_FILE_FINDINGS);
}

function healthFindings(ctx) {
  const out = []; const d = ctx.daily; const sec = (d && d.sections) || {};
  const def = sec.defender; const fw = sec.firewall; const net = sec.network;
  const nowMs = ctx.now;
  const add = (f) => out.push({ source: 'health', kind: 'health', ai: null, manual: null, confidence: 0.9, evidence: [], why: [], consequences: null, ...f });
  if (def && def.available !== false && def.enabled !== false && (def.sigAgeDays ?? 0) > SIG_OLD_DAYS) {
    add({ id: 'health:defender-sigs', title: `Defender signatures are ${Math.round(def.sigAgeDays)} days old`, what: 'Microsoft Defender detects threats using definitions that Windows normally updates by itself.', why: ['Old definitions miss recent threats.'], risk: 'MEDIUM',
      evidence: [{ label: 'Signature version', value: def.sigVersion || 'unknown' }, { label: 'Age', value: `${def.sigAgeDays} days` }], actions: [offer('defender.update-signatures', {})], investigate: { label: 'Investigate', href: '#/health' }, attemptKey: { actionIds: ['defender.update-signatures'], needle: '' } });
  }
  if (def && def.available !== false && def.enabled !== false) {
    const last = def.lastQuickScan ? Date.parse(def.lastQuickScan) : NaN;
    if (Number.isNaN(last) || nowMs - last > QUICK_SCAN_OLD_DAYS * DAY_MS) {
      add({ id: 'health:defender-quick-scan', title: Number.isNaN(last) ? 'Defender has not recorded a quick scan' : 'Defender quick scan is over a week old', what: 'A quick scan checks the places malware usually hides.', why: ['No recent scan is on record.'], risk: 'LOW',
        evidence: [{ label: 'Last quick scan', value: def.lastQuickScan || 'never' }], actions: [offer('defender.quick-scan', {})], investigate: { label: 'Investigate', href: '#/health' }, attemptKey: { actionIds: ['defender.quick-scan'], needle: '' } });
    }
  }
  for (const p of (fw && fw.profiles) || []) {
    if (p.enabled === false && ['Domain', 'Private', 'Public'].includes(p.name)) {
      add({ id: `health:firewall-${p.name}`, title: `Windows Firewall is off for the ${p.name} profile`, what: 'The firewall blocks unsolicited inbound connections.', why: ['A firewall profile that is off leaves this network type unprotected.'], risk: 'HIGH',
        evidence: [{ label: 'Profile', value: p.name }, { label: 'State', value: 'Off' }], actions: [offer('firewall.enable-profile', { profile: p.name })], investigate: { label: 'Investigate', href: '#/health' }, attemptKey: { actionIds: ['firewall.enable-profile'], needle: p.name } });
    }
  }
  const wk = ctx.weekly; const phases = (wk && wk.weekly && wk.weekly.phases) || [];
  const integrityGap = (wk && /integrity|SFC|DISM/i.test(JSON.stringify(wk.incomplete || []))) || phases.some((p) => /integrity/i.test(p.name) && p.status === 'skipped');
  if (integrityGap) {
    add({ id: 'health:integrity', title: 'The Windows integrity check has not completed', what: 'DISM and SFC verify that Windows system files are intact.', why: ['The latest weekly report lists the integrity check as skipped or incomplete.'], risk: 'LOW',
      evidence: [{ label: 'Weekly report', value: (wk && wk.id) || 'none' }], actions: [offer('system.integrity-check', {})], investigate: { label: 'Investigate', href: '#/weekly' }, attemptKey: { actionIds: ['system.integrity-check'], needle: '' } });
  }
  if (net && (net.dnsOk === false || (net.internet === false && net.gatewayOk !== false))) {
    add({ id: 'health:dns', title: 'DNS lookups are failing', what: 'Names such as example.com are not resolving although the network adapter is up.', why: ['The last network check could not resolve a name.'], risk: 'LOW',
      evidence: [{ label: 'DNS servers', value: (net.dnsServers || []).join(', ') || 'none' }, { label: 'Internet reachable', value: String(net.internet) }], actions: [offer('dns.flush', {})], investigate: { label: 'Investigate', href: '#/health' }, attemptKey: { actionIds: ['dns.flush'], needle: '' } });
  }
  return out;
}

function taskFindings(ctx) {
  const need = (ctx.tasks || []).filter((t) => t.repair && t.repair.needed);
  if (!need.length) return [];
  const elevated = need.some((t) => t.repair.requiresElevation);
  const a = offer('schedule.repair', {}, { label: elevated ? 'Repair with administrator permission' : 'Repair schedule' });
  a.admin = elevated ? 'yes' : 'no';
  return [{
    id: 'task:schedule', source: 'task', kind: 'task', title: `${need.length} scheduled task${need.length > 1 ? 's need' : ' needs'} repair`, what: 'Guardian\'s own Daily, Weekly or Dashboard tasks differ from your Settings or run with fewer rights than intended.',
    why: need.flatMap((t) => (t.issues || []).map((i) => `${t.name}: ${i}`)), risk: 'MEDIUM', confidence: 0.95,
    evidence: need.map((t) => ({ label: t.name, value: `${t.summary}${t.runLevel ? ` (${t.runLevel === 'Highest' ? 'administrator' : 'standard'} rights)` : ''}` })), consequences: a.consequences, ai: null,
    actions: [a], manual: null, investigate: { label: 'Investigate', href: '#/settings' }, attemptKey: { actionIds: ['schedule.repair'], needle: '' },
  }];
}

/** Attach previous attempts (from the audit history) to each finding. */
function withAttempts(findings, history) {
  return findings.map((f) => {
    const k = f.attemptKey || { actionIds: [], needle: '' };
    const needle = String(k.needle || '').toLowerCase();
    const attempts = history.filter((h) => k.actionIds.includes(h.actionId) && (!needle || String(h.target || '').toLowerCase().includes(needle))).slice(0, 5);
    const { attemptKey, ...rest } = f; void attemptKey;
    return { ...rest, attempts };
  });
}

function buildFindings(ctx) {
  const all = [
    ...taskFindings(ctx),
    ...healthFindings(ctx),
    ...((ctx.recs || []).filter((r) => r.status === 'open' && r.kind === 'process').map((r) => processFinding(r, ctx))),
    ...fileFindings(ctx.files, ctx),
  ];
  const sorted = all.sort((a, b) => (RISK_RANK[a.risk] ?? 3) - (RISK_RANK[b.risk] ?? 3));
  return withAttempts(sorted, ctx.history || []);
}

module.exports = { buildFindings, offer, utcStart, splitTask };
