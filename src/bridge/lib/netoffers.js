'use strict';
/**
 * Turns network findings into Action Center findings by attaching ONLY allowlisted catalog actions. A finding never blocks
 * anything on its own: every offer below needs the user's explicit confirmation of the exact plan. Temporary variants carry
 * an expiry that is recorded on the firewall rule so it shows up for review.
 */
const { offer } = require('./findings');
const protectedTargets = require('./protected');
const netguard = require('./netguard');

const TEMP = '24h';

function offersFor(f, ctx) {
  const actions = [];
  const identity = ctx.identity || [];
  const prot = (p) => (f.process ? protectedTargets.checkProcess({ name: p.name, pid: p.pid, path: p.path, guardianRoot: ctx.guardianRoot }) : { protected: false });
  const programRefusal = (p) => (p.path ? netguard.refuseProgram(p.path, { guardianRoot: ctx.guardianRoot }) : 'Guardian cannot read this program\'s path (it may need elevation), so it cannot create a program rule.');

  if (f.process) {
    const p = f.process; const c = prot(p);
    actions.push(offer('process.stop', { pid: p.pid, name: String(p.name).replace(/\.exe$/i, ''), path: p.path || undefined }, { protectedReason: c.protected ? `Protected: ${c.reason}.` : null }));
  }
  if (f.rule !== 'unexpected-listener' && f.process && f.process.path) {
    const refusal = programRefusal(f.process);
    actions.push(offer('firewall.block-program', { path: f.process.path, direction: 'Outbound', duration: TEMP }, { label: 'Block temporarily (24 h)', protectedReason: refusal }));
    actions.push(offer('firewall.block-program', { path: f.process.path, direction: 'Outbound', duration: 'permanent' }, { label: 'Create block rule', protectedReason: refusal }));
    const top = (f.evidence || []).find((e) => e.label === 'Examples');
    const ip = top && /^([0-9a-f:.]+):\d+/i.exec(String(top.value).split(',')[0].trim());
    if (ip) actions.push(offer('firewall.block-remote', { remote: ip[1], duration: TEMP }, { label: 'Block this address (24 h)', protectedReason: netguard.refuseRemote(ip[1], identity) }));
  }
  if (f.listener) {
    actions.push(offer('firewall.block-port', { port: f.listener.port, protocol: f.listener.protocol, duration: TEMP }, { label: 'Block port temporarily (24 h)', protectedReason: netguard.refusePort(f.listener.port, ctx.bridgePort) }));
    actions.push(offer('firewall.block-port', { port: f.listener.port, protocol: f.listener.protocol, duration: 'permanent' }, { label: 'Create port rule', protectedReason: netguard.refusePort(f.listener.port, ctx.bridgePort) }));
  }
  if (f.remote) actions.push(offer('firewall.block-remote', { remote: f.remote.address, duration: TEMP }, { label: 'Block this address (24 h)', protectedReason: netguard.refuseRemote(f.remote.address, identity) }));
  if (f.firewallProfile && f.rule !== 'fw-default-inbound-allow') actions.push(offer('firewall.enable-profile', { profile: f.firewallProfile }));
  if (f.dnsName) {
    actions.push(offer('dns.flush', {}));
    actions.push(offer('dns.unblock-domain', { domain: f.dnsName }, { label: 'Remove the block' }));
  }
  return actions;
}

function toActionFindings(netFindings, ctx, history = []) {
  return netFindings.map((f) => {
    const actions = offersFor(f, ctx);
    const needles = [f.process && f.process.name, f.listener && String(f.listener.port), f.dnsName, f.firewallProfile].filter(Boolean).map((x) => String(x).toLowerCase());
    const attempts = history.filter((h) => /^(process|firewall|dns)\./.test(h.actionId) && needles.some((n) => String(h.target || '').toLowerCase().includes(n))).slice(0, 5);
    return { ...f, actions, manual: actions.length ? null : (f.manual || { label: 'Review manually', href: '#/network', reason: 'Guardian has no safe, deterministic fix for this one.' }), investigate: { label: 'Investigate', href: `#/network?finding=${encodeURIComponent(f.id)}` }, attempts };
  });
}

module.exports = { toActionFindings, offersFor };
