'use strict';
/** The HTTP layer: error type, security headers, JSON bodies, static files and the request pipeline. No knowledge of any route. */
const { Readable } = require('stream');
const fs = require('fs');
const path = require('path');
const { MAX_BODY, MIME } = require('./constants');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; if (extra) this.extra = extra; }
}
const need = (cond, msg, status = 400) => { if (!cond) throw new HttpError(status, msg); };

function securityHeaders(res, extra = {}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
}
const sendJson = (res, status, obj) => {
  const b = JSON.stringify(obj);
  securityHeaders(res, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(b) });
  res.writeHead(status); res.end(b);
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, 'request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' ? v : {}); } catch { reject(new HttpError(400, 'invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(distDir, req, res, pathname) {
  const base = path.resolve(distDir);
  let rel; try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'bad path'); }
  if (rel.includes('\0')) throw new HttpError(400, 'bad path');
  let file = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  if (file !== base && !file.startsWith(base + path.sep)) throw new HttpError(403, 'forbidden');
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(base, 'index.html');
  if (!fs.existsSync(file)) {
    securityHeaders(res, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.writeHead(503); return res.end('Dashboard not built. Run: npm install && npm run build in src/dashboard');
  }
  const ext = path.extname(file).toLowerCase();
  securityHeaders(res, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': file.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-store',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  });
  res.writeHead(200); fs.createReadStream(file).pipe(res);
}

/** Builds the request handler: Host allowlist, cross-site refusal, session token, same-origin header on mutations, routing, response encoding. */
function createHandler({ routes, allowedHosts, tokenOk, distDir }) {
  return async function handle(req, res) {
    try {
      const host = String(req.headers.host || '').toLowerCase();
      need(allowedHosts.has(host), 'invalid Host header', 403);
      const url = new URL(req.url, `http://${host}`);
      const method = req.method;
      if (!url.pathname.startsWith('/api/')) {
        need(method === 'GET' || method === 'HEAD', 'method not allowed', 405);
        return serveStatic(distDir, req, res, url.pathname);
      }
      const mutating = method !== 'GET' && method !== 'HEAD';
      // Browsers label cross-site requests; refuse anything that is not from this page or typed by the user.
      const fetchSite = req.headers['sec-fetch-site'];
      need(!fetchSite || fetchSite === 'same-origin' || fetchSite === 'none', 'cross-site request refused', 403);
      if (url.pathname !== '/api/ping') need(tokenOk(req.headers.authorization), 'missing or invalid session token. Open Laptop Guardian from its shortcut.', 401);
      if (mutating) {
        need(req.headers['x-guardian'] === '1', 'missing X-Guardian header', 403);
        const origin = req.headers.origin;
        need(!!origin && origin.startsWith('http://') && allowedHosts.has(origin.replace(/^http:\/\//, '').toLowerCase()), 'same-origin Origin header required', 403);
      }
      const r = routes.find((x) => x.method === method && x.re.test(url.pathname));
      if (!r) {
        const pathMatch = routes.some((x) => x.re.test(url.pathname));
        throw new HttpError(pathMatch ? 405 : 404, pathMatch ? 'method not allowed' : 'not found');
      }
      const m = r.re.exec(url.pathname);
      const params = {};
      try { r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); } catch { throw new HttpError(400, 'malformed URL encoding'); }
      const body = mutating ? await readBody(req) : {};
      const out = await r.handler({ params, query: url.searchParams, body });
      if (out && out.__stream) {
        securityHeaders(res, { 'Content-Type': out.type, ...(out.filename ? { 'Content-Disposition': `attachment; filename="${out.filename}"` } : {}) });
        res.writeHead(200); return Readable.from(out.__stream).pipe(res);
      }
      if (out && out.__raw !== undefined) {
        const h = { 'Content-Type': out.type };
        if (out.filename) h['Content-Disposition'] = `attachment; filename="${out.filename}"`;
        if (out.report) h['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
        securityHeaders(res, h);
        res.writeHead(200); return res.end(out.__raw);
      }
      sendJson(res, 200, out === undefined ? { ok: true } : out);
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (!(e instanceof HttpError)) console.error('[bridge] unhandled', e);
      if (!res.headersSent) sendJson(res, status, { error: e instanceof HttpError ? e.message : 'internal error', ...(e && e.errors ? { errors: e.errors } : {}), ...(e && e.extra ? e.extra : {}) });
      else res.end();
    }
  };
}

module.exports = { HttpError, need, createHandler };
