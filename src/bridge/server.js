'use strict';
/**
 * Laptop Guardian local bridge. Binds 127.0.0.1 only. Serves the built dashboard and a JSON API.
 * Security model: Host allowlist, same-origin + custom-header on mutations, no CORS, fixed PowerShell scripts only.
 * Layout: lib/context.js (shared state), lib/network-context.js, routes/*.js (one file per area), lib/http.js (the request pipeline).
 */
const http = require('http');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const U = require('./lib/util');
const { VERSION } = require('./lib/constants');
const { createContext } = require('./lib/context');
const { createNetworkContext } = require('./lib/network-context');
const { createHandler } = require('./lib/http');
const { runMaintenance } = require('./lib/maintenance');

const ROUTES = ['status', 'reports', 'files', 'settings', 'ai', 'schedule', 'network', 'remediation', 'guidance'];

function createApp(root, opts = {}) {
  const ctx = createContext(root, opts);
  Object.assign(ctx, createNetworkContext(ctx));
  for (const name of ROUTES) require('./routes/' + name)(ctx);   // order matters: the first matching route wins
  const { P, config, log, token, tokenOk, startedAt, state, deep, netTimers, takeSnapshot, queryTasks, currentRun } = ctx;
  /** Housekeeping for the JSONL files (see lib/maintenance.js). Tests call it directly through server.maintenance(). */
  const maintenance = (now) => runMaintenance({ P, log, now, deep, retention: config().retention, running: !!(currentRun() && currentRun().running) });

  const allowedHosts = new Set();
  const handle = createHandler({ routes: ctx.routes, allowedHosts, tokenOk, distDir: P.dist });
  const server = http.createServer((req, res) => { handle(req, res); });
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxConnections = 64;
  server.token = token;
  server.maintenance = maintenance;
  server.listen_ = (port, cb) => {
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      state.boundPort = actual;
      void queryTasks(); // warm the Task Scheduler cache so the first dashboard poll is instant
      if (opts.autoNetwork) {
        if (config().network.deep.enabled) { state.deepStartedAt = U.localIso(); deep.start(); log({ category: 'network', action: 'network.deep.resume', result: 'success', reason: 'Deep Network Guard was on when the bridge started and has resumed.' }); }
        const every = Math.max(5, config().network.snapshot.everyMinutes) * 60000;
        const first = setTimeout(() => { if (config().network.snapshot.auto) takeSnapshot('scheduled').catch(() => {}); }, 30000);
        const loop = setInterval(() => { if (config().network.snapshot.auto) takeSnapshot('scheduled').catch(() => {}); }, every);
        const m1 = setTimeout(() => maintenance(), 90000);
        const m2 = setInterval(() => maintenance(), 24 * 3600 * 1000);
        netTimers.push(first, loop, m1, m2); netTimers.forEach((t) => t.unref && t.unref());
      }
      server.on('close', () => { netTimers.forEach(clearTimeout); netTimers.forEach(clearInterval); deep.stop(); });
      if (opts.pidFile !== false) {
        try {
          U.writeJsonAtomic(P.bridgePid, { app: 'laptop-guardian', pid: process.pid, port: actual, startedAt, version: VERSION, token });
          // Restrict the file to the current user (it holds the session token). Best effort; the launcher also works without it.
          if (process.platform === 'win32' && process.env.USERNAME) execFile(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'icacls.exe'), [P.bridgePid, '/inheritance:r', '/grant:r', (process.env.USERDOMAIN ? process.env.USERDOMAIN + String.fromCharCode(92) : '') + process.env.USERNAME + ':F'], { windowsHide: true }, () => {});
        } catch { /* best effort */ }
        const clear = () => { try { const cur = U.readJson(P.bridgePid); if (cur && cur.pid === process.pid) fs.unlinkSync(P.bridgePid); } catch { /* ignore */ } };
        server.on('close', clear); process.once('exit', clear);
      }
      allowedHosts.clear();
      allowedHosts.add(`127.0.0.1:${actual}`); allowedHosts.add(`localhost:${actual}`);
      if (opts.extraHosts) opts.extraHosts.forEach((h) => allowedHosts.add(h));
      cb && cb(actual);
    });
  };
  return server;
}

module.exports = { createApp };

if (require.main === module) {
  // An installed copy gets its folders from install.json (written by the installer); the environment cannot redirect it.
  const codeRoot = path.resolve(__dirname, '..', '..');
  const install = U.readInstall(codeRoot);
  const root = install ? path.resolve(install.dataRoot) : path.resolve(process.env.GUARDIAN_ROOT || codeRoot);
  const cfg = U.mergeConfig(U.DEFAULT_CONFIG, U.readJson(path.join(root, 'config', 'config.json'), {}) || {}).value;
  const port = Number(process.env.GUARDIAN_PORT) || cfg.bridge.port;
  const dev = process.env.GUARDIAN_DEV_HOST; // e.g. 127.0.0.1:5173 when running Vite dev proxy
  const app = createApp(root, { codeRoot, elevatedDir: install ? path.resolve(install.elevatedDir) : undefined, extraHosts: dev ? [dev] : [], autoNetwork: true });
  app.on('error', (e) => { console.error(`[bridge] ${e.code === 'EADDRINUSE' ? `port ${port} already in use` : e.message}`); process.exit(1); });
  app.listen_(port, (p) => console.log(`Laptop Guardian dashboard: http://127.0.0.1:${p}/  (root: ${root})`));
}
