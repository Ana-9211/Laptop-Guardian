'use strict';
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Fixed-script PowerShell runner. `script` is a relative path chosen by bridge code (never user input);
 * user data only ever travels as discrete argv entries bound to declared parameters, or via stdin.
 */
function makeRunner(root) {
  const psDir = path.join(root, 'src', 'powershell');
  const resolve = (rel) => path.join(psDir, rel);

  function exists(rel) { return fs.existsSync(resolve(rel)); }

  function run(rel, args = [], { stdin, timeoutMs = 60000 } = {}) {
    return new Promise((res) => {
      if (!exists(rel)) return res({ ok: false, missing: true, error: `script not installed: ${rel}` });
      const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(rel), ...args.map(String)];
      const child = execFile('powershell.exe', argv, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GUARDIAN_ROOT: root } }, (err, stdout, stderr) => {
        const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
        let json = null;
        for (let i = lines.length - 1; i >= 0 && !json; i--) {
          try { json = JSON.parse(lines[i]); } catch { /* keep looking */ }
        }
        if (!json) {
          // whole stdout may be pretty-printed multi-line JSON
          try { json = JSON.parse(String(stdout).trim()); } catch { /* ignore */ }
        }
        if (err && !json) return res({ ok: false, error: err.killed ? 'script timed out' : (String(stderr).trim().split('\n')[0] || err.message) });
        res({ ok: true, data: json || {} });
      });
      if (stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
    });
  }

  /** Start Daily/Weekly agent detached so it outlives the request. */
  function launch(rel, args = []) {
    if (!exists(rel)) return { ok: false, missing: true, error: `script not installed: ${rel}` };
    const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(rel), ...args];
    const child = spawn('powershell.exe', argv, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, GUARDIAN_ROOT: root } });
    child.on('error', () => {});
    child.unref();
    return { ok: true, pid: child.pid };
  }

  return { run, launch, exists };
}

module.exports = { makeRunner };
