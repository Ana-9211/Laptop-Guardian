'use strict';
// The number ranges the bridge enforces on Settings (util.js RANGES) and the ranges the elevated clamp enforces (InstallSecurity.psm1 ConfigLimits)
// must be ONE table: any key present in both has to agree exactly, and every key the elevated clamp knows has to exist in the bridge's table.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const U = require('../src/bridge/lib/util');

function psLimits() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'powershell', 'Install', 'InstallSecurity.psm1'), 'utf8');
  const start = src.indexOf('$script:ConfigLimits'); const end = src.indexOf('function Limit-ConfigForElevation');
  assert.ok(start > 0 && end > start, 'the ConfigLimits table is where the test expects it');
  const out = {};
  for (const m of src.slice(start, end).matchAll(/'([A-Za-z.]+)'\s*=\s*@\((-?\d+),\s*(-?\d+)\)/g)) out[m[1]] = [Number(m[2]), Number(m[3])];
  return out;
}

test('Settings ranges and the elevated clamp agree for every shared key (one range per setting)', () => {
  const ps = psLimits(); const node = U.RANGES;
  assert.ok(Object.keys(ps).length >= 14, `parsed ${Object.keys(ps).length} elevated limits`);
  const shared = Object.keys(ps).filter((k) => k in node);
  assert.ok(shared.length >= 14, 'nearly all elevated limits are also bridge ranges');
  const diffs = shared.filter((k) => ps[k][0] !== node[k][0] || ps[k][1] !== node[k][1]).map((k) => `${k}: bridge ${JSON.stringify(node[k])} vs elevated ${JSON.stringify(ps[k])}`);
  assert.deepStrictEqual(diffs, [], 'ranges differ');
  const missing = Object.keys(ps).filter((k) => !(k in node));
  assert.deepStrictEqual(missing, [], 'every elevated limit is a bridge range too');
});

test('cleanup.tempMinAgeDays is 1 to 365 everywhere: the bridge refuses 0 and the default stays valid', () => {
  assert.deepStrictEqual(U.RANGES['cleanup.tempMinAgeDays'], [1, 365]);
  assert.ok(U.mergeConfig(U.DEFAULT_CONFIG, { cleanup: { tempMinAgeDays: 0 } }).errors.length > 0);
  assert.strictEqual(U.mergeConfig(U.DEFAULT_CONFIG, { cleanup: { tempMinAgeDays: 1 } }).errors.length, 0);
  assert.ok(U.DEFAULT_CONFIG.cleanup.tempMinAgeDays >= 1);
});
