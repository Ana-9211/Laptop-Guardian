'use strict';
/** Starts a real bridge on an ephemeral port over a fixture data tree, with an injectable PowerShell runner. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { makeFixtures } = require('../fixtures/make-fixtures');
const { createApp } = require('../../src/bridge/server');

const MUTATION_HEADERS = { 'X-Guardian': '1', 'Content-Type': 'application/json' };

/** A PowerShell runner double. `handlers` maps a script name to (args) => result; every call is recorded in `calls`. */
function fakeRunner(handlers = {}) {
  const calls = [];
  return {
    calls,
    exists: () => true,
    launch: () => ({ ok: true, pid: 0 }),
    async run(rel, args = []) {
      calls.push({ rel, args });
      const h = handlers[rel];
      return h ? h(args, calls.length) : { ok: false, missing: true, error: `script not installed: ${rel}` };
    },
  };
}

async function startBridge({ ps, days = 20, opts = {}, withDist = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-harness-'));
  makeFixtures(root, days);
  const dist = path.join(root, 'dist');
  if (withDist) { fs.mkdirSync(dist); fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>x</title>'); }
  const app = createApp(root, { dist, pidFile: false, ps, ...opts });
  const port = await new Promise((r) => app.listen_(0, r));
  const req = (method, p, body, headers = MUTATION_HEADERS) => new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : undefined;
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}`, Authorization: `Bearer ${app.token}`, ...(method === 'GET' ? {} : headers) } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, json, text }); });
    });
    r.on('error', reject); if (data !== undefined) r.write(data); r.end();
  });
  return {
    root, port, app,
    get: (p) => req('GET', p),
    post: (p, b = {}) => req('POST', p, b),
    put: (p, b) => req('PUT', p, b),
    readConfig: () => JSON.parse(fs.readFileSync(path.join(root, 'config', 'config.json'), 'utf8')),
    close: () => { app.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** Locates Edge (or Chrome) from the standard Windows install variables, or EDGE_PATH. No hard-coded drive paths. */
function findBrowser() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
  const rel = [['Microsoft', 'Edge', 'Application', 'msedge.exe'], ['Google', 'Chrome', 'Application', 'chrome.exe']];
  const candidates = [process.env.EDGE_PATH, ...rel.flatMap((r) => roots.map((root) => path.join(root, ...r)))].filter(Boolean);
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) throw new Error('No Edge or Chrome found. Set EDGE_PATH to a browser executable.');
  return hit;
}

const task = (o) => ({ name: 'Daily Audit', kind: 'daily', state: 'Ready', nextRun: null, lastRun: null, lastResult: 0, runLevel: 'Highest', trigger: '2026-10-05T19:00:00+05:30', days: [], scheduledFlag: true, scriptCurrent: true, time: '19:00', ...o });
const weeklyTask = (o) => task({ kind: 'weekly', name: 'Weekly Deep Analysis', trigger: '2026-10-05T02:00:00+05:30', days: ['Saturday'], time: '02:00', ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { startBridge, fakeRunner, findBrowser, task, weeklyTask, sleep };
