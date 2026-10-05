'use strict';
// Fails if any source file contains a non-ASCII character. Glyphs in the UI must come from SVG icons or CSS, or from \u escapes
// in code, never from characters that depend on font fallback or file encoding. The same rule keeps the PowerShell agents and the
// bridge free of characters that Windows PowerShell 5.1 would misread without a byte-order mark. (A leading BOM itself is allowed.)
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const TREES = [
  { dir: path.join(REPO, 'src', 'dashboard'), ext: /\.(tsx?|css|html|js)$/ },
  { dir: path.join(REPO, 'src', 'bridge'), ext: /\.js$/ },
  { dir: path.join(REPO, 'src', 'powershell'), ext: /\.(ps1|psm1|psd1|cs)$/ },
];
const ROOT_FILES = ['Install-LaptopGuardian.ps1', 'Uninstall-LaptopGuardian.ps1'];
const bad = [];

function scan(p) {
  const text = fs.readFileSync(p, 'utf8');
  (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text).split(/\r?\n/).forEach((line, i) => {
    const ch = [...line].find((c) => c.codePointAt(0) > 126);
    if (ch) bad.push(`${path.relative(REPO, p)}:${i + 1}: U+${ch.codePointAt(0).toString(16).toUpperCase()}`);
  });
}
function walk(dir, ext) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, ext);
    else if (ext.test(e.name)) scan(p);
  }
}
for (const t of TREES) walk(t.dir, t.ext);
for (const f of ROOT_FILES) { const p = path.join(REPO, f); if (fs.existsSync(p)) scan(p); }

if (bad.length) { console.error(`Non-ASCII characters in source:\n${bad.join('\n')}`); process.exit(1); }
console.log('dashboard, bridge and PowerShell source is ASCII-only');
