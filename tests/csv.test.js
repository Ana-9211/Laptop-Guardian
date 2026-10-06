'use strict';
// The dashboard's CSV export (src/dashboard/src/csv.ts), loaded directly: quoting, and the spreadsheet formula guard.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { pathToFileURL } = require('url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'src', 'dashboard', 'src', 'csv.ts')).href);

test('csv: quotes commas, quotes and line breaks, writes empty for null, and keeps numbers and booleans', async () => {
  const { csvCell, toCsv } = await load();
  assert.strictEqual(csvCell('plain'), 'plain');
  assert.strictEqual(csvCell('a,b'), '"a,b"');
  assert.strictEqual(csvCell('say "hi"'), '"say ""hi"""');
  assert.strictEqual(csvCell('two\nlines'), '"two\nlines"');
  assert.strictEqual(csvCell(null), ''); assert.strictEqual(csvCell(undefined), '');
  assert.strictEqual(csvCell(0), '0'); assert.strictEqual(csvCell(false), 'false'); assert.strictEqual(csvCell(-5), '-5');
  const out = toCsv([{ label: 'Name', get: (r) => r.n }, { label: 'Path', get: (r) => r.p }], [{ n: 'a', p: 'C:\\x, y' }, { n: 'b', p: null }]);
  assert.strictEqual(out, 'Name,Path\r\na,"C:\\x, y"\r\nb,\r\n');
});

test('csv: text a spreadsheet would run as a formula is neutralised, while real negative numbers are left alone', async () => {
  const { csvCell } = await load();
  for (const evil of ['=HYPERLINK("http://x","y")', '+cmd|calc', '-2+3', '@SUM(A1)', '\tx']) assert.ok(csvCell(evil).replace(/^"/, '').startsWith("'"), evil);
  assert.strictEqual(csvCell('-12.5'), '-12.5');
  assert.strictEqual(csvCell('Caf\u00e9'), 'Caf\u00e9');
});
