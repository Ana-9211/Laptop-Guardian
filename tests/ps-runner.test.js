'use strict';
// The real runner against throwaway scripts in a temp root: a non-zero exit or timeout is a failure even with parseable stdout.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeRunner } = require('../src/bridge/lib/ps');

function rootWith(scripts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-ps-'));
  fs.mkdirSync(path.join(root, 'src', 'powershell'), { recursive: true });
  for (const [n, body] of Object.entries(scripts)) fs.writeFileSync(path.join(root, 'src', 'powershell', n), body);
  return root;
}

test('runner: exit 0 with JSON is ok; non-zero exit with JSON is a failure; timeout is a failure', async () => {
  const root = rootWith({
    'good.ps1': "'{\"a\":1}'; exit 0",
    'bad.ps1': "'{\"connections\":[]}'; exit 3",
    'slow.ps1': "'{\"partial\":true}'; Start-Sleep -Seconds 20",
  });
  try {
    const ps = makeRunner(root);
    const good = await ps.run('good.ps1'); assert.strictEqual(good.ok, true); assert.strictEqual(good.exitCode, 0); assert.strictEqual(good.data.a, 1);
    const bad = await ps.run('bad.ps1'); assert.strictEqual(bad.ok, false); assert.strictEqual(bad.exitCode, 3);
    const slow = await ps.run('slow.ps1', [], { timeoutMs: 3000 }); assert.strictEqual(slow.ok, false); assert.match(slow.error, /timed out/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runner: never more than MAX_CONCURRENT PowerShell children at once', async () => {
  const { MAX_CONCURRENT } = require('../src/bridge/lib/ps');
  const root = rootWith({ 'nap.ps1': "Start-Sleep -Milliseconds 700; '{\"ok\":true}'" });
  try {
    const ps = makeRunner(root);
    const runs = Array.from({ length: MAX_CONCURRENT + 3 }, () => ps.run('nap.ps1'));
    await new Promise((r) => setTimeout(r, 150));
    const s = ps._stats(); assert.ok(s.active <= MAX_CONCURRENT && s.waiting >= 3, JSON.stringify(s));
    const all = await Promise.all(runs); assert.ok(all.every((x) => x.ok));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('runner: non-ASCII text from a script that loads the encoding setup arrives intact (no replacement characters)', async () => {
  const root = rootWith({});
  const common = path.join(root, 'src', 'powershell', 'Common');
  fs.mkdirSync(common, { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', 'src', 'powershell', 'Common', 'Encoding.ps1'), path.join(common, 'Encoding.ps1'));
  const name = 'Caf\u00e9 \u65e5\u672c\u8a9e \u2014 \u00fcber';
  const p = 'C:\\Users\\Ren\u00e9\\Docs\\r\u00e9sum\u00e9.exe';
  // The script file itself is saved with a byte-order mark, as Windows PowerShell 5.1 needs for non-ASCII literals.
  const script = '\uFEFF. "$PSScriptRoot\\Common\\Encoding.ps1"\n$o = [pscustomobject]@{ name = "' + name + '"; path = "' + p + '"; n = 1 }\n$o | ConvertTo-Json -Compress\n';
  fs.writeFileSync(path.join(root, 'src', 'powershell', 'enc.ps1'), script);
  try {
    const r = await makeRunner(root).run('enc.ps1');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.data.name, name);
    assert.strictEqual(r.data.path, p);
    assert.ok(!JSON.stringify(r.data).includes('\uFFFD'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
