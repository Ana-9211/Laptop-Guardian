'use strict';
/** Daily and weekly reports: list, read, export, delete. */
const fs = require('fs');
const path = require('path');
const U = require('../lib/util');

module.exports = function registerReportRoutes(ctx) {
  const { log, need, listReports, reportDir, csvEscape, flatten, route } = ctx;
  route('GET', '/api/reports', ({ query }) => {
    const t = query.get('type');
    if (t) { need(t === 'daily' || t === 'weekly', 'type must be daily or weekly'); return listReports(t); }
    return [...listReports('weekly'), ...listReports('daily')].sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  });

  route('GET', '/api/reports/export', ({ query }) => {
    const dir = reportDir(query.get('type'), query.get('id'));
    const r = U.readJson(path.join(dir, 'report.json'));
    need(r, 'report not found', 404);
    const fmt = query.get('format') || 'json';
    need(['json', 'csv'].includes(fmt), 'format must be json or csv');
    const name = `laptop-guardian-${query.get('type')}-${query.get('id')}.${fmt}`;
    if (fmt === 'json') return { __raw: JSON.stringify(r, null, 2), type: 'application/json; charset=utf-8', filename: name };
    const rows = flatten(r).map(([k, v]) => `${csvEscape(k)},${csvEscape(v)}`);
    return { __raw: 'key,value\n' + rows.join('\n'), type: 'text/csv; charset=utf-8', filename: name };
  });

  route('GET', '/api/reports/:type/:id', ({ params }) => {
    const r = U.readJson(path.join(reportDir(params.type, params.id), 'report.json'));
    need(r, 'report not found', 404);
    return r;
  });

  route('GET', '/api/reports/:type/:id/html', ({ params }) => {
    const f = path.join(reportDir(params.type, params.id), 'report.html');
    need(fs.existsSync(f), 'report html not found', 404);
    return { __raw: fs.readFileSync(f, 'utf8'), type: 'text/html; charset=utf-8', report: true };
  });

  route('DELETE', '/api/reports/:type/:id', ({ params }) => {
    const dir = reportDir(params.type, params.id);
    need(fs.existsSync(dir), 'report not found', 404);
    fs.rmSync(dir, { recursive: true, force: true });
    log({ category: 'system', action: 'report.delete', target: `${params.type}/${params.id}`, reason: 'user deleted historical report' });
    return { ok: true };
  });
};
