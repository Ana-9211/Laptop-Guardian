/** Timing and threshold constants shared by the dashboard. One place so nothing is a magic number. */
export const POLL_MS = {
  idle: 10_000,       // nothing running
  scan: 4_000,        // a scan is running: keep the live banner fresh
  offline: 10_000,    // bridge unreachable: keep trying quietly
  elevation: 2_000,   // waiting for the user to answer a UAC prompt, or Task Scheduler still loading
} as const;
/** Data queries (reports, recommendations, ...) are also reloaded this often while idle and visible. */
export const DATA_RELOAD_MS = 60_000;
/** Status older than this (for example the tab was hidden) is shown as stale until the next poll lands. */
export const STALE_AFTER_MS = 45_000;
/** Delays for re-checking status right after starting a scan: the agent writes its run marker a moment later. */
export const SCAN_START_RECHECK_MS = [1_500, 4_000] as const;
export const TOAST_MS = { default: 4_500 } as const;
export const MAX_TOASTS = 4;
export const CLOCK_TICK_MS = { fast: 1_000, relative: 5_000, slow: 30_000 } as const;
/** How often the confirmation dialog checks on an elevated run (Windows prompt answered? finished?). */
export const ACTION_POLL_MS = 2_000;
