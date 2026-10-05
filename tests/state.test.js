'use strict';
// Unit tests for the dashboard's pure connection model (src/dashboard/src/state/connection.ts).
// Node strips the TypeScript types itself, so no build step is needed (Node 22.18+).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const modUrl = pathToFileURL(path.join(__dirname, '..', 'src', 'dashboard', 'src', 'state', 'connection.ts')).href;
const load = () => import(modUrl);

const status = (o = {}) => ({ now: '2026-10-05T10:00:00+05:30', run: { running: null, lastDaily: { finishedAt: 'a' }, lastWeekly: { finishedAt: 'w' } }, schedule: { pending: false, elevationPending: null }, ...o });
const inputs = (o = {}) => ({ hasStatus: true, status: status(), failed: false, errorMessage: null, refreshing: false, finished: null, aged: false, ...o });

test('link state: connecting, online, offline', async () => {
  const { deriveLive } = await load();
  assert.strictEqual(deriveLive(inputs({ hasStatus: false, status: null })).link, 'connecting');
  assert.strictEqual(deriveLive(inputs()).link, 'online');
  const off = deriveLive(inputs({ failed: true, errorMessage: 'down' }));
  assert.strictEqual(off.link, 'offline');
  assert.strictEqual(off.stale, true, 'offline data is stale');
  assert.strictEqual(off.errorMessage, 'down');
});

test('stale only when online data has aged, never when fresh', async () => {
  const { deriveLive } = await load();
  assert.strictEqual(deriveLive(inputs()).stale, false);
  assert.strictEqual(deriveLive(inputs({ aged: true })).stale, true);
  const { isAged } = await load();
  assert.strictEqual(isAged(null, 1e12), false);
  assert.strictEqual(isAged(0, 1e9), true);
});

test('scan phase: running wins over finished; finished shows when idle', async () => {
  const { deriveLive } = await load();
  const running = status({ run: { running: { type: 'daily', mode: 'manual', phase: 'collecting' } } });
  const fin = { type: 'daily', at: 'x' };
  assert.strictEqual(deriveLive(inputs({ status: running, finished: fin })).scan.phase, 'running');
  assert.strictEqual(deriveLive(inputs({ finished: fin })).scan.phase, 'finished');
  assert.strictEqual(deriveLive(inputs()).scan.phase, 'idle');
});

test('refreshing is independent of the link and scan state', async () => {
  const { deriveLive } = await load();
  const l = deriveLive(inputs({ refreshing: true }));
  assert.strictEqual(l.refreshing, true);
  assert.strictEqual(l.link, 'online');
});

test('finished detection: running to stopped, or a changed finish time between polls', async () => {
  const { detectFinished, finishKey } = await load();
  const prev = { type: 'weekly', mode: 'manual' };
  assert.strictEqual(detectFinished(prev, 'a|w', status()).type, 'weekly');
  assert.strictEqual(detectFinished(null, null, status()), null, 'first poll never reports a finish');
  assert.strictEqual(detectFinished(null, 'a|w', status()), null, 'nothing changed');
  const quick = status({ run: { running: null, lastDaily: { finishedAt: 'b' }, lastWeekly: { finishedAt: 'w' } } });
  assert.strictEqual(detectFinished(null, 'a|w', quick).type, 'daily', 'short daily scan between polls');
  const weekly = status({ run: { running: null, lastDaily: { finishedAt: 'a' }, lastWeekly: { finishedAt: 'x' } } });
  assert.strictEqual(detectFinished(null, 'a|w', weekly).type, 'weekly');
  assert.strictEqual(finishKey(status()), 'a|w');
});

test('poll cadence: offline and idle are slow, an active scan is fast, a pending UAC prompt is fastest', async () => {
  const { nextPollDelay } = await load();
  const cfg = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'dashboard', 'src', 'config.ts')).href);
  const base = { link: 'online', scan: { phase: 'idle' }, schedulePending: false, elevationPending: false };
  assert.strictEqual(nextPollDelay(base), cfg.POLL_MS.idle);
  assert.strictEqual(nextPollDelay({ ...base, link: 'offline' }), cfg.POLL_MS.offline);
  assert.strictEqual(nextPollDelay({ ...base, scan: { phase: 'running' } }), cfg.POLL_MS.scan);
  assert.strictEqual(nextPollDelay({ ...base, elevationPending: true }), cfg.POLL_MS.elevation);
  assert.ok(cfg.POLL_MS.scan < cfg.POLL_MS.idle && cfg.POLL_MS.elevation < cfg.POLL_MS.scan);
});
