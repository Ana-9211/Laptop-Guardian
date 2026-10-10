'use strict';
// Cleanup candidates whose file was deleted after the scan must not be listed or offered.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('../src/bridge/lib/util');
const { startBridge } = require('./lib/harness');

test('dropGoneCandidates removes only paths that definitely do not exist', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg-gone-'));
  try {
    const here = path.join(dir, 'here.tmp'); fs.writeFileSync(here, 'x');
    const files = { generatedAt: 'g', candidates: [{ id: 'a', path: here }, { id: 'b', path: path.join(dir, 'deleted.tmp') }, { id: 'c', path: path.join(here, 'under-a-file') }, { id: 'd' }] };
    const out = U.dropGoneCandidates(files);
    assert.deepStrictEqual(out.candidates.map((c) => c.id), ['a', 'd'], 'deleted and not-a-directory paths go; a record without a path stays');
    assert.strictEqual(out.goneCount, 2);
    assert.strictEqual(files.candidates.length, 4, 'the input is not modified');
    assert.strictEqual(U.dropGoneCandidates(null), null);
    const same = { candidates: [{ id: 'a', path: here }] };
    assert.strictEqual(U.dropGoneCandidates(same), same, 'nothing gone returns the same object');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GET /api/files no longer lists a candidate that was deleted after the scan', async () => {
  const b = await startBridge({});
  try {
    const keep = path.join(b.root, 'keep.tmp'); fs.writeFileSync(keep, 'x');
    fs.writeFileSync(path.join(b.root, 'data', 'latest', 'files.json'), JSON.stringify({ generatedAt: 'now', drives: [], candidates: [{ id: 'k', name: 'keep.tmp', path: keep, sizeMB: 1 }, { id: 'g', name: 'gone.tmp', path: path.join(b.root, 'gone.tmp'), sizeMB: 1 }], largest: [], duplicates: [], downloads: {} }));
    const r = await b.get('/api/files');
    assert.deepStrictEqual(r.json.candidates.map((c) => c.id), ['k']);
  } finally { b.close(); }
});
