'use strict';
// Child process for tests/lock.test.js: increments a counter in a JSON file N times, each time under the shared file lock.
const fs = require('fs');
const path = require('path');
const U = require('../../src/bridge/lib/util');

const [file, n, mode] = [process.argv[2], Number(process.argv[3]), process.argv[4] || 'sync'];
const bump = () => { const j = JSON.parse(fs.readFileSync(file, 'utf8')); j.n += 1; j.by[String(process.pid)] = (j.by[String(process.pid)] || 0) + 1; fs.writeFileSync(file, JSON.stringify(j)); };

(async () => {
  let failed = 0;
  for (let i = 0; i < n; i++) {
    try {
      if (mode === 'async') await U.withFileLockAsync(file, bump, 15000); else U.withFileLock(file, bump, 15000);
    } catch (e) { failed++; }
  }
  process.send({ done: true, failed, dir: path.dirname(file) });
  process.exit(0);
})();
