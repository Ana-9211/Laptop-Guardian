'use strict';
// The score-deduction trend computed from the reasons stored in the metrics rows (src/dashboard/src/healthTrend.ts).
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');
const load = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'dashboard', 'src', 'healthTrend.ts')).href);

test('deductionTrend: counts runs per factor, averages the points, orders by frequency and marks what is still present', async () => {
  const { deductionTrend } = await load();
  const rows = [
    { healthReasons: ['-10 RAM above 90%', '-5 Defender signatures older than 7 days'] },
    { healthReasons: ['-5 Defender signatures older than 7 days'] },
    { healthReasons: [] },
    { healthReasons: ['-7 Disk C: low on space', '-5 Defender signatures older than 7 days'] },
    { cpuPct: 5 },   // an older row without reasons is ignored, not counted as a clean run
  ];
  const t = deductionTrend(rows);
  assert.strictEqual(t.runs, 4);
  assert.deepStrictEqual(t.items.map((i) => [i.text, i.runs, i.avgPoints, i.latest]), [
    ['Defender signatures older than 7 days', 3, 5, true], ['RAM above 90%', 1, 10, false], ['Disk C: low on space', 1, 7, true]]);
  assert.deepStrictEqual(deductionTrend([]), { runs: 0, items: [] });
  assert.deepStrictEqual(deductionTrend([{ healthReasons: [] }]).items, []);
  assert.strictEqual(deductionTrend(Array.from({ length: 50 }, () => ({ healthReasons: ['-3 Reboot pending'] })), 10).runs, 10);
});
