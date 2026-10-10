'use strict';
/**
 * Loads a TypeScript module from the dashboard for a test, without a build step:
 *  1. Node with type stripping (22.18+, 24) imports the .ts file directly;
 *  2. otherwise the TypeScript compiler from src/dashboard/node_modules (installed by "npm --prefix src/dashboard ci") transpiles it, and the
 *     relative .ts modules it imports, into a temp folder;
 *  3. otherwise tsSupport() says why not, and the test is skipped with that reason (never failed for a missing tool).
 * The bridge itself stays zero-dependency: this is test-only, and the compiler is the dashboard's own development dependency.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const srcRoot = path.join(__dirname, '..', '..', 'src', 'dashboard', 'src');
const dashboardRoot = path.join(__dirname, '..', '..', 'src', 'dashboard');
let ts;
function compiler() {
  if (ts !== undefined) return ts;
  try { ts = require(require.resolve('typescript', { paths: [dashboardRoot] })); } catch { ts = null; }
  return ts;
}

/** { ok, how } or { ok: false, reason }. */
function tsSupport() {
  if (process.features && process.features.typescript) return { ok: true, how: 'type stripping' };
  if (compiler()) return { ok: true, how: 'typescript compiler' };
  return { ok: false, reason: 'this Node cannot import .ts files (it needs 22.18 or newer) and the dashboard\'s TypeScript compiler is not installed (npm --prefix src/dashboard ci)' };
}

function transpileTree(c, file, outDir, done) {
  const rel = path.relative(srcRoot, file);
  if (done.has(rel)) return;
  done.add(rel);
  let code = c.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: c.ModuleKind.ESNext, target: c.ScriptTarget.ES2022 } }).outputText;
  code = code.replace(/(from\s+|import\s*\(\s*)(['"])(\.{1,2}\/[^'"]+?)\.ts\2/g, (m, pre, q, spec) => {
    transpileTree(c, path.resolve(path.dirname(file), `${spec}.ts`), outDir, done);
    return `${pre}${q}${spec}.mjs${q}`;
  });
  const target = path.join(outDir, rel.replace(/\.ts$/, '.mjs'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, code);
}

/** Imports src/dashboard/src/<relPath> (a .ts file). */
async function loadTs(relPath) {
  const file = path.join(srcRoot, relPath);
  if (process.features && process.features.typescript) return import(pathToFileURL(file).href);
  const c = compiler();
  if (!c) throw new Error(tsSupport().reason);
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-ts-'));
  try {
    transpileTree(c, file, outDir, new Set());
    return await import(pathToFileURL(path.join(outDir, relPath.replace(/\.ts$/, '.mjs'))).href);
  } finally { fs.rmSync(outDir, { recursive: true, force: true }); }
}

module.exports = { loadTs, tsSupport };
