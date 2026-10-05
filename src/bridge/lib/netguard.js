'use strict';
/**
 * Network target rules, mirrored from src/powershell/Actions/NetworkActions.psm1. The bridge uses them to refuse early and to
 * label what Guardian offers; PowerShell re-checks the live system. Nothing here touches Windows.
 */
const net = require('net');
const path = require('path');
const protectedTargets = require('./protected');

const PROTECTED_PORTS = [53, 67, 68, 546, 547];
const PROTECTED_DNS_SUFFIXES = ['microsoft.com', 'windowsupdate.com', 'windows.com', 'windows.net', 'live.com', 'office.com', 'office365.com', 'msftconnecttest.com', 'msftncsi.com', 'azure.com', 'azureedge.net', 'digicert.com', 'localhost', 'local', 'invalid', 'test', 'example'];
const RULE_NAME_RE = /^LG-[0-9]{6,12}-[0-9a-f]{6}$/;
const MIN_PREFIX = { v4: 8, v6: 16 };

/** Parses "1.2.3.4", "1.2.3.0/24", "2001:db8::/32" into { family, bytes, prefix } or null. */
function parseIp(text) {
  const m = /^(.+?)(?:\/(\d{1,3}))?$/.exec(String(text || '').trim());
  if (!m) return null;
  const addr = m[1]; const fam = net.isIPv4(addr) ? 4 : net.isIPv6(addr) ? 6 : 0;
  if (!fam) return null;
  const bits = fam === 4 ? 32 : 128; const prefix = m[2] === undefined ? bits : Number(m[2]);
  if (prefix < 0 || prefix > bits) return null;
  return { family: fam, bytes: fam === 4 ? addr.split('.').map(Number) : v6Bytes(addr), prefix };
}
function v6Bytes(addr) {
  let a = addr.split('%')[0];
  const emb = /(\d+\.\d+\.\d+\.\d+)$/.exec(a);
  if (emb) { const b = emb[1].split('.').map(Number); a = a.replace(emb[1], `${((b[0] << 8) | b[1]).toString(16)}:${((b[2] << 8) | b[3]).toString(16)}`); }
  const [head, tail] = a.split('::');
  const h = head ? head.split(':') : []; const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = a.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  const out = []; for (const g of groups) { const v = parseInt(g || '0', 16); out.push((v >> 8) & 255, v & 255); }
  return out;
}
function inCidr(info, other) {
  const o = parseIp(other); if (!o || o.family !== info.family) return false;
  const full = Math.floor(info.prefix / 8); const rem = info.prefix % 8;
  for (let i = 0; i < full; i++) if (info.bytes[i] !== o.bytes[i]) return false;
  if (rem) { const mask = (0xff << (8 - rem)) & 0xff; if ((info.bytes[full] & mask) !== (o.bytes[full] & mask)) return false; }
  return true;
}

function isPrivateIp(addr) {
  const i = parseIp(addr); if (!i) return false;
  const b = i.bytes;
  if (i.family === 4) return b[0] === 10 || b[0] === 127 || b[0] === 0 || (b[0] === 172 && b[1] >= 16 && b[1] <= 31) || (b[0] === 192 && b[1] === 168) || (b[0] === 169 && b[1] === 254) || b[0] >= 224;
  return (b[0] & 0xfe) === 0xfc || (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) || b.slice(0, 15).every((x) => x === 0) || b[0] === 0xff;
}
const isLoopback = (addr) => { const i = parseIp(addr); return !!i && ((i.family === 4 && i.bytes[0] === 127) || (i.family === 6 && i.bytes.slice(0, 15).every((x) => x === 0) && i.bytes[15] === 1)); };
const isUnspecified = (addr) => { const i = parseIp(addr); return !!i && i.bytes.every((x) => x === 0); };

function refuseProgram(p, { guardianRoot } = {}) {
  if (!/\.exe$/i.test(p || '')) return 'Only .exe programs can be targeted.';
  const name = path.win32.basename(p).replace(/\.exe$/i, '').toLowerCase();
  if (protectedTargets.PROCESS_NAMES.includes(name)) return `Protected: '${name}' is a Windows, security or Guardian program and is never blocked.`;
  const lower = String(p).toLowerCase();
  if (process.env.SystemRoot && lower.startsWith(process.env.SystemRoot.toLowerCase())) return 'Protected: programs in the Windows directory are never blocked.';
  for (const d of [`${process.env.ProgramData}\\Microsoft\\Windows Defender`, `${process.env.ProgramFiles}\\Windows Defender`, `${process.env['ProgramFiles(x86)']}\\Windows Defender`]) { if (d && !d.startsWith('undefined') && lower.startsWith(d.toLowerCase())) return 'Protected: Microsoft Defender components are never blocked.'; }
  if ([].concat(guardianRoot || []).filter(Boolean).some((g) => lower.startsWith(String(g).toLowerCase()))) return 'Protected: Laptop Guardian\'s own programs are never blocked.';
  return null;
}

function refuseRemote(text, identity = []) {
  const i = parseIp(text);
  if (!i) return 'That is not a valid IP address or CIDR range.';
  const min = i.family === 4 ? MIN_PREFIX.v4 : MIN_PREFIX.v6;
  if (i.prefix < min) return `That range is too broad (a /${i.prefix} would cover a huge part of the internet). Use /${min} or narrower.`;
  if (i.family === 4) {
    if (i.bytes[0] === 127) return 'Loopback addresses are never blocked.';
    if (i.bytes[0] === 0) return 'The unspecified address cannot be blocked.';
    if (i.bytes[0] >= 224) return 'Multicast and reserved ranges are never blocked.';
    if (i.bytes[0] === 169 && i.bytes[1] === 254) return 'Link-local addresses (automatic networking) are never blocked.';
  } else if (isLoopback(text) || isUnspecified(text) || (i.bytes[0] === 0xfe && (i.bytes[1] & 0xc0) === 0x80) || i.bytes[0] === 0xff) return 'Loopback, link-local, multicast and unspecified IPv6 addresses are never blocked.';
  for (const keep of identity) { if (inCidr(i, keep)) return `Refused: this would block your gateway, DNS or DHCP server (${keep}), which would cut the laptop off the network.`; }
  return null;
}

function refusePort(port, bridgePort) {
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return 'Ports run from 1 to 65535.';
  if (PROTECTED_PORTS.includes(n)) return `Port ${n} is needed for DNS or DHCP and is never blocked.`;
  if (bridgePort && n === bridgePort) return 'That is Laptop Guardian\'s own dashboard port.';
  return null;
}

function refuseDomain(text) {
  const d = String(text || '').trim().toLowerCase().replace(/\.$/, '');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(d) || d.includes(':')) return 'Give a host name, not an IP address (use a firewall rule for addresses).';
  if (/[*?/\\ ]/.test(d)) return 'Wildcards and paths are not supported: the hosts file can only block exact host names.';
  if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(d)) return 'That is not a valid host name.';
  for (const s of PROTECTED_DNS_SUFFIXES) { if (d === s || d.endsWith(`.${s}`)) return `Protected: '${s}' sites are needed by Windows, updates or security and are never blocked.`; }
  return null;
}

/** Static refusal for the network catalog actions. Returns a message or null. */
function staticRefusal(actionId, params, ctx = {}) {
  switch (actionId) {
    case 'firewall.block-program': case 'firewall.allow-program': return refuseProgram(params.path, ctx);
    case 'firewall.block-port': return refusePort(params.port, ctx.bridgePort);
    case 'firewall.block-remote': return refuseRemote(params.remote, ctx.identity || []);
    case 'dns.block-domain': return ctx.dnsFilteringEnabled === false ? 'DNS filtering is off. Turn it on (opt-in) in Network Guard first.' : refuseDomain(params.domain);
    case 'dns.unblock-domain': return null;
    default: return null;
  }
}

const HOSTS_BEGIN = '# BEGIN LAPTOP GUARDIAN DNS BLOCKS';
const HOSTS_END = '# END LAPTOP GUARDIAN DNS BLOCKS';
/** Read-only: the domains inside Guardian's managed block of a hosts file (the text outside the block is never parsed). */
function readHostsBlock(file) {
  let text; try { text = require('fs').readFileSync(file, 'utf8'); } catch { return { exists: false, domains: [] }; }
  const b = text.indexOf(HOSTS_BEGIN); const e = b < 0 ? -1 : text.indexOf(HOSTS_END, b);
  if (b < 0 || e < 0) return { exists: true, domains: [] };
  return { exists: true, domains: [...text.slice(b, e).matchAll(/^0\.0\.0\.0\s+(\S+)\s*$/gm)].map((m) => m[1]) };
}
const defaultHostsPath = () => path.win32.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'drivers', 'etc', 'hosts');

module.exports = { PROTECTED_PORTS, PROTECTED_DNS_SUFFIXES, RULE_NAME_RE, parseIp, inCidr, isPrivateIp, isLoopback, isUnspecified, refuseProgram, refuseRemote, refusePort, refuseDomain, staticRefusal, readHostsBlock, defaultHostsPath };
