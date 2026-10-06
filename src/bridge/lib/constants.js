'use strict';
// Numbers and patterns shared by the bridge's modules.
const VERSION = '1.1.0';

const MAX_BODY = 64 * 1024;
const METRICS_RAW_DAYS = 180;   // defaults for retention.metricsRawDays and retention.auditRawDays (Settings can change them, 30 to 730)
const AUDIT_RAW_DAYS = 90;
const SCHED_CACHE_MS = 30000; // how long Task Scheduler rows are served before a background refresh
const SCHED_WAITING_MS = 5000; // faster refresh while a UAC prompt is outstanding
const SCHED_READ_RETRIES = 2;
const ELEVATION_WAIT_MS = 120000; // how long the UI waits for the user to answer the UAC prompt
const ELEVATION_TIMEOUT_MS = 120000;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
const RE_DAILY = /^\d{4}-\d{2}-\d{2}$/;
const RE_WEEKLY = /^\d{4}-W\d{2}$/;
const LISTS = ['blacklist', 'whitelist', 'ignored'];
const REC_STATUSES = ['open', 'dismissed', 'ignored', 'resolved', 'actioned'];

module.exports = { METRICS_RAW_DAYS, AUDIT_RAW_DAYS, VERSION, MAX_BODY, SCHED_CACHE_MS, SCHED_WAITING_MS, SCHED_READ_RETRIES, ELEVATION_WAIT_MS, ELEVATION_TIMEOUT_MS, MIME, RE_DAILY, RE_WEEKLY, LISTS, REC_STATUSES };
