'use strict';
/** Settings, the shutdown cancel button and the process policy lists. */
const { execFile } = require('child_process');
const path = require('path');
const U = require('../lib/util');
const { LISTS } = require('../lib/constants');
const { HttpError } = require('../lib/http');

module.exports = function registerSettingsRoutes(ctx) {
  const { opts, P, config, policy, log, need, str, aiStatus, route, locked, netStore, deep } = ctx;
  route('GET', '/api/config', () => ({ ...config(), _ai: aiStatus() }));
  // Cancels a pending Windows shutdown. A fixed command with no inputs: the same as typing `shutdown /a`.
  const abortShutdown = opts.abortShutdown || (() => new Promise((resolve) => execFile(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'shutdown.exe'), ['/a'], { windowsHide: true, timeout: 10000 }, (err, out, errText) => resolve({ ok: !err, text: String(errText || out || (err && err.message) || '').trim() }))));
  route('POST', '/api/shutdown/cancel', async () => {
    const r = await abortShutdown();
    log({ category: 'shutdown', action: 'shutdown:cancelled', result: r.ok ? 'success' : 'skipped', actor: 'user', reason: r.ok ? 'Pending shutdown cancelled from the dashboard.' : `Nothing was cancelled: ${r.text || 'no shutdown was pending'}` });
    return { cancelled: r.ok, message: r.ok ? 'The pending shutdown was cancelled.' : 'No shutdown was pending, so nothing needed cancelling.' };
  });

  route('PUT', '/api/config', locked(P.config, ({ body: rawBody }) => {
    const { _confirmRisky, ...body } = rawBody || {};
    const net = body && body.network;
    const cur = config().network || {};
    const flips = (k) => net && net[k] && 'enabled' in net[k] && net[k].enabled !== (cur[k] || {}).enabled;
    need(!(flips('deep') || flips('dnsFiltering')), 'Deep Network Guard and DNS filtering are switched on or off only from Network Guard, with their own confirmation.', 400);
    const before = config();
    const m = U.mergeConfig(before, body);
    need(m.errors.length === 0, m.errors.join('; '));
    const risky = U.riskyChanges(before, m.value);
    if (risky.length && _confirmRisky !== true) {
      log({ category: 'config', action: 'config.risky-refused', target: Object.keys(body).join(','), result: 'skipped', severity: 'warning', reason: `needs confirmation: ${risky.join(' ')}` });
      throw new HttpError(409, 'This change lowers a safety margin and needs your confirmation.', { needsConfirmation: risky });
    }
    U.writeJsonAtomic(P.config, m.value);
    log({ category: 'config', action: risky.length ? 'config.risky-update' : 'config.update', target: Object.keys(body).join(','), reason: risky.length ? `confirmed: ${risky.join(' ')}` : 'settings changed in dashboard', severity: risky.length ? 'warning' : 'info' });
    if (net) { try { deep.prune(); netStore.prune(); } catch { /* retention is applied again on the next write */ } }
    return m.value;
  }));

  route('GET', '/api/policy', () => policy());

  route('POST', '/api/policy', locked(P.policy, ({ body }) => {
    need(LISTS.includes(body.list), `list must be one of ${LISTS.join(', ')}`);
    const name = str(body.name, 'name', 128).replace(/\.exe$/i, '');
    need(/^[^\\/:*?"<>|\0]+$/.test(name), 'invalid process name');
    const p = body.path == null || body.path === '' ? null : str(body.path, 'path', 1000);
    const pol = policy();
    const key = name.toLowerCase();
    const matches = (e) => String(e.name).toLowerCase() === key && (!e.path || !p || e.path.toLowerCase() === p.toLowerCase());
    // A process lives in exactly one of blacklist/whitelist; moving it clears the opposite list.
    if (body.list === 'blacklist') pol.whitelist = pol.whitelist.filter((e) => !matches(e));
    if (body.list === 'whitelist') pol.blacklist = pol.blacklist.filter((e) => !matches(e));
    let entry = pol[body.list].find(matches);
    if (!entry) {
      entry = {
        id: U.uid('p_'), name, path: p, reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : '', addedAt: U.localIso(), addedBy: 'user',
        enabled: true, action: body.list === 'blacklist' ? 'terminate' : 'none', terminatedCount: 0, lastTerminatedAt: null, disabledUntil: null,
      };
      pol[body.list].push(entry);
    }
    U.writeJsonAtomic(P.policy, pol);
    log({ category: 'policy', action: `policy.${body.list}.add`, target: name, reason: entry.reason || null, relatedRecommendation: body.recommendationId || null });
    return entry;
  }));

  route('PATCH', '/api/policy/:list/:id', locked(P.policy, ({ params, body }) => {
    need(LISTS.includes(params.list), 'invalid list');
    const pol = policy();
    const e = pol[params.list].find((x) => x.id === params.id);
    need(e, 'policy entry not found', 404);
    if (body.enabled !== undefined) { need(typeof body.enabled === 'boolean', 'enabled must be boolean'); e.enabled = body.enabled; }
    if (body.disabledUntil !== undefined) {
      need(body.disabledUntil === null || !Number.isNaN(Date.parse(body.disabledUntil)), 'disabledUntil must be date or null');
      e.disabledUntil = body.disabledUntil;
    }
    if (typeof body.reason === 'string') e.reason = body.reason.slice(0, 500);
    U.writeJsonAtomic(P.policy, pol);
    log({ category: 'policy', action: `policy.${params.list}.update`, target: e.name, reason: JSON.stringify(body).slice(0, 200) });
    return e;
  }));

  route('DELETE', '/api/policy/:list/:id', locked(P.policy, ({ params }) => {
    need(LISTS.includes(params.list), 'invalid list');
    const pol = policy();
    const e = pol[params.list].find((x) => x.id === params.id);
    need(e, 'policy entry not found', 404);
    pol[params.list] = pol[params.list].filter((x) => x.id !== params.id);
    U.writeJsonAtomic(P.policy, pol);
    log({ category: 'policy', action: `policy.${params.list}.remove`, target: e.name });
    return { ok: true };
  }));
};
