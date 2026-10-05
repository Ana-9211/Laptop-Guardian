'use strict';
/**
 * Remediation: plan, confirm, execute, verify. The bridge never builds a command. It picks an allowlisted action from
 * src/shared/action-catalog.json, validates the parameters, asks PowerShell to re-validate the LIVE target (Validate mode),
 * shows the user the exact effect, and only after an explicit confirmation of that exact plan asks PowerShell to execute
 * it (Execute mode re-validates again, refuses protected targets and verifies the result).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const protectedTargets = require('./protected');
const netguard = require('./netguard');

const CATALOG = require('../../shared/action-catalog.json');
const PLAN_TTL_MS = 10 * 60 * 1000;
const UAC_PROMPT_WAIT_MS = 2 * 60 * 1000;     // how long we wait for the user to answer the Windows permission prompt
const RUNNING_STALE_MS = 45 * 60 * 1000;      // an elevated run with no result after this long is reported as lost
const ACTION_SCRIPT = 'Actions/Invoke-GuardianAction.ps1';
const ELEVATE_SCRIPT = 'Actions/Request-ElevatedAction.ps1';
const TICKET_RE = /^[0-9a-f]{32}$/;
const MAX_HISTORY = 500;
const REQUIRED_ACKS = {
  'process.stop': ['unsaved-work'], 'app.revo-launch': ['unsaved-work'], 'service.disable': ['dependent-programs'],
  'firewall.block-program': ['connectivity'], 'firewall.block-port': ['connectivity'], 'firewall.block-remote': ['connectivity'], 'dns.block-domain': ['dns-limits'],
};

const byId = new Map(CATALOG.actions.map((a) => [a.id, a]));
const regex = (name) => new RegExp(CATALOG.patterns[name]);

class RemediationError extends Error { constructor(status, message) { super(message); this.status = status; } }

/** Same rules as PowerShell's Test-ActionParams: declared keys only, required present, pattern or enum respected. */
function validateParams(spec, params) {
  const errs = [];
  const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
  const declared = Object.keys(spec.params || {});
  for (const k of Object.keys(p)) { if (!k.startsWith('_') && !declared.includes(k)) errs.push(`Unexpected parameter '${k}'`); }
  for (const d of declared) {
    const def = spec.params[d];
    const has = p[d] !== undefined && p[d] !== null && String(p[d]) !== '';
    if (!has) { if (!def.optional) errs.push(`Missing parameter '${d}'`); continue; }
    const v = String(p[d]);
    if (def.enum) { if (!def.enum.includes(v)) errs.push(`Parameter '${d}' must be one of: ${def.enum.join(', ')}`); }
    else if (def.pattern && !regex(def.pattern).test(v)) errs.push(`Parameter '${d}' has an invalid format`);
  }
  return errs;
}

const fill = (tpl, params) => String(tpl).replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? String(params[k]) : `{${k}}`));
const cleanParams = (spec, params) => { const out = {}; for (const k of Object.keys(spec.params || {})) { if (params[k] !== undefined && params[k] !== null && String(params[k]) !== '') out[k] = params[k]; } return out; };
const toB64 = (obj) => Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
const adminTri = (spec) => (spec.admin === true ? 'yes' : spec.admin === false ? 'no' : 'maybe');

/** Public, UI-safe description of one action with this exact target filled in. */
function describeAction(spec, params) {
  return {
    actionId: spec.id, label: spec.label, category: spec.category, risk: spec.risk, reversible: !!spec.reversible, long: !!spec.long,
    admin: adminTri(spec), summary: fill(spec.summary, params), consequences: spec.consequences, undo: spec.undo, params,
    requiredAcks: REQUIRED_ACKS[spec.id] || [],
  };
}

function createRemediation(deps) {
  const { root, ps, log, tailJsonl, readJson, config, applySchedule } = deps;
  const now = deps.now || Date.now;
  const resultsDir = path.join(root, 'data', 'state', 'action-results');
  const plans = new Map();     // token -> plan
  const pending = new Map();   // ticket -> { plan, requestedAt }

  const guardianRoot = () => root;
  const protectedDirs = () => { try { return config().storage.protectedDirs || []; } catch { return []; } };
  const sweep = () => { for (const [t, p] of plans) { if (p.expires < now() || p.used) plans.delete(t); } };

  /** Defence in depth: refuse obviously protected targets in Node before PowerShell is even asked. */
  function staticRefusal(spec, params) {
    if (spec.id === 'process.stop') {
      const c = protectedTargets.checkProcess({ name: params.name, pid: Number(params.pid), path: params.path, guardianRoot: guardianRoot() });
      if (c.protected) return `Protected: ${c.reason}. Guardian will never stop this process, even with confirmation.`;
    }
    if (spec.id === 'service.disable' || spec.id === 'service.enable') {
      const c = protectedTargets.checkService(params.name);
      if (c.protected) return `Protected: ${c.reason}. Guardian will never change it.`;
    }
    if (spec.id === 'file.recycle') {
      const c = protectedTargets.checkPath(params.path, { protectedDirs: protectedDirs(), guardianRoot: guardianRoot() });
      if (c.protected) return `Protected path: ${c.reason}.`;
    }
    if ((spec.id === 'task.disable' || spec.id === 'task.enable') && /^\\(Microsoft|LaptopGuardian)(\\|$)/i.test(params.taskPath)) return 'Protected: Windows and Laptop Guardian scheduled tasks are never changed by Guardian.';
    const net = netguard.staticRefusal(spec.id, params, { ...(deps.netCtx ? deps.netCtx() : {}), guardianRoot: guardianRoot() });
    if (net) return net;
    return null;
  }

  async function runPs(args, timeoutMs = 120000) {
    const r = await ps.run(ACTION_SCRIPT, args, { timeoutMs });
    if (r.missing) throw new RemediationError(501, r.error);
    if (!r.ok) throw new RemediationError(500, r.error || 'the action script failed');
    return r.data || {};
  }

  function refuse(spec, params, errors, status = 422) {
    log({ category: 'remediation', action: 'remediation.refused', target: spec ? `${spec.id}: ${JSON.stringify(params).slice(0, 200)}` : String(params), result: 'skipped', severity: 'warning', reason: errors[0] });
    const e = new RemediationError(status, errors[0]); e.errors = errors; return e;
  }

  /** Step 1: re-validate the live target and return the exact plan the user is asked to confirm. */
  async function plan(actionId, rawParams = {}) {
    sweep();
    const spec = byId.get(actionId);
    if (!spec) throw refuse(null, actionId, [`'${actionId}' is not an allowlisted Guardian action.`], 400);
    const perr = validateParams(spec, rawParams);
    if (perr.length) throw refuse(spec, rawParams, perr, 400);
    const params = cleanParams(spec, rawParams);
    const sref = staticRefusal(spec, params);
    if (sref) throw refuse(spec, params, [sref], 403);

    let adminRequired = spec.admin === true; let identityKey = ''; let details = null; let liveWarnings = [];
    if (spec.handler === 'bridge') {
      if (spec.id === 'schedule.repair') {
        const tasks = deps.assessedTasks ? deps.assessedTasks() : [];
        const need = tasks.filter((t) => t.repair && t.repair.needed);
        if (!need.length) throw refuse(spec, params, ['Every scheduled task already matches Settings; nothing to repair.'], 409);
        adminRequired = need.some((t) => t.repair.requiresElevation);
        details = { tasks: need.map((t) => ({ name: t.name, issues: t.issues })) };
      }
    } else {
      const d = await runPs(['-Action', actionId, '-Mode', 'Validate', '-ParamsB64', toB64(params)]);
      if (!d.ok && !d.needsElevation) throw refuse(spec, params, (d.errors && d.errors.length ? d.errors : ['The live check refused this action.']), 422);
      if (d.needsAdmin || d.needsElevation) adminRequired = true;
      identityKey = d.identityKey || ''; details = d.details || null;
      liveWarnings = Array.isArray(d.warnings) ? d.warnings.map(String) : [];
    }
    const token = crypto.randomBytes(16).toString('hex');
    const record = { token, actionId, params, identityKey, adminRequired, details, expires: now() + PLAN_TTL_MS, used: false, createdAt: now() };
    plans.set(token, record);
    const base = describeAction(spec, params);
    if (spec.id === 'schedule.repair') base.summary = `Re-registers Guardian's Daily, Weekly and Dashboard scheduled tasks from your Settings${adminRequired ? ' with administrator permission (Windows will ask)' : ''}. It never downgrades an elevated task.`;
    return {
      ...base, token, ok: true, admin: adminRequired ? 'yes' : 'no', adminRequired, identityKey, details, warnings: liveWarnings,
      expiresAt: new Date(record.expires).toISOString(), confirmLabel: adminRequired ? 'Continue to Windows prompt' : base.label,
    };
  }

  /** The user closed the confirmation without acting. Logged so the audit trail shows the decision. */
  function cancel(token) {
    const p = plans.get(token);
    if (!p) return { ok: true };
    plans.delete(token);
    log({ category: 'remediation', action: 'remediation.cancelled', target: `${p.actionId}: ${JSON.stringify(p.params).slice(0, 200)}`, result: 'skipped', reason: 'user cancelled at the confirmation step' });
    return { ok: true };
  }

  /** Step 2: execute exactly the plan the user confirmed. Single use. */
  async function execute(token, { confirm, acknowledged = [] } = {}) {
    sweep();
    if (confirm !== true) throw new RemediationError(400, 'confirm:true is required');
    if (typeof token !== 'string' || !TICKET_RE.test(token)) throw new RemediationError(400, 'invalid plan token');
    const p = plans.get(token);
    if (!p) throw new RemediationError(410, 'This confirmation expired or was already used. Open the action again.');
    const spec = byId.get(p.actionId);
    const need = REQUIRED_ACKS[p.actionId] || [];
    const missing = need.filter((a) => !Array.isArray(acknowledged) || !acknowledged.includes(a));
    if (missing.length) throw new RemediationError(400, `You must acknowledge: ${missing.join(', ')}`);
    p.used = true; plans.delete(token);

    if (spec.handler === 'bridge') return runBridgeAction(spec, p);

    const params = { ...p.params, ...(p.identityKey ? { _identityKey: p.identityKey } : {}) };
    if (p.adminRequired) {
      const ticket = crypto.randomBytes(16).toString('hex');
      const r = await ps.run(ELEVATE_SCRIPT, ['-Action', p.actionId, '-ParamsB64', toB64(params), '-Ticket', ticket], { timeoutMs: UAC_PROMPT_WAIT_MS + 10000 });
      if (r.missing) throw new RemediationError(501, r.error);
      const d = r.data || {};
      if (!r.ok || !d.requested) {
        log({ category: 'remediation', action: `remediation:${p.actionId}`, target: JSON.stringify(p.params).slice(0, 200), result: 'skipped', reason: d.message || 'administrator permission was not granted' });
        return { status: 'declined', message: d.message || 'Administrator permission was not granted, so nothing was changed.', actionId: p.actionId };
      }
      pending.set(ticket, { plan: p, requestedAt: now() });
      return { status: 'awaiting-permission', ticket, message: d.message, actionId: p.actionId, long: !!spec.long };
    }
    const d = await runPs(['-Action', p.actionId, '-Mode', 'Execute', '-ParamsB64', toB64(params)], 180000);
    if (!d.ok && d.needsElevation) {
      // Not elevated, but Windows says this needs it: offer a fresh plan that goes through the permission prompt; never retry silently.
      const again = await plan(p.actionId, p.params).catch(() => null);
      if (again) { again.adminRequired = true; again.admin = 'yes'; again.confirmLabel = 'Continue to Windows prompt'; plans.get(again.token).adminRequired = true; }
      return { status: 'needs-elevation', message: (d.errors && d.errors[0]) || 'This needs administrator permission.', plan: again, actionId: p.actionId };
    }
    return { status: d.ok ? (d.verified ? 'done' : 'done-unverified') : 'failed', result: d, actionId: p.actionId };
  }

  async function runBridgeAction(spec, p) {
    if (spec.id === 'schedule.repair') {
      const r = await applySchedule({ elevate: p.adminRequired });
      const ok = !!(r.registered || r.elevationRequested);
      log({ category: 'remediation', action: 'remediation:schedule.repair', target: 'LaptopGuardian tasks', result: ok ? 'success' : 'failure', severity: ok ? 'info' : 'warning', reason: r.message || null, actor: 'user', data: { verified: false, elevated: p.adminRequired, report: r.report } });
      if (r.elevationRequested) return { status: 'awaiting-schedule-permission', message: r.message, actionId: spec.id };
      return { status: r.registered && !r.needsElevation ? 'done' : 'failed', result: { ok, message: r.message, verified: false, details: { report: r.report } }, actionId: spec.id };
    }
    throw new RemediationError(500, 'No handler for this action.');
  }

  /** Poll an elevated run. Reads only the fixed result file for a validated ticket. */
  function result(ticket) {
    if (!TICKET_RE.test(ticket || '')) throw new RemediationError(400, 'invalid ticket');
    const file = path.join(resultsDir, `${ticket}.json`);
    const running = path.join(resultsDir, `${ticket}.running.json`);
    const pend = pending.get(ticket);
    const r = readJson(file, null);
    if (r) { pending.delete(ticket); return { status: r.ok ? (r.verified ? 'done' : 'done-unverified') : 'failed', result: r, actionId: r.action }; }
    const startedAt = (() => { try { return fs.statSync(running).mtimeMs; } catch { return null; } })();
    if (startedAt) { if (now() - startedAt > RUNNING_STALE_MS) return { status: 'lost', message: 'The elevated run never reported back. Check the log.' }; return { status: 'running', startedAt: new Date(startedAt).toISOString(), actionId: pend && pend.plan.actionId }; }
    const asked = pend ? pend.requestedAt : null;
    if (asked && now() - asked < UAC_PROMPT_WAIT_MS) return { status: 'awaiting-permission', actionId: pend.plan.actionId };
    return { status: 'declined', message: 'The Windows permission prompt was not approved in time, so nothing was changed.', actionId: pend && pend.plan.actionId };
  }

  /** History from the append-only action log (newest first). */
  function history(limit = 100) {
    const rows = tailJsonl().filter((e) => e.category === 'remediation' || e.action === 'process.kill' || e.action === 'file.recycle').reverse().slice(0, MAX_HISTORY);
    const out = rows.map((e) => {
      const d = e.data || {};
      const id = String(e.action).replace(/^remediation[:.]/, '');
      const spec = byId.get(id);
      return { id: e.id, ts: e.ts, actionId: id, label: spec ? spec.label : id, category: spec ? spec.category : e.category, target: e.target || null, result: e.result, severity: e.severity, message: e.reason || e.error || null, error: e.error || null, verified: !!d.verified, elevated: !!d.elevated, undo: d.undo || null, subject: d.subject || null, details: d.details || null };
    });
    // an undo is "used" once a newer successful event ran the undo action on the same target
    // Matched on the canonical subject recorded with each event (an undo's own params differ from the original's).
    for (const e of out) { e.canUndo = !!(e.undo && e.result === 'success' && !out.some((n) => n.ts > e.ts && n.result === 'success' && n.actionId === e.undo.action && n.subject && e.subject && n.subject === e.subject)); }
    return out.slice(0, limit);
  }

  async function undo(eventId) {
    const e = history(MAX_HISTORY).find((x) => x.id === eventId);
    if (!e) throw new RemediationError(404, 'history entry not found');
    if (!e.canUndo || !e.undo) throw new RemediationError(409, 'This action cannot be undone from here (or it was already undone).');
    return plan(e.undo.action, e.undo.params || {});
  }

  return { plan, cancel, execute, result, history, undo, describeAction, catalog: () => CATALOG.actions.map((s) => ({ id: s.id, label: s.label, category: s.category, risk: s.risk, admin: adminTri(s), reversible: !!s.reversible })), _plans: plans, _pending: pending };
}

module.exports = { createRemediation, validateParams, describeAction, fill, CATALOG, byId, RemediationError, REQUIRED_ACKS, adminTri };
