'use strict';
// On-demand AI analysis of the current report: /api/ai/report
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { startBridge, fakeRunner } = require('./lib/harness');

const mine = (ps) => ps.calls.filter((c) => c.rel === 'AI/Invoke-AiReportAnalyze.ps1');
const analysis = { reportType: 'daily', reportId: '2026-10-11', generatedAt: '2026-10-11T20:00:00+05:30', model: 'm', briefing: 'All fine.', patterns: [], recommendations: ['Restart weekly'] };

test('POST /api/ai/report refuses while AI is off, then runs the fixed script with a validated type and returns the analysis', async () => {
  const ps = fakeRunner({ 'AI/Invoke-AiReportAnalyze.ps1': (args) => ({ ok: true, data: { success: true, analysis: { ...analysis, reportType: args[1] } } }) });
  const b = await startBridge({ ps });
  try {
    const cfgFile = path.join(b.root, 'config', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')); cfg.ai = { ...(cfg.ai || {}), enabled: false };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    const off = await b.post('/api/ai/report', { type: 'daily' });
    assert.strictEqual(off.status, 409); assert.strictEqual(mine(ps).length, 0, 'nothing was started while AI is off');
    cfg.ai.enabled = true; fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    const bad = await b.post('/api/ai/report', { type: 'daily; calc' });
    assert.strictEqual(bad.status, 400); assert.strictEqual(mine(ps).length, 0, 'an invalid type never reaches PowerShell');
    const ok = await b.post('/api/ai/report', { type: 'weekly' });
    assert.strictEqual(ok.status, 200); assert.strictEqual(ok.json.reportType, 'weekly'); assert.strictEqual(ok.json.briefing, 'All fine.');
    assert.deepStrictEqual(mine(ps)[0].args, ['-Type', 'weekly']);
    const def = await b.post('/api/ai/report', {});
    assert.strictEqual(def.status, 200); assert.deepStrictEqual(mine(ps)[1].args, ['-Type', 'daily'], 'the default is the daily report');
  } finally { b.close(); }
});

test('POST /api/ai/report reports a failed analysis as 502 with the reason, and GET returns the saved analysis (or null)', async () => {
  const ps = fakeRunner({ 'AI/Invoke-AiReportAnalyze.ps1': () => ({ ok: false, error: 'AI analysis unavailable or the response failed validation (see Logs)' }) });
  const b = await startBridge({ ps });
  try {
    const cfgFile = path.join(b.root, 'config', 'config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')); cfg.ai = { ...(cfg.ai || {}), enabled: true };
    fs.writeFileSync(cfgFile, JSON.stringify(cfg));
    const bad = await b.post('/api/ai/report', { type: 'daily' });
    assert.strictEqual(bad.status, 502); assert.match(bad.json.error, /unavailable|validation/);
    assert.strictEqual((await b.get('/api/ai/report?type=daily')).json.analysis, null);
    fs.writeFileSync(path.join(b.root, 'data', 'latest', 'ai-report-daily.json'), JSON.stringify(analysis));
    assert.strictEqual((await b.get('/api/ai/report?type=daily')).json.analysis.briefing, 'All fine.');
    assert.strictEqual((await b.get('/api/ai/report?type=weekly')).json.analysis, null);
    assert.strictEqual((await b.get('/api/ai/report?type=../../x')).status, 400);
  } finally { b.close(); }
});
