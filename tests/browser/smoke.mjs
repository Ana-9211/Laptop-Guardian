// Browser smoke test: drives the real built dashboard in Microsoft Edge (via playwright-core) against a bridge
// serving fixture data, with a fake PowerShell runner (no Task Scheduler, no process or file actions).
//   node tests/browser/smoke.mjs            fixture data (default, safe)
//   node tests/browser/smoke.mjs --real     read-only against this installation's real data on a second port
// Screenshots go to tests/browser/out/. Exit code 1 on any failed check, console error or page error.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const { startBridge, fakeRunner, findBrowser, task, weeklyTask } = require('../lib/harness.js');
const { createApp } = require('../../src/bridge/server.js');

const REAL = process.argv.includes('--real');
const OUT = path.join(here, 'out');
fs.mkdirSync(OUT, { recursive: true });
const PAGES = ['overview', 'daily', 'weekly', 'processes', 'files', 'health', 'reports', 'logs', 'recommendations', 'blacklist', 'whitelist', 'settings'];
const failures = [];
const note = (msg) => console.log(msg);
const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };
const check = (cond, msg) => { if (!cond) fail(msg); else note(`  ok   ${msg}`); };

/** Rendered UI text must be plain ASCII (this also catches mojibake and replacement characters). Real data is checked too. */
function badGlyphs(text) {
  const bad = new Set();
  for (const ch of text) if (ch.charCodeAt(0) > 126) bad.add(`U+${ch.codePointAt(0).toString(16).toUpperCase()}`);
  return { chars: [...bad] };
}

async function startTarget() {
  if (REAL) {
    // Read-only second bridge over the real data tree. pidFile:false so the real bridge.json is never touched.
    const app = createApp(repo, { pidFile: false });
    const port = await new Promise((r) => app.listen_(0, r));
    return { port, close: () => app.close(), restart: null, root: repo };
  }
  const ps = fakeRunner({
    'Scheduler.ps1': () => ({ ok: true, data: { tasks: [task({ scheduledFlag: true }), weeklyTask({}), { name: 'Dashboard Bridge', kind: 'dashboard', state: 'Ready', lastResult: 0, runLevel: 'Limited', trigger: null, days: [], scriptCurrent: true }] } }),
  });
  const b = await startBridge({ ps, withDist: false, opts: { dist: path.join(repo, 'src', 'dashboard', 'dist') } });
  return { port: b.port, close: () => b.close(), root: b.root, bridge: b };
}

const target = await startTarget();
const base = () => `http://127.0.0.1:${target.port}/`;
const browser = await chromium.launch({ executablePath: findBrowser(), headless: true });
let exitCode = 0;
try {
  for (const theme of ['dark', 'light']) {
    note(`\n== theme: ${theme}`);
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 880 }, colorScheme: theme });
    await ctx.addInitScript((t) => { try { localStorage.setItem('lg-theme', t); } catch { /* ignore */ } }, theme);
    const page = await ctx.newPage();
    const expected = []; // substrings of console errors caused on purpose by a step
    page.on('console', (m) => { if (m.type() === 'error' && !expected.some((e) => m.text().includes(e))) fail(`[${theme}] console error: ${m.text().slice(0, 160)}`); });
    page.on('pageerror', (e) => fail(`[${theme}] page error: ${e.message.slice(0, 160)}`));

    await page.goto(base());
    await page.waitForSelector('.nav');
    await page.getByText('Checking Task Scheduler').waitFor({ state: 'detached', timeout: 30000 }).catch(() => fail('Task Scheduler rows never loaded'));
    for (const id of PAGES) {
      await page.goto(`${base()}#/${id}`);
      await page.waitForSelector('main .page', { timeout: 15000 });
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(250);
      const h1 = await page.locator('main h1').first().innerText().catch(() => '');
      const text = await page.locator('body').innerText();
      const failedPage = /This page failed to display/.test(text);
      const g = badGlyphs(text);
      const emptySvgs = await page.$$eval('svg', (els) => els.filter((s) => s.querySelector('path') && !s.querySelector('path').getAttribute('d')).length);
      const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(!!h1 && !failedPage, `[${theme}] ${id}: renders (h1 "${h1}")`);
      check(g.chars.length === 0, `[${theme}] ${id}: no stray glyphs${g.chars.length ? ` (${g.chars.join(' ')})` : ''}`);
      check(emptySvgs === 0, `[${theme}] ${id}: no empty icons`);
      check(overflowX <= 0, `[${theme}] ${id}: no horizontal overflow`);
      await page.screenshot({ path: path.join(OUT, `${id}-${theme}.png`) });
    }

    if (theme === 'dark' && !REAL) {
      const rs = path.join(target.root, 'data', 'state', 'run-state.json');
      const base0 = JSON.parse(fs.readFileSync(rs, 'utf8'));
      note('\n== active scan, then a finished scan while a drawer is open');
      await page.goto(`${base()}#/processes`);
      await page.waitForSelector('main .page table tbody tr');
      const search = page.locator('main input[type="search"]').first();
      await search.fill('chrome');
      fs.writeFileSync(rs, JSON.stringify({ ...base0, running: { type: 'daily', mode: 'manual', pid: process.pid, phase: 'collecting', startedAt: new Date(Date.now() - 65000).toISOString() } }));
      await page.getByText('Daily audit running').waitFor({ timeout: 20000 }).then(() => check(true, 'running scan shows a live banner')).catch(() => fail('running scan banner did not appear'));
      check((await page.getByText('Daily scan running').count()) > 0, 'status strip says a scan is running');
      await page.locator('main table tbody tr').first().click();
      await page.waitForSelector('[role="dialog"]');
      // Finishing makes the status poller reload every mounted query; the open drawer and the filter must survive it.
      fs.writeFileSync(rs, JSON.stringify({ ...base0, lastDaily: { ...base0.lastDaily, finishedAt: new Date().toISOString() }, running: null }));
      await page.getByText('Daily scan finished').first().waitFor({ timeout: 20000 }).then(() => check(true, 'finished scan shows a summary banner')).catch(() => fail('finished scan banner did not appear'));
      await page.waitForTimeout(800);
      check((await search.inputValue()) === 'chrome', 'search text survives a data reload');
      check((await page.locator('[role="dialog"]').count()) === 1, 'open drawer survives a data reload');
      await page.keyboard.press('Escape');

      note('\n== refresh button states and preserved UI state');
      await page.getByRole('button', { name: /Refresh status/ }).click();
      await page.getByText('Status refreshed.').waitFor({ timeout: 15000 });
      check((await search.inputValue()) === 'chrome', 'search text survives Refresh status');
      check((await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark', 'theme survives Refresh status');
      await page.route('**/api/status?fresh=1', async (r) => { await new Promise((x) => setTimeout(x, 700)); await r.continue(); }); // make the busy state observable
      await page.getByRole('button', { name: /Refresh status/ }).click();
      await page.getByRole('button', { name: /Refreshing/ }).waitFor({ timeout: 5000 }).then(() => check(true, 'refresh button shows a busy state')).catch(() => fail('refresh button never showed "Refreshing..."'));
      await page.getByRole('button', { name: /Refresh status/ }).waitFor({ timeout: 15000 });
      await page.unroute('**/api/status?fresh=1');
      fs.writeFileSync(rs, JSON.stringify(base0));

      note('\n== offline and reconnect');
      const port = target.port;
      expected.push('ERR_CONNECTION_REFUSED');
      target.bridge.app.close();
      await page.getByText('Bridge offline').first().waitFor({ timeout: 25000 }).then(() => check(true, 'offline state is shown when the bridge stops')).catch(() => fail('offline state never appeared'));
      check((await page.locator('main h1').count()) > 0, 'page content stays visible while offline (no blank page)');
      await new Promise((r) => target.bridge.app.listen_(port, r));
      await page.getByText('Bridge connected').first().waitFor({ timeout: 25000 }).then(() => check(true, 'reconnects automatically')).catch(() => fail('did not reconnect'));

      note('\n== an API error on one page stays contained');
      expected.push('500');
      await page.route('**/api/recommendations**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'boom' }) }));
      await page.goto(`${base()}#/recommendations`);
      await page.getByText('Could not load data').waitFor({ timeout: 10000 }).then(() => check(true, 'API failure shows an error state with Retry')).catch(() => fail('error state missing'));
      await page.unroute('**/api/recommendations**');
      expected.length = 0;
    }
    await ctx.close();
  }

  // Narrow layout: no horizontal overflow on any page.
  note('\n== narrow viewport (390 px)');
  const mctx = await browser.newContext({ viewport: { width: 390, height: 800 }, colorScheme: 'dark' });
  const mpage = await mctx.newPage();
  mpage.on('pageerror', (e) => fail(`[mobile] page error: ${e.message.slice(0, 160)}`));
  for (const id of PAGES) {
    await mpage.goto(`${base()}#/${id}`);
    await mpage.waitForSelector('main .page', { timeout: 15000 });
    await mpage.waitForLoadState('networkidle');
    const overflow = await mpage.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 1, `[mobile] ${id}: no horizontal overflow (${overflow}px)`);
    await mpage.screenshot({ path: path.join(OUT, `${id}-mobile.png`) });
  }
  await mctx.close();
} catch (e) {
  fail(`smoke test crashed: ${e.stack || e}`);
} finally {
  await browser.close();
  target.close();
}
note(`\n${failures.length ? `FAILED: ${failures.length} problem(s)` : 'SMOKE TEST PASSED'}  (screenshots: ${path.relative(repo, OUT)})`);
exitCode = failures.length ? 1 : 0;
process.exit(exitCode);
