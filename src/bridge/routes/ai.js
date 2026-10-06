'use strict';
/** Gemini key storage, connection test, analysis and usage. */
const fs = require('fs');
const U = require('../lib/util');
const { HttpError } = require('../lib/http');

module.exports = function registerAiRoutes(ctx) {
  const { P, ps, config, log, need, str, route } = ctx;
  // ---- AI ----
  route('POST', '/api/ai/key', async ({ body }) => {
    const key = str(body.key, 'key', 128).trim();
    need(/^[A-Za-z0-9_-]{20,128}$/.test(key), 'key has an unexpected format');
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
  route('GET', '/api/ai/usage', () => {
    const rows = U.tailJsonl(P.aiUsage, 500);
    const today = U.localIso().slice(0, 10);
    const sum = (f) => rows.filter(f).reduce((a, r) => a + (r.promptTokens || 0) + (r.outputTokens || 0), 0);
    return { requests: rows.slice(-50).reverse(), totals: { requests: rows.length, failures: rows.filter((r) => !r.ok).length, tokensToday: sum((r) => String(r.ts).startsWith(today)), tokensAll: sum(() => true) } };
  });
};
