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
