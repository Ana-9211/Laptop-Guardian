// Developer helper: finds what makes a page wider than the viewport.
//   node tests/browser/find-overflow.mjs <page> [width]        fixture data
//   REAL=1 node tests/browser/find-overflow.mjs <page> [width]  read-only against this installation's data
// It hides each element in turn and reports the ones whose removal removes the horizontal overflow.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { startBridge, fakeRunner, findBrowser, task } = require('../lib/harness.js');
const { createApp } = require('../../src/bridge/server.js');

const [id = 'weekly', width = '390'] = process.argv.slice(2);
const REAL = process.env.REAL === '1';

async function startTarget() {
  if (REAL) {
    const app = createApp(repo, { pidFile: false });
    const port = await new Promise((r) => app.listen_(0, r));
    return { port, token: app.token, close: () => app.close() };
  }
  const ps = fakeRunner({ 'Scheduler.ps1': () => ({ ok: true, data: { tasks: [task({})] } }) });
  const b = await startBridge({ ps, withDist: false, opts: { dist: path.join(repo, 'src', 'dashboard', 'dist') } });
  return { port: b.port, token: b.app.token, close: () => b.close() };
}

const target = await startTarget();
const browser = await chromium.launch({ executablePath: findBrowser() });
const ctx = await browser.newContext({ viewport: { width: Number(width), height: 800 } });
await ctx.addInitScript((t) => { try { window.sessionStorage.setItem('guardian-session', t); } catch { /* none */ } }, target.token);   // every API call needs the session token
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${target.port}/#/${id}`);
await page.waitForSelector('main .page');
await page.waitForLoadState('networkidle');
if (REAL) await page.waitForTimeout(8000); // real Task Scheduler rows take a few seconds
const report = await page.evaluate(() => {
  const vw = window.innerWidth;
  const docWidth = () => document.documentElement.scrollWidth;
  const culprits = [];
  if (docWidth() > vw + 1) {
    for (const el of document.querySelectorAll('main *')) {
      const previous = el.style.display;
      el.style.display = 'none';
      if (docWidth() <= vw + 1) culprits.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}: ${(el.textContent || '').trim().slice(0, 60)}`);
      el.style.display = previous;
    }
  }
  return { vw, doc: docWidth(), culprits: culprits.slice(-8) };
});
console.log(`viewport ${report.vw}px, document ${report.doc}px`);
console.log(report.culprits.length ? `removing any of these fixes it (innermost last):\n${report.culprits.join('\n')}` : 'no horizontal overflow');
await browser.close();
target.close();
