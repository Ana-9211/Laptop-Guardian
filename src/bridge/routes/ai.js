'use strict';
/** Gemini key storage, connection test, analysis and usage. */
const fs = require('fs');
const U = require('../lib/util');
const { HttpError } = require('../lib/http');

module.exports = function registerAiRoutes(ctx) {
  const { P, ps, config, log, need, str, route } = ctx;
  // ---- AI ----
  route('POST', '/api/ai/key', async ({ body }) => {
    // Be forgiving about what was pasted (spaces, a line break, quotes around it), strict about what is stored. The key only ever travels on stdin
    // and later in an HTTP header, so the allowed characters cannot inject anything; the list covers the older AIza... keys and the newer
    // dotted ones (AQ.xxxx) without accepting spaces or control characters.
    const key = str(body.key, 'key', 600).trim().replace(/^["'`]+|["'`]+$/g, '').trim();
    need(/^[A-Za-z0-9._~+/=-]{16,256}$/.test(key), 'That does not look like an API key. Paste only the key itself: 16 to 256 letters, digits or . _ - ~ + / = with no spaces or line breaks (check that no label such as "API key:" was copied with it).');
    const r = await ps.run('Actions/Set-GeminiKey.ps1', [], { stdin: key });
    if (r.missing) throw new HttpError(501, r.error);
    need(r.ok && r.data?.success !== false, r.error || r.data?.error || 'could not store key', 500);
    log({ category: 'config', action: 'ai.key.set', target: 'gemini', reason: 'API key stored (DPAPI, current user)' });
    return { keyConfigured: true };
  });
  route('DELETE', '/api/ai/key', async () => {
    const r = await ps.run('Actions/Set-GeminiKey.ps1', ['-Remove']);
    if (r.missing) {
      try { fs.rmSync(P.key, { force: true }); } catch { /* ignore */ }
    } else need(r.ok, r.error || 'could not remove key', 500);
    log({ category: 'config', action: 'ai.key.remove', target: 'gemini' });
    return { keyConfigured: false };
  });
  route('POST', '/api/ai/test', async () => {
    const r = await ps.run('AI/Test-Gemini.ps1', [], { timeoutMs: 45000 });
    if (r.missing) throw new HttpError(501, r.error);
    const ok = r.ok && r.data?.success !== false;
    log({ category: 'ai', action: 'ai.test', target: 'gemini', result: ok ? 'success' : 'failure', error: ok ? null : (r.error || r.data?.error || null) });
    return { ok, ...(r.data || {}), error: ok ? undefined : (r.error || r.data?.error) };
  });
  route('POST', '/api/ai/analyze', async ({ body }) => {
    const id = str(body.recommendationId, 'recommendationId', 80);
    need(/^[\w.-]+$/.test(id), 'invalid id');
    need(config().ai.enabled, 'AI analysis is disabled in Settings', 409);
    log({ category: 'ai', action: 'ai.analysis.requested', target: id, result: 'started', relatedRecommendation: id, reason: 'user requested; structured metadata is sent to Gemini' });
    const r = await ps.run('AI/Invoke-AiAnalyze.ps1', ['-RecommendationId', id], { timeoutMs: 90000 });
    if (r.missing) throw new HttpError(501, r.error);
    need(r.ok && r.data?.success !== false, r.error || r.data?.error || 'analysis failed', 502);
    return r.data;
  });
  // ---- AI analysis of the current report (on demand; the result is kept next to the report data so it survives a reload) ----
  const reportKind = (v) => { const t = v == null ? 'daily' : String(v); need(t === 'daily' || t === 'weekly', 'type must be daily or weekly'); return t; };
  route('POST', '/api/ai/report', async ({ body }) => {
    const type = reportKind(body && body.type);
    need(config().ai.enabled, 'AI analysis is disabled in Settings', 409);
    log({ category: 'ai', action: 'ai.report.requested', target: type, result: 'started', reason: 'user requested; a short numeric summary of the current report (no paths, no user name) is sent to Gemini' });
    const r = await ps.run('AI/Invoke-AiReportAnalyze.ps1', ['-Type', type], { timeoutMs: 150000 });
    if (r.missing) throw new HttpError(501, r.error);
    need(r.ok && r.data?.success !== false, r.error || r.data?.error || 'analysis failed', 502);
    return r.data.analysis;
  });
  route('GET', '/api/ai/report', ({ query }) => {
    const type = reportKind(query.get('type'));
    const saved = U.readJson(P.latest('ai-report-' + type + '.json'), null);
    return { analysis: saved };
  });
  route('GET', '/api/ai/usage', () => {
    const rows = U.tailJsonl(P.aiUsage, 500);
    const today = U.localIso().slice(0, 10);
    const sum = (f) => rows.filter(f).reduce((a, r) => a + (r.promptTokens || 0) + (r.outputTokens || 0), 0);
    return { requests: rows.slice(-50).reverse(), totals: { requests: rows.length, failures: rows.filter((r) => !r.ok).length, tokensToday: sum((r) => String(r.ts).startsWith(today)), tokensAll: sum(() => true) } };
  });
};
