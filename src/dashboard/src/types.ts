// Mirrors docs/DATA-CONTRACT.md. Every field may be absent at runtime; render defensively.
export type Risk = 'LOW' | 'MEDIUM' | 'HIGH' | 'UNKNOWN';

export interface Metric {
  healthReasons?: string[];
  ts: string; runType?: string; cpuPct?: number; ramPct?: number; ramUsedGB?: number; ramTotalGB?: number;
  diskUsedPct?: number; diskFreeGB?: number; diskTotalGB?: number; diskFreePct?: number;
  processCount?: number; flaggedCount?: number; recommendationCount?: number; actionCount?: number; errorCount?: number;
  startupCount?: number; serviceFailures?: number; batteryPct?: number | null; downloadsGB?: number;
  defenderSigAgeDays?: number | null; defenderThreats?: number; healthScore?: number;
}
export interface StartupEntry { kind: string; name: string; location?: string; command?: string; publisher?: string | null }
export interface Process {
  name: string; pid: number; path: string | null; commandLine?: string | null; parentPid?: number; parentName?: string | null;
  cpuPct: number; cpuSeconds?: number; memoryMB: number; startTime?: string | null; publisher?: string | null;
  signature?: string; signed?: boolean; services?: string[]; startupEntries?: StartupEntry[]; scheduledTasks?: string[];
  persistent?: boolean; user?: string | null; pathClass?: string; classification?: string; instances?: number;
  flags?: string[]; policy?: 'blacklist' | 'whitelist' | 'ignored' | 'none'; recommendationId?: string | null;
}
export interface Cmd { command: string; explains: string; risk: Risk | string; requiresAdmin: boolean; reversible: boolean }
export interface AiAnalysis {
  classification?: string; what_is_it?: string; why_flagged?: string; risk?: string; persistence?: string; suggested_action?: string;
  temporary_stop_method?: string; persistence_removal_method?: string; consequences?: string; confidence?: number;
  evidence?: string[]; warnings?: string[]; analyzedAt?: string; model?: string; validated?: boolean;
}
export interface Recommendation {
  id: string; kind: string; title: string; status: string; risk: Risk; severity: string; confidence: number; source?: string;
  firstSeen?: string; lastSeen?: string; occurrences?: number; consecutiveDays?: number;
  target?: { name: string; pid?: number; path?: string | null } | null;
  identity?: { name?: string; pid?: number; path?: string | null; publisher?: string | null; signature?: string; parent?: string | null; service?: string | null } | null;
  whatIsIt?: string; whyFlagged?: string[]; persistence?: { persistent: boolean; mechanisms: { kind: string; name: string; location?: string }[] };
  suggestedAction?: string; stopCommand?: Cmd | null; preventRestart?: Cmd | null; consequences?: string; ai?: AiAnalysis | null;
}
export interface FileCandidate {
  id: string; path: string; name: string; sizeMB: number; lastModified?: string; lastAccessed?: string | null; ageDays?: number; extension?: string;
  classification: 'KEEP' | 'REVIEW' | 'LIKELY_UNNECESSARY' | 'HIGH_RISK' | 'UNKNOWN'; category?: string; whatIsIt?: string; whyFlagged?: string[];
  duplicateOf?: string | null; referencedBySoftware?: boolean | null; ifDeleted?: string; risk?: string; recommendedAction?: string; ignored?: boolean;
}
export interface FilesData {
  generatedAt: string | null; drives?: { drive: string; totalGB: number; freeGB: number; type?: string }[]; candidates: FileCandidate[];
  largest?: { path: string; sizeMB: number; lastModified?: string }[]; duplicates?: { hash?: string; sizeMB?: number; files: string[] }[];
  downloads?: { count?: number; sizeGB?: number; oldCount?: number };
}
export interface ActionEvent {
  archived?: boolean;
  id: string; ts: string; category: string; severity: 'info' | 'warning' | 'error' | string; action: string; target?: string | null; result?: string;
  actor?: string; reason?: string | null; relatedRecommendation?: string | null; error?: string | null; runType?: string | null;
}
export interface PolicyEntry {
  id: string; name: string; path?: string | null; reason?: string; addedAt?: string; addedBy?: string; enabled: boolean; action?: string;
  terminatedCount?: number; lastTerminatedAt?: string | null; disabledUntil?: string | null;
}
export interface Policy { blacklist: PolicyEntry[]; whitelist: PolicyEntry[]; ignored: PolicyEntry[] }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;
export interface Report {
  schema?: string; type: 'daily' | 'weekly'; id: string; generatedAt: string; durationSec?: number; status: string; incomplete?: string[];
  healthScore?: number; healthReasons?: string[]; host?: { name?: string; user?: string; os?: string; build?: string };
  summary?: { headline?: string; bullets?: string[] }; sections?: Any; recommendations?: string[]; actions?: ActionEvent[];
  errors?: { ts: string; source: string; message: string }[];
  ai?: { enabled?: boolean; used?: boolean; requests?: number; failures?: number; briefing?: string | null; patterns?: { title: string; detail: string; evidence?: string[] }[] };
  weekly?: Any;
}
export interface ReportRow { type: 'daily' | 'weekly'; id: string; generatedAt: string; status: string; healthScore?: number; summary?: { headline?: string; bullets?: string[] }; sizeKB?: number; hasHtml?: boolean }
export interface Safety { safeMode: boolean; autoKillBlacklisted: boolean; automationPaused: boolean; weeklyShutdown: boolean }
export interface Overview {
  daily: Report | null; weekly: Report | null; metrics: Metric[]; next: { daily: string | null; weekly: string | null; shutdown: string | null };
  safety: Safety; ai: { enabled: boolean; keyConfigured: boolean; model: string };
  run: RunInfo; openRecommendations: number;
}
export type Level = 'ok' | 'info' | 'warn' | 'crit';
export interface TaskRow {
  kind: 'daily' | 'weekly' | 'dashboard'; name: string; state: string; status: string; level: Level; summary: string; issues: string[];
  nextRun: string | null; lastRun: string | null; runLevel: string | null; trigger: string | null;
  lastResult: { code: number | null; hex: string | null; text: string; kind: string };
  /** needed: the task no longer matches Settings or can be improved; requiresElevation: only an administrator (UAC) registration can fix it. */
  repair: { needed: boolean; requiresElevation: boolean };
}
export interface ScheduleApplyResult {
  registered: boolean; needsElevation: boolean; elevationRequested: boolean; message: string;
  report: { kind: string; outcome: string; detail?: string }[];
}
export interface ScheduleSaveResult extends ScheduleApplyResult { saved: boolean; changed: boolean }
export interface AttentionAction { actionId: string; label: string; params: Record<string, string | number> }
export interface AttentionItem { id: string; level: Exclude<Level, 'ok'>; title: string; detail: string; href: string | null; cta: string | null; actions: AttentionAction[]; noAction: string | null; manualNote: string | null }
export interface RunInfo {
  lastDaily?: Any; lastWeekly?: Any; stale?: { type: string; phase?: string; startedAt?: string } | null;
  running?: { type: string; phase?: string; startedAt?: string; mode?: 'scheduled' | 'manual'; shutdownPossible?: boolean; elapsedSec?: number | null } | null;
}
export interface StatusData {
  now: string;
  bridge: { ok: boolean; pid: number; version: string; startedAt: string; restartNeeded?: boolean; port: number; uptimeSec: number };
  run: RunInfo;
  lastAction: ActionEvent | null;
  actions24h: { total: number; warnings: number; errors: number; lastError: { ts: string; action: string; error?: string | null } | null };
  reports: { daily: { id: string; generatedAt: string; status: string; healthScore?: number } | null; weekly: { id: string; generatedAt: string; status: string; healthScore?: number } | null; counts: { daily: number; weekly: number } };
  snapshots: { processes: { generatedAt: string | null; count: number } | null; files: { generatedAt: string | null; candidates: number } | null };
  schedule: { tasks: TaskRow[]; fetchedAt: string | null; error: string | null; pending?: boolean; level: Level; elevationPending: { since: string } | null };
  next: { daily: string | null; weekly: string | null };
  shutdown: { armed: boolean; target: string | null; pending: { at: string; initiatedAt: string; cancelCommand: string } | null; cancelCommand: string; note: string };
  safety: Safety; ai: { enabled: boolean; keyConfigured: boolean; model: string }; openRecommendations: number;
  attention: AttentionItem[];
  network: { deepActive: boolean; deepSince: string | null; lastSnapshotAt: string | null; dnsFiltering: boolean };
}
export interface Config {
  schemaVersion: number; bridge: { host: string; port: number };
  schedule: { daily: { enabled: boolean; time: string }; weekly: { enabled: boolean; day: string; time: string; shutdownTime: string; shutdownEnabled: boolean } };
  safety: Safety;
  ai: { enabled: boolean; model: string; maxRequestsPerRun: number; maxProcessesPerRun: number; dailyTokenBudget: number };
  cleanup: { tempFiles: boolean; crashDumps: boolean; caches: boolean; recycleBin: string; tempMinAgeDays: number };
  storage: { drives: string[]; excludedDirs: string[]; protectedDirs: string[]; minLargeFileMB: number; oldFileDays: number; duplicateScan: boolean; duplicateMinMB: number };
  thresholds: { cpuPct: number; memoryMB: number; diskFreeWarnPct: number; diskFreeCritPct: number };
  retention: { reportsDays: number; metricsRawDays: number; auditRawDays: number };
  network?: { snapshot: { auto: boolean; everyMinutes: number; retentionDays: number; maxMB: number }; deep: { enabled: boolean; sampleSec: number; retentionDays: number; maxMB: number }; dnsFiltering: { enabled: boolean } } & Record<string, unknown>;
  _ai?: { enabled: boolean; keyConfigured: boolean; model: string };
}

/* ---------- Action Center / remediation ---------- */
export type AdminNeed = 'yes' | 'no' | 'maybe';
export interface ActionOffer {
  actionId: string; label: string; category: string; risk: Risk | string; reversible: boolean; long: boolean; admin: AdminNeed;
  summary: string; consequences: string; undo: string; params: Record<string, string | number>; requiredAcks: string[];
  eligible: boolean; ineligibleReason: string | null;
}
export interface HistoryItem {
  id: string; ts: string; actionId: string; label: string; category: string; target: string | null; result: string; severity: string;
  message: string | null; error: string | null; verified: boolean; elevated: boolean; canUndo: boolean; undo: { action: string; params: Record<string, string> } | null;
}
export interface Finding {
  id: string; source: string; kind: string; title: string; what: string; why: string[]; evidence: { label: string; value: string }[];
  risk: Risk | string; confidence: number; consequences: string | null; ai?: AiAnalysis | null; recommendationId?: string;
  actions: ActionOffer[]; manual: { label: string; href: string; reason: string } | null;
  investigate: { label: string; href: string }; attempts: HistoryItem[];
}
export interface RevoInfo { available: boolean; target?: string | null; version?: string | null; reason?: string | null; supportedOptions?: string }
export interface Plan extends ActionOffer {
  token: string; ok: true; adminRequired: boolean; identityKey: string; details: Record<string, unknown> | null; warnings: string[]; expiresAt: string; confirmLabel: string; typedConfirmation?: string | null;
}
export interface ExecResult { ok: boolean; message?: string; errors?: string[]; verified?: boolean; details?: Record<string, unknown> | null; undo?: { action: string; params: Record<string, string> } | null; needsElevation?: boolean }
export type ExecStatus = 'done' | 'done-unverified' | 'failed' | 'declined' | 'needs-elevation' | 'awaiting-permission' | 'running' | 'lost' | 'awaiting-schedule-permission';
export interface ExecResponse { status: ExecStatus; result?: ExecResult; message?: string; ticket?: string; plan?: Plan | null; actionId?: string; long?: boolean }

/* ---------- Network Guard ---------- */
export interface NetProcess { name: string; path: string | null; signed: boolean | null; publisher: string | null; owner?: string | null; startTime?: string | null; persistent: boolean }
export interface NetConnection { proto: 'TCP' | 'UDP'; state: string; localAddress: string; localPort: number; remoteAddress: string; remotePort: number; pid: number; created?: string | null; process: NetProcess }
export interface NetFirewallRule { name: string; displayName: string; enabled: boolean; direction: string; action: string; program: string; protocol: string; localPort: string; remoteAddress: string; description: string; createdAt: string | null; expiresAt: string | null; expired: boolean }
export interface NetSnapshot {
  generatedAt: string; durationMs: number; elevated: boolean; connections: NetConnection[]; udp: { proto: 'UDP'; localAddress: string; localPort: number; pid: number }[];
  processes: Record<string, { name: string; path: string | null; signed: boolean | null; publisher: string | null }>;
  dnsConfig?: { interfaces: { index: number; alias: string; dhcp: boolean; dnsServers: string[] }[]; doh: { server: string; template: string }[] } | null;
  dns: { name: string; type: string; data: string; ttl: number }[];
  firewall: { profiles: { name: string; enabled: boolean; defaultInboundAction: string; defaultOutboundAction: string }[]; rules: NetFirewallRule[] };
  identity: { gateway: string[]; dns: string[]; dhcp: string[] }; errors: string[];
}
export interface DeepStatus { active: boolean; enabled: boolean; startedAt: string | null; lastSampleAt: string | null; eventsThisSession: number; tracking: number; storageMB: number; storageBytes: number; files: number; retentionDays: number; maxMB: number; sampleSec: number }
export interface DeepEvent { ts: string; type: 'open' | 'close'; proto: string; localAddress: string; localPort: number; remoteAddress: string; remotePort: number; state: string; pid: number; process: string | null; durationSec?: number }
export interface NetworkSettings { snapshot: { auto: boolean; everyMinutes: number; retentionDays: number; maxMB: number }; deep: { enabled: boolean; retentionDays: number; maxMB: number; sampleSec: number }; dnsFiltering: { enabled: boolean }; thresholds: Record<string, number> }
export interface NetworkCurrent {
  snapshot: NetSnapshot | null; ageSec: number | null; findings: Finding[]; rules: NetFirewallRule[]; deep: DeepStatus;
  dns: { filtering: { enabled: boolean; blocked: string[] }; cache: NetSnapshot['dns']; history: { ts: string; name: string; type: string; data: string }[] };
  settings: NetworkSettings; privacy: string; posture?: { score: number; reasons: { points: number; reason: string }[] } | null;
}
export interface NetHistoryRow { ts: string; established: number; listening: number; remoteAddresses: number; unsignedProcesses: number; dnsEntries: number; findings: number; firewallOff: number; guardianRules: number }

export interface SetupItem { id: string; title: string; detail: string; done: boolean; optional: boolean; unknown?: boolean; action: { actionId: string; label: string; params: Record<string, string | number> } | null; link: string | null }
export interface SetupChecklist { items: SetupItem[]; complete: boolean; remaining: number }
export interface ChangeItem { label: string; from: string; to: string; delta: string; tone: string }
export interface ChangesData { available: boolean; reason?: string; from?: string | null; to?: string | null; items: ChangeItem[] }
export interface DryRunLine { kind: string; label: string; detail: string }
export interface DryRun { safeMode: boolean; wouldDo: DryRunLine[]; wouldNotDo: DryRunLine[]; notes: string[]; basedOn: { scan: string | null; processes: number } }
