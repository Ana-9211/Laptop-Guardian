'use strict';
/**
 * Protected targets, mirrored from src/powershell/Common/Security.psm1 (a test keeps the two lists identical).
 * The bridge uses this only to refuse early and to label findings; PowerShell is the authority and re-checks live.
 */
const path = require('path');

const PROCESS_NAMES = [
  'system', 'idle', 'registry', 'memory compression', 'secure system', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso',
  'svchost', 'dwm', 'fontdrvhost', 'explorer', 'sihost', 'taskhostw', 'ctfmon', 'runtimebroker', 'shellexperiencehost', 'startmenuexperiencehost',
  'searchhost', 'textinputhost', 'applicationframehost', 'conhost', 'dllhost', 'wudfhost', 'spoolsv', 'audiodg', 'logonui', 'userinit',
  'msmpeng', 'nissrv', 'securityhealthservice', 'securityhealthsystray', 'smartscreen', 'mpdefendercoreservice', 'wlms', 'sgrmbroker',
  'msedgewebview2', 'taskmgr', 'powershell', 'pwsh', 'cmd', 'node', 'claude', 'wmiprvse', 'dashost', 'lsm', 'vmmem', 'vmcompute', 'vmwp',
];
/** Windows' own process names (mirrors WindowsCoreProcessNames in Security.psm1). Only genuine when run from the Windows folder or Microsoft-signed. */
const CORE_WINDOWS_NAMES = ['smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso', 'svchost', 'dwm', 'fontdrvhost', 'explorer', 'sihost', 'taskhostw', 'ctfmon', 'runtimebroker', 'shellexperiencehost', 'startmenuexperiencehost', 'searchhost', 'textinputhost', 'applicationframehost', 'conhost', 'dllhost', 'wudfhost', 'spoolsv', 'audiodg', 'logonui', 'userinit', 'wmiprvse', 'dashost', 'lsm'];
const SERVICE_NAMES = [
  'wdfilter', 'windefend', 'wscsvc', 'mpssvc', 'bfe', 'rpcss', 'dcomlaunch', 'eventlog', 'lsm', 'samss', 'wuauserv', 'trustedinstaller', 'winmgmt',
  'sppsvc', 'cryptsvc', 'dnscache', 'dhcp', 'netlogon', 'schedule', 'profsvc', 'power', 'plugplay', 'sens', 'themes', 'audiosrv', 'spooler',
  'securityhealthservice', 'sense', 'wlidsvc',
];

const lower = (s) => String(s || '').toLowerCase();
const stripExe = (n) => lower(n).replace(/\.exe$/, '');
const isWindowsPath = (p) => !!process.env.SystemRoot && lower(p).startsWith(`${lower(process.env.SystemRoot).replace(/\\+$/, '')}\\`);

/** { protected, reason } for a process. PIDs 4 and below are reserved. */
const rootsOf = (g) => [].concat(g || []).filter(Boolean).map((r) => String(r).replace(/\\+$/, ''));

function checkProcess({ name, pid, path: exePath, guardianRoot }) {
  if (Number.isInteger(pid) && pid <= 4) return { protected: true, reason: 'reserved system PID' };
  // A Windows system name running from outside the Windows folder is a lookalike. PowerShell checks the signature; here it is only labelled.
  if (CORE_WINDOWS_NAMES.includes(stripExe(name)) && exePath && !isWindowsPath(exePath)) return { protected: false, suspicious: true, reason: `'${stripExe(name)}' is a Windows system name, but this copy is not in the Windows folder` };
  if (PROCESS_NAMES.includes(stripExe(name))) return { protected: true, reason: `'${stripExe(name)}' is on the protected process list` };
  if (exePath && isWindowsPath(exePath)) return { protected: true, reason: 'the executable lives under the Windows directory' };
  if (exePath && rootsOf(guardianRoot).some((g) => lower(exePath).startsWith(lower(g)))) return { protected: true, reason: 'it belongs to Laptop Guardian itself' };
  return { protected: false, reason: null };
}

function checkService(name) {
  return SERVICE_NAMES.includes(lower(name)) ? { protected: true, reason: `'${name}' is a Windows or security service` } : { protected: false, reason: null };
}

function pathPrefixes() {
  const e = process.env; const drive = e.SystemDrive || 'C:';
  return [e.SystemRoot, e.windir, e.ProgramFiles, e['ProgramFiles(x86)'], e.ProgramData, `${drive}\\Recovery`, `${drive}\\$Recycle.Bin`, `${drive}\\System Volume Information`, `${drive}\\Boot`, `${drive}\\EFI`]
    .filter(Boolean).map((p) => p.replace(/\\+$/, ''));
}

/** { protected, reason } for a file path; drive roots, the profile root, system locations, Guardian's tree and user-protected folders. */
function checkPath(p, { protectedDirs = [], guardianRoot } = {}) {
  if (!p || typeof p !== 'string') return { protected: true, reason: 'no path' };
  if (/[*?]/.test(p)) return { protected: true, reason: 'wildcards are never accepted' };
  if (!/^[A-Za-z]:\\/.test(p)) return { protected: true, reason: 'only absolute local paths are accepted' };
  const full = path.win32.resolve(p).replace(/\\+$/, '');
  if (/^[A-Za-z]:$/.test(full)) return { protected: true, reason: 'a drive root' };
  if (process.env.USERPROFILE && lower(full) === lower(process.env.USERPROFILE.replace(/\\+$/, ''))) return { protected: true, reason: 'the user profile root' };
  // Other people's profiles: only the current user's own folders may be touched under <drive>\Users.
  const drive = process.env.SystemDrive || 'C:'; const usersRoot = `${drive}\\Users`; const mine = (process.env.USERPROFILE || '').replace(/\\+$/, '');
  if (mine) {
    if (lower(full) === lower(usersRoot)) return { protected: true, reason: 'the Users folder' };
    if (lower(full).startsWith(`${lower(usersRoot)}\\`) && !(lower(full) === lower(mine) || lower(full).startsWith(`${lower(mine)}\\`))) return { protected: true, reason: 'another user\'s profile' };
  }
  const all = [...pathPrefixes(), ...protectedDirs.map((d) => String(d).replace(/\\+$/, ''))];
  for (const pre of all) { if (lower(full) === lower(pre) || lower(full).startsWith(`${lower(pre)}\\`)) return { protected: true, reason: `inside a protected location (${pre})` }; }
  for (const g of rootsOf(guardianRoot)) { if (lower(full) === lower(g) || lower(full).startsWith(`${lower(g)}\\`)) return { protected: true, reason: 'Laptop Guardian\'s own files' }; }
  return { protected: false, reason: null };
}

module.exports = { CORE_WINDOWS_NAMES, PROCESS_NAMES, SERVICE_NAMES, checkProcess, checkService, checkPath, pathPrefixes };
