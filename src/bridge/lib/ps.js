'use strict';
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const SYSTEM32 = path.join(process.env.SystemRoot || 'C:/Windows', 'System32');
const POWERSHELL = process.platform === 'win32' ? path.join(SYSTEM32, 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
const TASKKILL = path.join(SYSTEM32, 'taskkill.exe');
/** At most this many PowerShell children at once, so a burst of dashboard requests cannot fork-bomb the laptop. */
const MAX_CONCURRENT = 3;

/**
 * Fixed-script PowerShell runner. `script` is a relative path chosen by bridge code (never user input);
 * user data only ever travels as discrete argv entries bound to declared parameters, or via stdin.
 */
function makeRunner(root, dataRoot = root) {
  // `root` is where the program files are; `dataRoot` is where config, data, reports and logs live (the same folder in a checkout).
  const psDir = path.join(root, 'src', 'powershell');
  const resolve = (rel) => path.join(psDir, rel);
  let active = 0;
  const waiting = [];

  function exists(rel) { return fs.existsSync(resolve(rel)); }

  function killTree(pid) {
    // execFile's own timeout only ends the shell; the tree (dism, sfc, child scripts) must go too.
    try { execFile(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch { /* already gone */ }
  }

  function runNow(rel, args, { stdin, timeoutMs }) {
    return new Promise((res) => {
      const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(rel), ...args.map(String)];
      let timedOut = false;
      // stdout is decoded as UTF-8 on purpose: every script sets [Console]::OutputEncoding to UTF-8 (Common/Encoding.ps1). A byte-order mark is dropped.
      const child = execFile(POWERSHELL, argv, { windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GUARDIAN_ROOT: dataRoot } }, (err, stdout, stderr) => {
        clearTimeout(timer);
        stdout = String(stdout || '').replace(/^\uFEFF/, '');
        const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
        let json = null;
        for (let i = lines.length - 1; i >= 0 && !json; i--) {
          try { json = JSON.parse(lines[i]); } catch { /* keep looking */ }
        }
        if (!json) {
          // whole stdout may be pretty-printed multi-line JSON
          try { json = JSON.parse(String(stdout).trim()); } catch { /* ignore */ }
        }
        const exitCode = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
        const firstErr = String(stderr).trim().split('\n')[0];
        if (err && !json) return res({ ok: false, exitCode, error: timedOut ? 'script timed out' : (firstErr || err.message) });
        // A non-zero exit or a timeout is a failure even when partial JSON was printed first.
        if (err) return res({ ok: false, exitCode, data: json, error: timedOut ? 'script timed out' : (json && json.error) || firstErr || `script exited with code ${exitCode}` });
        res({ ok: true, exitCode, data: json || {} });
      });
      const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
      if (stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
    });
  }

  function pump() {
    while (active < MAX_CONCURRENT && waiting.length) {
      const job = waiting.shift();
      active++;
      runNow(job.rel, job.args, job.opts).then(job.resolve).finally(() => { active--; pump(); });
    }
  }

  function run(rel, args = [], { stdin, timeoutMs = 60000 } = {}) {
    if (!exists(rel)) return Promise.resolve({ ok: false, missing: true, error: `script not installed: ${rel}` });
    return new Promise((resolve) => { waiting.push({ rel, args, opts: { stdin, timeoutMs }, resolve }); pump(); });
  }

  /** Start Daily/Weekly agent detached so it outlives the request. */
  function launch(rel, args = []) {
    if (!exists(rel)) return { ok: false, missing: true, error: `script not installed: ${rel}` };
    const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(rel), ...args];
    const child = spawn(POWERSHELL, argv, { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, GUARDIAN_ROOT: dataRoot } });
    child.on('error', () => {});
    child.unref();
    return { ok: true, pid: child.pid };
  }

  /**
   * A long-lived script whose stdout is read as it arrives (the Deep Network Guard sampler). Same fixed-script rule as run(): only a script under
   * src/powershell, only argv. The caller gets { kill } and must call it; kill ends the whole process tree.
   */
  function stream(rel, args = [], { onData = () => {}, onExit = () => {} } = {}) {
    if (!exists(rel)) return { ok: false, missing: true, error: `script not installed: ${rel}` };
    const argv = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', resolve(rel), ...args.map(String)];
    const child = spawn(POWERSHELL, argv, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, GUARDIAN_ROOT: dataRoot } });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
    let done = false; const finish = () => { if (!done) { done = true; onExit(); } };
    child.on('error', finish); child.on('exit', finish);
    return { ok: true, pid: child.pid, kill: () => { try { execFile(TASKKILL, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch { /* ignore */ } try { child.kill(); } catch { /* ignore */ } } };
  }

  return { run, launch, stream, exists, _stats: () => ({ active, waiting: waiting.length }) };
}

module.exports = { makeRunner, MAX_CONCURRENT };
