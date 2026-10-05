'use strict';
/** Generates a realistic synthetic Laptop Guardian data tree following docs/DATA-CONTRACT.md. Usage: node make-fixtures.js <dir> [days] */
const fs = require('fs');
const path = require('path');
const { DEFAULT_CONFIG, localIso } = require('../../src/bridge/lib/util');

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${String(w).padStart(2, '0')}`;
}
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const PROCS = [
  ['chrome', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'Google LLC', 'known-app', 'program-files', 14],
  ['msedge', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'Microsoft Corporation', 'known-app', 'program-files', 9],
  ['Code', 'C:\\Users\\Anagha\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe', 'Microsoft Corporation', 'known-app', 'user-appdata', 7],
  ['node', 'C:\\Program Files\\nodejs\\node.exe', 'OpenJS Foundation', 'known-app', 'program-files', 3],
  ['explorer', 'C:\\Windows\\explorer.exe', 'Microsoft Windows', 'windows', 'system', 1],
  ['svchost', 'C:\\Windows\\System32\\svchost.exe', 'Microsoft Windows', 'windows', 'system', 22],
  ['MsMpEng', 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform\\4.18\\MsMpEng.exe', 'Microsoft Corporation', 'windows', 'system', 1],
  ['SearchIndexer', 'C:\\Windows\\System32\\SearchIndexer.exe', 'Microsoft Windows', 'windows', 'system', 1],
  ['OneDrive', 'C:\\Users\\Anagha\\AppData\\Local\\Microsoft\\OneDrive\\OneDrive.exe', 'Microsoft Corporation', 'known-app', 'user-appdata', 1],
  ['Teams', 'C:\\Users\\Anagha\\AppData\\Local\\Microsoft\\Teams\\current\\Teams.exe', 'Microsoft Corporation', 'known-app', 'user-appdata', 4],
  ['Discord', 'C:\\Users\\Anagha\\AppData\\Local\\Discord\\app-1.0.9\\Discord.exe', 'Discord Inc.', 'known-app', 'user-appdata', 5],
  ['Spotify', 'C:\\Users\\Anagha\\AppData\\Roaming\\Spotify\\Spotify.exe', 'Spotify AB', 'known-app', 'user-appdata', 4],
  ['AdobeUpdateService', 'C:\\Program Files (x86)\\Common Files\\Adobe\\AdobeGCClient\\AdobeUpdateService.exe', 'Adobe Inc.', 'third-party', 'program-files', 1],
  ['OneApp.IGCC.WinService', 'C:\\Windows\\System32\\DriverStore\\FileRepository\\igcc\\OneApp.IGCC.WinService.exe', 'Intel Corporation', 'third-party', 'system', 1],
  ['updater', 'C:\\Users\\Anagha\\AppData\\Local\\Temp\\7zS4F2A\\updater.exe', null, 'unknown', 'temp', 1],
  ['helper_svc', 'C:\\Users\\Anagha\\AppData\\Roaming\\HelperTool\\helper_svc.exe', null, 'unknown', 'user-appdata', 1],
  ['SteamWebHelper', 'C:\\Program Files (x86)\\Steam\\bin\\cef\\cef.win7x64\\steamwebhelper.exe', 'Valve Corp.', 'known-app', 'program-files', 3],
  ['RtkAudUService64', 'C:\\Windows\\System32\\DriverStore\\FileRepository\\realtek\\RtkAudUService64.exe', 'Realtek Semiconductor Corp.', 'third-party', 'system', 1],
  ['python', 'C:\\Python314\\python.exe', 'Python Software Foundation', 'known-app', 'program-files', 2],
  ['ollama', 'C:\\Users\\Anagha\\AppData\\Local\\Programs\\Ollama\\ollama.exe', 'Ollama', 'known-app', 'user-appdata', 1],
];

function makeProcess(rand, p, i, now) {
  const [name, exe, publisher, cls, pathClass, instances] = p;
  const heavy = ['chrome', 'msedge', 'Code', 'ollama', 'SteamWebHelper'].includes(name);
  const cpu = r1(heavy ? rand() * 35 : rand() * 3);
  const mem = Math.round(heavy ? 300 + rand() * 1600 : 15 + rand() * 250);
  const signed = !!publisher;
  const persistent = ['OneDrive', 'Teams', 'Discord', 'Spotify', 'AdobeUpdateService', 'helper_svc', 'updater', 'OneApp.IGCC.WinService', 'MsMpEng', 'SearchIndexer', 'RtkAudUService64', 'ollama'].includes(name);
  const svc = ['AdobeUpdateService', 'OneApp.IGCC.WinService', 'MsMpEng', 'SearchIndexer'].includes(name) ? [name === 'MsMpEng' ? 'WinDefend' : name] : [];
  const startup = [];
  if (['OneDrive', 'Teams', 'Discord', 'Spotify', 'ollama'].includes(name)) startup.push({ kind: 'registry', name, location: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', command: `"${exe}"` });
  if (name === 'helper_svc') startup.push({ kind: 'task', name: 'HelperToolSync', location: '\\HelperToolSync', command: exe });
  if (svc.length) startup.push({ kind: 'service', name: svc[0], location: 'Services', command: exe });
  const flags = [];
  if (cpu > 25) flags.push('high-cpu');
  if (mem > 1500) flags.push('high-memory');
  if (persistent && cls !== 'windows') flags.push('persistent');
  if (pathClass === 'temp') flags.push('unusual-location');
  if (!publisher) flags.push('no-publisher', 'unsigned');
  if (instances > 8 && !['svchost'].includes(name)) flags.push('duplicate');
  return {
    name, pid: 1000 + i * 137 + Math.floor(rand() * 50), path: exe, commandLine: `"${exe}"${name === 'node' ? ' server.js' : ''}`,
    parentPid: name === 'explorer' ? 1 : 4200, parentName: name === 'explorer' ? 'userinit' : 'explorer', cpuPct: cpu, cpuSeconds: Math.round(rand() * 9000), memoryMB: mem,
    startTime: localIso(new Date(now - rand() * 86400000 * 2)), publisher, signature: signed ? 'Valid' : 'NotSigned', signed,
    services: svc, startupEntries: startup, scheduledTasks: name === 'AdobeUpdateService' ? ['\\Adobe Acrobat Update Task'] : startup.filter((s) => s.kind === 'task').map((s) => s.location),
    persistent, user: cls === 'windows' ? 'NT AUTHORITY\\SYSTEM' : 'ANAGHA\\Anagha', pathClass, classification: cls, instances, flags, policy: 'none', recommendationId: null,
  };
}

function makeFixtures(dir, days = 45, seed = 42) {
  const rand = rng(seed);
  const w = (rel, data) => { const f = path.join(dir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data, null, 2)); };
  const now = new Date();
  now.setHours(19, 2, 0, 0);

  // config + policy
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.safety.safeMode = false;
  config.ai.enabled = true;
  w('config/config.json', config);
  w('config/cleanup-policy.json', { tempFiles: { enabled: true, minAgeDays: 2 }, crashDumps: { enabled: true }, caches: { enabled: true, targets: ['Windows\\Temp', 'INetCache'] } });
  const bl = { id: 'p_bl1', name: 'updater', path: 'C:\\Users\\Anagha\\AppData\\Local\\Temp\\7zS4F2A\\updater.exe', reason: 'Re-launches from Temp every login; no publisher.', addedAt: localIso(new Date(now - 20 * 86400000)), addedBy: 'user', enabled: true, action: 'terminate', terminatedCount: 14, lastTerminatedAt: localIso(new Date(now - 86400000)), disabledUntil: null };
  const bl2 = { id: 'p_bl2', name: 'AdobeUpdateService', path: null, reason: 'Not needed outside active Adobe sessions.', addedAt: localIso(new Date(now - 9 * 86400000)), addedBy: 'user', enabled: false, action: 'terminate', terminatedCount: 3, lastTerminatedAt: localIso(new Date(now - 6 * 86400000)), disabledUntil: null };
  w('config/process-policy.json', {
    blacklist: [bl, bl2],
    whitelist: [{ id: 'p_wl1', name: 'ollama', path: null, reason: 'Local LLM runtime I use daily.', addedAt: localIso(new Date(now - 30 * 86400000)), addedBy: 'user', enabled: true, action: 'none', terminatedCount: 0, lastTerminatedAt: null, disabledUntil: null }],
    ignored: [],
  });

  // processes
  const procs = PROCS.map((p, i) => makeProcess(rand, p, i, now));
  const recs = [];
  const recFor = (p, kind, title, risk, sev, why, action, days, extra = {}) => {
    const id = Buffer.from(`${p.name}:${title}`).toString('hex').slice(0, 16).padEnd(16, '0');
    p.recommendationId = id;
    const mech = [...p.startupEntries.map((s) => ({ kind: s.kind, name: s.name, location: s.location })), ...p.services.map((s) => ({ kind: 'service', name: s, location: 'Services' }))];
    recs.push({
      id, kind, title, status: 'open', risk, severity: sev, confidence: r2(0.6 + rand() * 0.3), source: 'deterministic',
      firstSeen: localIso(new Date(now - days * 86400000)), lastSeen: localIso(now), occurrences: days + 1, consecutiveDays: days + 1,
      target: { name: p.name, pid: p.pid, path: p.path },
      identity: { name: p.name, pid: p.pid, path: p.path, publisher: p.publisher, signature: p.signature, parent: p.parentName, service: p.services[0] || null },
      whatIsIt: extra.whatIsIt || `${p.name} (${p.classification}) running from ${p.pathClass}.`,
      whyFlagged: why, persistence: { persistent: p.persistent, mechanisms: mech }, suggestedAction: action,
      stopCommand: { command: `Stop-Process -Id ${p.pid} -Name ${p.name}`, explains: 'Ends this process instance only. It may restart through its persistence mechanism.', risk: 'LOW', requiresAdmin: false, reversible: true },
      preventRestart: mech.length ? (mech[0].kind === 'registry'
        ? { command: `Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name '${mech[0].name}'`, explains: 'Removes the Run-key startup entry. The app stays installed.', risk: 'LOW', requiresAdmin: false, reversible: true }
        : { command: `Disable-ScheduledTask -TaskName '${mech[0].name}'`, explains: 'Disables the scheduled task that relaunches this program.', risk: 'MEDIUM', requiresAdmin: true, reversible: true }) : null,
      consequences: extra.consequences || 'Unsaved work in this application may be lost. Features that rely on it stop until it is restarted.',
      ai: extra.ai || null,
    });
  };
  const byName = (n) => procs.find((p) => p.name === n);
  recFor(byName('updater'), 'process', 'Unsigned updater running from Temp', 'HIGH', 'high', ['Executable located in %TEMP%', 'No publisher / not signed', 'Relaunches via scheduled task'], 'Investigate further', 12, {
    whatIsIt: 'An unsigned executable launched from a temporary extraction folder. Often a leftover from an installer, but legitimate software rarely keeps running from Temp.',
    ai: { classification: 'unknown-unsigned', what_is_it: 'Unsigned updater launched from a 7-Zip temp extraction path.', why_flagged: 'Temp location + no publisher + recurring launch.', risk: 'HIGH', persistence: 'Scheduled task HelperToolSync', suggested_action: 'Investigate further', temporary_stop_method: 'Stop-Process -Name updater', persistence_removal_method: "Disable-ScheduledTask -TaskName 'HelperToolSync'", consequences: 'Whatever installer left it behind may fail to update itself.', confidence: 0.72, evidence: ['pathClass=temp', 'signature=NotSigned', 'scheduledTasks=1'], warnings: ['Unfamiliar is not the same as malicious. Verify the file hash before deleting.'], analyzedAt: localIso(now), model: 'gemini-2.5-flash', validated: true },
  });
  recFor(byName('helper_svc'), 'process', 'Persistent unsigned helper in AppData', 'MEDIUM', 'medium', ['Starts at logon via scheduled task', 'No publisher', 'Runs from Roaming AppData'], 'Review', 8);
  recFor(byName('chrome'), 'process', 'Chrome using 1.6 GB across 14 processes', 'LOW', 'low', ['Combined memory above 1500 MB', '14 instances'], 'Review', 3, { consequences: 'Open tabs will close. Chrome can restore them on next start.' });
  recFor(byName('AdobeUpdateService'), 'process', 'Adobe updater service always running', 'LOW', 'low', ['Persistent third-party service', 'Low CPU, always on'], 'Stop temporarily', 21);
  recFor(byName('Discord'), 'process', 'Discord starts at logon', 'LOW', 'low', ['Registry Run entry', '5 instances'], 'Disable startup', 15);
  recs.push({ id: 'sys-disk-trend-0001', kind: 'storage', title: 'Free disk space shrinking steadily', status: 'open', risk: 'MEDIUM', severity: 'medium', confidence: 0.81, source: 'deterministic', firstSeen: localIso(new Date(now - 5 * 86400000)), lastSeen: localIso(now), occurrences: 6, consecutiveDays: 6, target: null, identity: null, whatIsIt: 'C: free space fell about 11 GB over the last two weeks.', whyFlagged: ['Net decline across 14 daily samples', 'Free space below 25%'], persistence: { persistent: false, mechanisms: [] }, suggestedAction: 'Review', stopCommand: null, preventRestart: null, consequences: 'Below 8% free, Windows Update and the pagefile may fail.', ai: null });
  recs.push({ id: 'sec-defender-sig-0002', kind: 'security', title: 'Defender signatures 3 days old', status: 'dismissed', risk: 'LOW', severity: 'low', confidence: 0.9, source: 'deterministic', firstSeen: localIso(new Date(now - 30 * 86400000)), lastSeen: localIso(new Date(now - 10 * 86400000)), occurrences: 2, consecutiveDays: 0, target: null, identity: null, whatIsIt: 'Signature update was delayed.', whyFlagged: ['sigAgeDays = 3'], persistence: { persistent: false, mechanisms: [] }, suggestedAction: 'Review', stopCommand: null, preventRestart: null, consequences: 'New threats may not be detected until signatures update.', ai: null });
  for (const p of procs) { if (p.name === 'updater') p.flags.push('blacklisted'), p.policy = 'blacklist'; if (p.name === 'AdobeUpdateService') p.policy = 'blacklist'; if (p.name === 'ollama') p.policy = 'whitelist', p.flags.push('whitelisted'); }
  w('data/latest/processes.json', { generatedAt: localIso(now), processes: procs });
  w('data/recommendations/recommendations.json', { updatedAt: localIso(now), items: recs });

  // files
  const files = [
    ['C:\\Users\\Anagha\\Downloads\\Win11_24H2_English_x64.iso', 5400, 'Windows installer image', 'installer', 'LIKELY_UNNECESSARY', 'Old installer ISO; the system is already installed.', 210],
    ['C:\\Users\\Anagha\\Downloads\\VSCodeSetup-x64-1.88.exe', 98, 'Visual Studio Code installer', 'installer', 'LIKELY_UNNECESSARY', 'Installer for software that is already installed.', 140],
    ['C:\\Windows\\Minidump\\051524-9843-01.dmp', 280, 'Kernel crash dump', 'crash-dump', 'REVIEW', 'Crash dump from a previous blue screen.', 90],
    ['C:\\Users\\Anagha\\Videos\\screen-recording-raw.mkv', 3200, 'Large video file', 'large', 'REVIEW', 'Largest personal file; not modified in 8 months.', 240],
    ['C:\\Users\\Anagha\\Documents\\backup-2023.zip', 1900, 'Archive', 'archive', 'REVIEW', 'Archive older than 365 days.', 700],
    ['C:\\Users\\Anagha\\Downloads\\dataset (1).csv', 640, 'Possible duplicate of dataset.csv', 'duplicate', 'REVIEW', 'Identical hash to dataset.csv in the same folder.', 60],
    ['C:\\Users\\Anagha\\Downloads\\unconfirmed 482113.crdownload', 760, 'Abandoned browser download', 'abandoned-download', 'LIKELY_UNNECESSARY', 'Partial download untouched for 40 days.', 40],
    ['C:\\Users\\Anagha\\Documents\\thesis-final-v7.docx', 12, 'Personal document', 'old', 'KEEP', 'Old but a personal document. Guardian never recommends deleting these.', 800],
  ].map(([p, mb, what, cat, cls, why, age], i) => ({
    id: `f${i}${Buffer.from(p).toString('hex').slice(0, 14)}`, path: p, name: path.win32.basename(p), sizeMB: mb, lastModified: localIso(new Date(now - age * 86400000)), lastAccessed: null, ageDays: age,
    extension: path.win32.extname(p), classification: cls, category: cat, whatIsIt: what, whyFlagged: [why], duplicateOf: cat === 'duplicate' ? 'C:\\Users\\Anagha\\Downloads\\dataset.csv' : null,
    referencedBySoftware: cat === 'crash-dump' ? false : null, ifDeleted: cls === 'KEEP' ? 'Not recommended for deletion.' : 'Moves to the Recycle Bin; restorable until it is emptied.', risk: cls === 'KEEP' ? 'HIGH' : cls === 'REVIEW' ? 'MEDIUM' : 'LOW',
    recommendedAction: cls === 'LIKELY_UNNECESSARY' ? 'Move to Recycle Bin after review' : cls === 'KEEP' ? 'Keep' : 'Review', ignored: false,
  }));
  w('data/latest/files.json', {
    generatedAt: localIso(new Date(now - 3 * 86400000)),
    drives: [{ drive: 'C:', totalGB: 475.7, freeGB: 118.4, type: 'SSD' }],
    candidates: files, largest: files.slice().sort((a, b) => b.sizeMB - a.sizeMB).slice(0, 6).map((f) => ({ path: f.path, sizeMB: f.sizeMB, lastModified: f.lastModified })),
    duplicates: [{ hash: 'a41c9e07', sizeMB: 640, files: ['C:\\Users\\Anagha\\Downloads\\dataset.csv', 'C:\\Users\\Anagha\\Downloads\\dataset (1).csv'] }],
    downloads: { count: 214, sizeGB: 21.4, oldCount: 87 },
  });

  // metrics + reports + actions
  const metrics = []; const actions = []; const aiUsage = [];
  let freeGB = 138; let health = 88;
  const dailyReports = []; const weeklyReports = [];
  const addAct = (ts, category, action, o = {}) => actions.push({ id: `a_${actions.length.toString(16).padStart(8, '0')}`, ts: localIso(ts), category, severity: 'info', target: null, result: 'success', actor: 'agent', reason: null, relatedRecommendation: null, error: null, runType: null, ...o, action });
  for (let d = days - 1; d >= 0; d--) {
    const day = new Date(now); day.setDate(day.getDate() - d);
    freeGB = clamp(freeGB - 0.25 + (rand() - 0.55) * 1.4 + (d === 20 ? 7 : 0), 40, 300);
    const cpu = r1(clamp(12 + rand() * 30 + (d % 7 === 0 ? 15 : 0), 3, 95));
    const ramTotal = 15.7; const ramPct = r1(clamp(52 + rand() * 28, 30, 96)); const diskTotal = 475.7;
    const total = 190 + Math.round(rand() * 25); const flagged = Math.round(3 + rand() * 4 + (d < 12 ? 2 : 0));
    const errs = Math.round(rand() * 4 + (d % 9 === 0 ? 6 : 0));
    const threats = d === 17 ? 1 : 0;
    health = clamp(health + (rand() - 0.5) * 6 - (errs > 5 ? 3 : 0), 62, 98);
    const sigAge = Math.floor(rand() * 2) + (d === 30 ? 3 : 0);
    const ts = new Date(day); ts.setHours(19, 2 + Math.round(rand() * 3), 0, 0);
    const startupCount = 14 + (d < 20 ? 1 : 0) + (d < 8 ? 1 : 0);
    const m = {
      ts: localIso(ts), runType: 'daily', cpuPct: cpu, ramPct, ramUsedGB: r1(ramTotal * ramPct / 100), ramTotalGB: ramTotal, diskUsedPct: r1((1 - freeGB / diskTotal) * 100), diskFreeGB: r1(freeGB), diskTotalGB: diskTotal,
      diskFreePct: r1(freeGB / diskTotal * 100), processCount: total, flaggedCount: flagged, recommendationCount: 5 + Math.round(rand() * 3), actionCount: 6 + Math.round(rand() * 6), errorCount: errs,
      startupCount, serviceFailures: d % 11 === 0 ? 2 : Math.round(rand() * 0.8), batteryPct: Math.round(60 + rand() * 40), downloadsGB: r1(19 + (days - d) * 0.05), defenderSigAgeDays: sigAge, defenderThreats: threats, healthScore: Math.round(health),
    };
    metrics.push(m);
    const id = ymd(day);
    const topCpu = procs.slice().sort((a, b) => b.cpuPct - a.cpuPct).slice(0, 5).map((p) => ({ ...p, cpuPct: r1(p.cpuPct * (0.6 + rand() * 0.8)) }));
    const topMem = procs.slice().sort((a, b) => b.memoryMB - a.memoryMB).slice(0, 5);
    const report = {
      schema: 'guardian.report/1', type: 'daily', id, generatedAt: m.ts, durationSec: Math.round(80 + rand() * 90), status: d === 13 ? 'partial' : 'complete', incomplete: d === 13 ? ['Defender quick scan timed out'] : [],
      healthScore: m.healthScore, host: { name: 'ANAGHA-LAPTOP', user: 'Anagha', os: 'Windows 11 Home Single Language', build: '10.0.26200' },
      summary: { headline: m.healthScore >= 85 ? 'System healthy' : 'A few items need review', bullets: [`CPU averaged ${cpu}% and RAM ${ramPct}%.`, `${flagged} processes flagged; ${m.recommendationCount} open recommendations.`, `Free disk space ${m.diskFreeGB} GB (${m.diskFreePct}%).`] },
      sections: {
        system: { os: 'Windows 11 Home Single Language', build: '10.0.26200', uptimeHours: r1(5 + rand() * 90), bootTime: localIso(new Date(ts - 36 * 3600000)), cpu: { name: 'Intel(R) Core(TM) i7-1355U', cores: 10, logical: 12, usagePct: cpu }, ram: { totalGB: ramTotal, usedGB: m.ramUsedGB, freeGB: r1(ramTotal - m.ramUsedGB), usedPct: ramPct }, pagefile: { sizeMB: 4096, usedMB: Math.round(300 + rand() * 900) }, disks: [{ drive: 'C:', fs: 'NTFS', type: 'SSD', totalGB: diskTotal, freeGB: m.diskFreeGB, usedPct: m.diskUsedPct, freePct: m.diskFreePct, health: 'Healthy' }], battery: { present: true, pct: m.batteryPct, charging: rand() > 0.5, onAC: rand() > 0.4 }, temperature: { available: false, celsius: null }, load: r1(cpu / 100 * 12) },
        storage: { tempMB: Math.round(400 + rand() * 900), crashDumpMB: 280, cacheMB: Math.round(900 + rand() * 600), installersMB: 5498, downloads: { count: 214, sizeGB: m.downloadsGB, oldCount: 87 }, largeFiles: files.slice(0, 4).map((f) => ({ path: f.path, sizeMB: f.sizeMB })), duplicateCandidates: 3 },
        processes: { total, flagged, persistent: 9, highResource: 3, topCpu, topMemory: topMem },
        services: { running: 118, stopped: 142, autoStartStopped: ['gupdate', 'edgeupdate'], failed: m.serviceFailures ? ['WSearch', 'DoSvc'].slice(0, m.serviceFailures) : [], thirdParty: [{ name: 'AdobeUpdateService', display: 'Adobe Genuine Software Integrity Service', path: byName('AdobeUpdateService').path }, { name: 'OneApp.IGCC.WinService', display: 'Intel(R) Graphics Command Center Service', path: byName('OneApp.IGCC.WinService').path }] },
        startup: { count: startupCount, items: procs.filter((p) => p.startupEntries.length).flatMap((p) => p.startupEntries.map((s) => ({ ...s, publisher: p.publisher }))) },
        defender: { enabled: true, realTimeProtection: true, sigVersion: '1.425.211.0', sigAgeDays: sigAge, lastQuickScan: localIso(ts), scan: { ran: true, result: threats ? 'ThreatsFound' : 'Clean', durationSec: Math.round(120 + rand() * 200), threats: threats ? [{ name: 'PUA:Win32/Presenoker', severity: 'Low', status: 'Quarantined' }] : [] }, threats },
        firewall: { profiles: ['Domain', 'Private', 'Public'].map((n) => ({ name: n, enabled: true, defaultInbound: 'Block', defaultOutbound: 'Allow' })), problems: [] },
        windowsHealth: { pendingReboot: d === 2, windowsUpdate: { pendingCount: d < 3 ? 2 : 0, lastInstalled: localIso(new Date(now - 6 * 86400000)), status: 'Up to date' }, eventErrors: { system: errs, application: Math.round(rand() * 6), top: [{ source: 'DistributedCOM', id: 10016, count: 4 + Math.round(rand() * 10), message: 'The application-specific permission settings do not grant Local Activation permission.' }, { source: 'Service Control Manager', id: 7023, count: Math.round(rand() * 3), message: 'The Windows Search service terminated with an error.' }] }, sfc: { ran: false, result: 'skipped (weekly)' }, dism: { ran: false, result: 'skipped (weekly)', detail: '' }, componentStore: { reclaimable: null } },
        network: { adapters: [{ name: 'Wi-Fi', status: 'Up', speed: '866 Mbps', type: 'Wireless' }, { name: 'Ethernet', status: 'Disconnected', speed: '0 bps', type: 'Ethernet' }], gateway: '192.168.1.1', dnsServers: ['192.168.1.1', '1.1.1.1'], internet: true, dnsOk: true, gatewayOk: true, latencyMs: r1(10 + rand() * 25) },
        cleanup: { performed: true, safeMode: false, items: [{ kind: 'temp', path: 'C:\\Users\\Anagha\\AppData\\Local\\Temp', freedMB: Math.round(100 + rand() * 500), result: 'success' }, { kind: 'cache', path: 'C:\\Windows\\Temp', freedMB: Math.round(20 + rand() * 80), result: 'success' }], totalFreedMB: Math.round(150 + rand() * 500) },
        files: { candidateCount: files.length, reclaimableGB: 8.4 },
      },
      recommendations: recs.filter((r) => r.status === 'open').map((r) => r.id), actions: [], errors: errs > 5 ? [{ ts: m.ts, source: 'Windows event log', message: `${errs} System errors in the last 24 hours` }] : [],
      ai: { enabled: true, used: d % 3 === 0, requests: d % 3 === 0 ? 3 : 0, failures: 0, briefing: null, patterns: [] },
    };
    w(`reports/daily/${id}/report.json`, report);
    w(`reports/daily/${id}/report.html`, `<!doctype html><meta charset="utf-8"><title>Daily ${id}</title><body style="font:14px Segoe UI;margin:24px"><h1>Daily report ${id}</h1><p>${report.summary.headline}</p><ul>${report.summary.bullets.map((b) => `<li>${b}</li>`).join('')}</ul></body>`);
    dailyReports.push(report);
    // actions for the day
    addAct(new Date(ts - 90000), 'scan', 'daily.start', { runType: 'daily', result: 'started' });
    addAct(new Date(ts - 60000), 'defender', 'defender.quickscan', { runType: 'daily', target: 'MsMpEng', reason: 'Daily health check' });
    addAct(new Date(ts - 40000), 'cleanup', 'cleanup.temp', { runType: 'daily', target: '%TEMP%', reason: 'Files older than 2 days' });
    if (d < 20) addAct(new Date(ts - 30000), 'process', 'process.terminated.policy', { actor: 'policy', target: 'updater (PID 7312)', reason: 'Blacklisted by user', runType: 'daily' });
    if (errs > 5) addAct(new Date(ts - 20000), 'windows', 'eventlog.errors', { severity: 'warning', target: 'System log', error: `${errs} errors`, runType: 'daily' });
    if (d === 13) addAct(new Date(ts - 10000), 'defender', 'defender.quickscan', { severity: 'error', result: 'timeout', error: 'Quick scan exceeded 300s timeout', runType: 'daily' });
    if (d % 3 === 0) { addAct(new Date(ts - 5000), 'ai', 'ai.response.received', { actor: 'ai-validator', target: 'updater', runType: 'daily' }); aiUsage.push({ ts: localIso(ts), model: 'gemini-2.5-flash', kind: 'process', ok: true, promptTokens: 900 + Math.round(rand() * 400), outputTokens: 350 + Math.round(rand() * 200), error: null }); }
    addAct(new Date(ts), 'scan', 'daily.complete', { runType: 'daily', reason: `health ${m.healthScore}` });
    if (day.getDay() === 6) {
      const wid = isoWeek(day);
      const wr = JSON.parse(JSON.stringify(report));
      Object.assign(wr, {
        type: 'weekly', id: wid, durationSec: 10200, generatedAt: localIso(new Date(day.setHours(4, 41, 0, 0))), healthScore: Math.max(55, m.healthScore - 3),
        summary: { headline: 'Storage is trending down; one unsigned process keeps returning', bullets: ['Free space dropped 3.1 GB this week.', 'updater.exe appeared in recommendations 7 days in a row.', 'SFC and DISM found no integrity violations.'] },
        ai: { enabled: true, used: true, requests: 6, failures: 0, briefing: 'This week was mostly stable. Disk free space fell steadily, driven by Downloads growth and a stale Windows Update cache. The unsigned updater process was terminated by your blacklist policy on 6 of 7 days, which suggests its scheduled task is still re-launching it; disabling that task would stop the churn. Defender found one low-severity PUA detection, quarantined.', patterns: [{ title: 'Recurring unsigned process', detail: 'updater.exe flagged 7 consecutive days.', evidence: ['recommendation updater: consecutiveDays=7'] }, { title: 'Disk free space declining', detail: 'Free space decreased on 5 of 7 days.', evidence: ['metrics diskFreeGB'] }, { title: 'Repeated service failure', detail: 'WSearch failed on 3 separate days.', evidence: ['serviceFailures>0 on 3 days'] }] },
        weekly: {
          phases: [{ name: 'Preflight', status: 'complete', startedAt: localIso(new Date(day.setHours(2, 0, 0))), finishedAt: localIso(new Date(day.setHours(2, 2, 0))), detail: 'On AC power, 118 GB free.' }, { name: 'Deep system analysis', status: 'complete', startedAt: localIso(new Date(day.setHours(2, 2, 0))), finishedAt: localIso(new Date(day.setHours(4, 20, 0))), detail: 'Full Defender scan, DISM, SFC, storage scan.' }, { name: 'AI analysis', status: 'complete', startedAt: localIso(new Date(day.setHours(4, 20, 0))), finishedAt: localIso(new Date(day.setHours(4, 35, 0))), detail: '6 requests.' }, { name: 'Weekly report', status: 'complete', startedAt: localIso(new Date(day.setHours(4, 35, 0))), finishedAt: localIso(new Date(day.setHours(4, 41, 0))), detail: '' }, { name: 'Shutdown preparation', status: 'complete', startedAt: localIso(new Date(day.setHours(4, 59, 0))), finishedAt: localIso(new Date(day.setHours(5, 0, 0))), detail: 'Windows shutdown initiated.' }],
          trends: { diskFreeDeltaGB: -3.1, avgCpuPct: 24.6, avgRamPct: 66.2 }, recurring: [{ title: 'updater.exe flagged', days: 7, detail: 'Unsigned process from Temp.' }, { title: 'WSearch service failed', days: 3, detail: 'Windows Search stopped unexpectedly.' }], unresolved: recs.filter((r) => r.status === 'open').map((r) => r.id), shutdown: { planned: true, initiated: true, reason: 'Scheduled weekly shutdown' },
        },
      });
      wr.sections.windowsHealth.sfc = { ran: true, result: 'No integrity violations' };
      wr.sections.windowsHealth.dism = { ran: true, result: 'Healthy', detail: 'No component store corruption detected.' };
      wr.sections.windowsHealth.componentStore = { reclaimable: '1.8 GB' };
      wr.sections.defender.scan = { ran: true, result: 'Clean', durationSec: 5400, threats: [] };
      wr.sections.diskHealth = [{ drive: 'C:', model: 'NVMe KBG50ZNS512G', mediaType: 'SSD', health: 'Healthy', wearPct: 4 }];
      wr.sections.fileSystem = { C: { chkdsk: 'No problems found', dirty: false } };
      w(`reports/weekly/${wid}/report.json`, wr);
      w(`reports/weekly/${wid}/report.html`, `<!doctype html><meta charset="utf-8"><title>Weekly ${wid}</title><body style="font:14px Segoe UI;margin:24px"><h1>Weekly report ${wid}</h1><p>${wr.summary.headline}</p></body>`);
      weeklyReports.push(wr);
      addAct(new Date(day.setHours(5, 0, 5)), 'shutdown', 'shutdown.initiated', { runType: 'weekly', reason: 'Scheduled weekly shutdown' });
    }
  }
  addAct(new Date(now - 3600000), 'process', 'process.blacklisted', { actor: 'user', target: 'updater', reason: 'Re-launches from Temp every login' });
  addAct(new Date(now - 1800000), 'process', 'process.kill', { actor: 'user', target: 'Discord (PID 4812)', reason: 'User clicked Kill once', result: 'failure', severity: 'error', error: 'Access is denied' });
  actions.sort((a, b) => a.ts.localeCompare(b.ts));
  w('data/metrics/metrics.jsonl', metrics.map((m) => JSON.stringify(m)).join('\n') + '\n');
  w('data/actions/actions.jsonl', actions.map((a) => JSON.stringify(a)).join('\n') + '\n');
  w('data/state/ai-usage.jsonl', aiUsage.map((a) => JSON.stringify(a)).join('\n') + '\n');
  const lastD = dailyReports[dailyReports.length - 1]; const lastW = weeklyReports[weeklyReports.length - 1];
  lastD.actions = actions.filter((a) => a.runType === 'daily').slice(-8);
  w('data/latest/daily.json', lastD);
  if (lastW) w('data/latest/weekly.json', lastW);
  w('data/state/run-state.json', { lastDaily: { startedAt: lastD.generatedAt, finishedAt: lastD.generatedAt, status: 'complete' }, lastWeekly: lastW ? { startedAt: lastW.generatedAt, finishedAt: lastW.generatedAt, status: 'complete' } : null, running: null });
  return { dir, days, reports: dailyReports.length + weeklyReports.length };
}

module.exports = { makeFixtures };
if (require.main === module) {
  const dir = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'guardian-fixtures'));
  console.log(JSON.stringify(makeFixtures(dir, Number(process.argv[3]) || 45)));
}
