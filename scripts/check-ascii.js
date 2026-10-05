'use strict';
// Fails if any dashboard source file contains a non-ASCII character. Glyphs in the UI must come from SVG icons or
// CSS, or from \u escapes in code, never from characters that depend on font fallback or file encoding.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'src', 'dashboard');
const EXT = /\.(tsx?|css|html|js)$/;
const bad = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (EXT.test(e.name)) {
      fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line, i) => {
        const ch = [...line].find((c) => c.codePointAt(0) > 126);
        if (ch) bad.push(`${path.relative(path.join(__dirname, '..'), p)}:${i + 1}: U+${ch.codePointAt(0).toString(16).toUpperCase()}`);
      });
    }
  }
})(ROOT);
if (bad.length) { console.error(`Non-ASCII characters in dashboard source:\n${bad.join('\n')}`); process.exit(1); }
console.log('dashboard source is ASCII-only');
