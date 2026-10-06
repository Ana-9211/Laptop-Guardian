'use strict';
/**
 * The connection sampler for Deep Network Guard: ONE long-lived PowerShell process (Network/Stream-Connections.ps1) that prints a JSON line per
 * sample from Get-NetTCPConnection and Get-NetUDPEndpoint. Unlike scraping netstat this does not depend on the Windows display language, and it
 * avoids a PowerShell start per sample. It is restarted with a backoff when it dies, gives up after too many restarts (the caller then falls back
 * to netstat), and is always killed on stop. It is not part of the three-process cap used for request/response scripts: there is only ever one.
 */
const MAX_LINE = 6 * 1024 * 1024;
const MAX_ROWS = 20000;
const MAX_RESTARTS = 5;           // within RESTART_WINDOW_MS
const RESTART_WINDOW_MS = 5 * 60000;

/** Display form used everywhere else: "TimeWait" -> "Time Wait", "FinWait2" -> "Fin Wait 2". */
const stateText = (s) => String(s || '').replace(/([a-z])([A-Z0-9])/g, '$1 $2');

/** One sample line to { at, rows, names }, or null when the line is not a valid sample. Pure. */
function parseSampleLine(line) {
  let j; try { j = JSON.parse(line); } catch { return null; }
  if (!j || !Array.isArray(j.rows)) return null;
  const rows = [];
  for (const r of j.rows.slice(0, MAX_ROWS)) {
    if (!r || (r.proto !== 'TCP' && r.proto !== 'UDP')) continue;
    rows.push({ proto: r.proto, localAddress: String(r.localAddress || ''), localPort: Number(r.localPort) || 0, remoteAddress: String(r.remoteAddress || ''), remotePort: Number(r.remotePort) || 0, state: stateText(r.state), pid: Number(r.pid) || 0 });
  }
  const names = new Map(Object.entries(j.names || {}).map(([k, v]) => [Number(k), String(v)]));
  return { at: Date.parse(j.t) || null, rows, names };
}

function createSampler({ ps, intervalSec = 5, log = () => {}, now = Date.now, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout }) {
  let handle = null; let running = false; let last = null; let restarts = []; let retryTimer = null; let gaveUp = false;

  function spawn() {
    if (!running || !ps.stream) return;
    let buf = '';
    const h = ps.stream('Network/Stream-Connections.ps1', ['-IntervalSec', String(intervalSec), '-ParentPid', String(process.pid)], {
      onData: (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
          if (!line) continue;
          const s = parseSampleLine(line);
          if (s) last = { ...s, receivedAt: now() };
        }
        if (buf.length > MAX_LINE) buf = '';   // a runaway line is dropped, never buffered without limit
      },
      onExit: () => {
        handle = null;
        if (!running) return;
        const t = now(); restarts = restarts.filter((x) => t - x < RESTART_WINDOW_MS); restarts.push(t);
        if (restarts.length > MAX_RESTARTS) { gaveUp = true; log({ category: 'network', action: 'network.deep.sampler-gave-up', result: 'failure', severity: 'warning', reason: 'The connection sampler kept stopping; Deep Network Guard now uses the slower netstat fallback.' }); return; }
        retryTimer = setTimeoutFn(spawn, Math.min(30000, 1000 * 2 ** (restarts.length - 1)));
        if (retryTimer && retryTimer.unref) retryTimer.unref();
      },
    });
    if (!h || h.missing) { gaveUp = true; return; }
    handle = h;
  }

  return {
    start() { if (running) return; running = true; gaveUp = false; restarts = []; last = null; spawn(); },
    stop() { running = false; if (retryTimer) { clearTimeoutFn(retryTimer); retryTimer = null; } if (handle) { try { handle.kill(); } catch { /* already gone */ } handle = null; } last = null; },
    /** The newest sample if it is fresh enough to trust, else null. */
    latest(maxAgeMs = intervalSec * 3000) { return last && now() - last.receivedAt <= maxAgeMs ? last : null; },
    status: () => ({ running, alive: !!handle, gaveUp, restarts: restarts.length }),
  };
}

module.exports = { createSampler, parseSampleLine, stateText };
