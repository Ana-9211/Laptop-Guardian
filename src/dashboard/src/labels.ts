/**
 * Plain-language names for the codes the bridge and agents use. The raw code is still available where precision matters
 * (the "Exact action" section, the logs); everywhere else people read these.
 */
const KIND: Record<string, string> = {
  process: 'Program', file: 'File', system: 'Windows', storage: 'Storage', security: 'Security', startup: 'Startup entry',
  service: 'Service', task: 'Scheduled task', network: 'Network', health: 'Health', firewall: 'Firewall', defender: 'Defender',
};
const FLAG: Record<string, string> = {
  'high-cpu': 'Uses a lot of CPU', 'high-memory': 'Uses a lot of memory', persistent: 'Starts with Windows', 'unusual-location': 'Runs from an unusual folder',
  duplicate: 'Several copies running', 'no-publisher': 'No publisher information', unsigned: 'Not digitally signed', blacklisted: 'On your blacklist', whitelisted: 'On your whitelist',
};
const CLASS: Record<string, string> = {
  KEEP: 'Keep', REVIEW: 'Worth a look', LIKELY_UNNECESSARY: 'Probably not needed', HIGH_RISK: 'Risky to remove', UNKNOWN: 'Unknown',
};
const PROCESS_CLASS: Record<string, string> = {
  'windows-component': 'Part of Windows', 'known-application': 'Known program', 'third-party-service': 'Third-party service', 'driver-utility': 'Driver or hardware tool',
  'user-application': 'Program you installed', 'development-tool': 'Developer tool', 'security-software': 'Security software', unknown: 'Not recognised',
  'potentially-unwanted': 'Possibly unwanted', suspicious: 'Looks suspicious',
};

export const kindLabel = (k?: string | null) => (k ? KIND[k] ?? k : '');
export const flagLabel = (f: string) => FLAG[f] ?? f;
export const classLabel = (c?: string | null) => (c ? CLASS[c] ?? c.replace(/_/g, ' ').toLowerCase() : '');
export const processClassLabel = (c?: string | null) => (c ? PROCESS_CLASS[c] ?? c : 'Not classified');
/** "73%" alone says little: say how sure Guardian is, keeping the number for those who want it. */
export const confidenceLabel = (c?: number | null) => {
  const v = Math.round((c ?? 0) * 100);
  return `${v >= 80 ? 'High' : v >= 50 ? 'Medium' : 'Low'} confidence (${v}%)`;
};
