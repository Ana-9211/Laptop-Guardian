// Developer helper: lists the elements whose right edge is past the viewport (the widest first). Companion to find-overflow.mjs for
// the case where hiding a single element does not remove the overflow.
//   node tests/browser/wide-elements.mjs <page> [width]
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { startBridge, fakeRunner, findBrowser, task } = require('../lib/harness.js');
const [id = 'overview', width = '390'] = process.argv.slice(2);

const ps = fakeRunner({ 'Scheduler.ps1': () => ({ ok: true, data: { tasks: [task({})] } }) });
const b = await startBridge({ ps, withDist: false, opts: { dist: path.join(repo, 'src', 'dashboard', 'dist') } });
const browser = await chromium.launch({ executablePath: findBrowser() });
const ctx = await browser.newContext({ viewport: { width: Number(width), height: 800 } });
await ctx.addInitScript((t) => { try { window.sessionStorage.setItem('guardian-session', t); } catch { /* none */ } }, b.app.token);
const page = await ctx.newPage();
await page.goto(`http://127.0.0.1:${b.port}/#/${id}`);
await page.waitForSelector('main .page');
await page.waitForLoadState('networkidle');
const rows = await page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  return [...document.querySelectorAll('body *')].map((e) => ({ r: e.getBoundingClientRect(), e }))
    .filter(({ r }) => r.width > 0 && r.right > vw + 0.5)
    .sort((a, b) => b.r.right - a.r.right).slice(0, 12)
    .map(({ r, e }) => `${(r.right - vw).toFixed(1)}px over  ${e.tagName.toLowerCase()}.${String(e.className).split(' ').slice(0, 3).join('.')}  w=${r.width.toFixed(0)}  ${(e.textContent || '').trim().slice(0, 40)}`);
});
console.log(rows.length ? rows.join('\n') : 'nothing is wider than the viewport');
await browser.close(); b.close();
