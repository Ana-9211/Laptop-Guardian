'use strict';
/** Cleanup candidates and the ignore list. */
const U = require('../lib/util');

module.exports = function registerFileRoutes(ctx) {
  const { P, log, str, route, locked } = ctx;
  route('GET', '/api/files', () => {
    const d = U.readJson(P.latest('files.json'), { generatedAt: null, drives: [], candidates: [], largest: [], duplicates: [], downloads: {} }) || {};
    const ignored = new Set(U.readJson(P.ignoredFiles, []) || []);
    d.candidates = (d.candidates || []).map((c) => ({ ...c, ignored: c.ignored || ignored.has(c.id) }));
    return d;
  });

  route('POST', '/api/files/ignore', locked(P.ignoredFiles, ({ body }) => {
    const id = str(body.id, 'id', 128);
    const set = new Set(U.readJson(P.ignoredFiles, []) || []);
    if (body.ignored === false) set.delete(id); else set.add(id);
    U.writeJsonAtomic(P.ignoredFiles, [...set]);
    log({ category: 'file', action: body.ignored === false ? 'file.unignore' : 'file.ignore', target: id });
    return { ok: true };
  }));
};
