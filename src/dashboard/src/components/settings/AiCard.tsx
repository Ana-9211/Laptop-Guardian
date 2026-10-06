import type { Draft, Upd } from './fields';
import { Badge, Card, ErrorState, Icon, Switch } from '../ui';
import type { useQuery } from '../../api';
import { fmtDate } from '../../format';
import { FALLBACK_MODELS, Field, Num } from './fields';

export function AiCard({ d, upd, keyOn, keyText, setKey, show, setShow, busy, testMsg, liveModels, usage, saveKey, removeKey, test }: { d: Draft; upd: Upd; keyOn?: boolean; keyText: string; setKey: (v: string) => void; show: boolean; setShow: (v: boolean) => void; busy: string; testMsg: { ok: boolean; text: string } | null; liveModels: string[]; usage: ReturnType<typeof useQuery<{ requests: { ts: string; model: string; kind: string; ok: boolean; promptTokens: number; outputTokens: number; error?: string }[]; totals: { requests: number; failures: number; tokensToday: number; tokensAll: number } }>>; saveKey: () => void; removeKey: () => void; test: () => void }) {
  return (
      <Card title="Gemini (AI analysis)" actions={<Badge tone={d.ai.enabled && keyOn ? 'info' : ''} dot>{d.ai.enabled ? (keyOn ? 'Enabled' : 'Needs key') : 'Off'}</Badge>}>
        <div className="stack-lg">
          <div className="notice"><b>Privacy.</b> When enabled, Laptop Guardian sends <b>structured metadata only</b> to Google&apos;s Gemini API: process names, paths, publishers, signatures, resource numbers, and aggregated findings. It never sends file contents, documents, passwords or tokens. Responses are schema-validated and can never run commands. Without AI everything still works.</div>
          <Switch checked={d.ai.enabled} onChange={(v) => upd((x) => { x.ai.enabled = v; })} label="Enable AI analysis" />
          <form className="grid g2" onSubmit={(e) => { e.preventDefault(); if (keyText) saveKey(); }} autoComplete="off">
            <Field label="API key" hint={keyOn ? 'A key is stored, encrypted with Windows DPAPI for your account. It is never shown again, never sent to this page and never committed to Git.' : 'Get a key from Google AI Studio. It is stored encrypted for your Windows account only.'}>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input type={show ? 'text' : 'password'} autoComplete="off" spellCheck={false} placeholder={keyOn ? 'Key stored (hidden)' : 'Paste API key'} value={keyText} onChange={(e) => setKey(e.target.value)} style={{ flex: 1, fontFamily: 'var(--mono)' }} aria-label="Gemini API key" />
                <button type="button" className="btn icon-btn" aria-label={show ? 'Hide key' : 'Show key'} aria-pressed={show} onClick={() => setShow(!show)}><Icon name={show ? 'eyeoff' : 'eye'} /></button>
              </div>
            </Field>
            <div className="row" style={{ alignSelf: 'end' }}>
              <button type="submit" className="btn primary" disabled={!keyText || busy === 'key'}><Icon name="lock" size={13} />{keyOn ? 'Replace key' : 'Save key'}</button>
              <button type="button" className="btn" disabled={!keyOn || busy === 'test'} onClick={test}>{busy === 'test' ? 'Testing...' : 'Test connection'}</button>
              {keyOn && <button type="button" className="btn danger" onClick={removeKey}>Remove key</button>}
            </div>
          </form>
          {testMsg && <div className={`notice ${testMsg.ok ? 'ok' : 'crit'}`} role="status">{testMsg.text}</div>}
          <div className="grid g4">
            <Field label="Model"><input list="models" value={d.ai.model} onChange={(e) => upd((x) => { x.ai.model = e.target.value; })} /><datalist id="models">{(liveModels.length ? liveModels : FALLBACK_MODELS).map((m) => <option key={m} value={m} />)}</datalist></Field>
            <Field label="Max requests per run"><Num min={0} max={500} value={d.ai.maxRequestsPerRun} onChange={(v) => upd((x) => { x.ai.maxRequestsPerRun = v; })} /></Field>
            <Field label="Max processes per run"><Num min={0} max={100} value={d.ai.maxProcessesPerRun} onChange={(v) => upd((x) => { x.ai.maxProcessesPerRun = v; })} /></Field>
            <Field label="Daily token budget"><Num min={0} step={10000} value={d.ai.dailyTokenBudget} onChange={(v) => upd((x) => { x.ai.dailyTokenBudget = v; })} /></Field>
          </div>
          <div>
            <h3 style={{ marginBottom: 6 }}>Request history</h3>
            {usage.data ? (<>
              <div className="row small t2" style={{ gap: 18 }}><span>{usage.data.totals.requests} requests</span><span>{usage.data.totals.failures} failed</span><span>{usage.data.totals.tokensToday.toLocaleString()} tokens today</span><span>{usage.data.totals.tokensAll.toLocaleString()} tokens total</span></div>
              {usage.data.requests.length === 0 ? <div className="small muted" style={{ marginTop: 6 }}>No requests yet. Gemini token pricing varies by model; check the current Google rates.</div> : (
                <div className="table-wrap" style={{ maxHeight: 200, marginTop: 8, border: '1px solid var(--line)', borderRadius: 6 }}><table className="t"><thead><tr><th>Time</th><th>Model</th><th>Kind</th><th>Result</th><th className="r">Tokens</th></tr></thead><tbody>{usage.data.requests.slice(0, 20).map((r, i) => <tr key={i}><td className="small">{fmtDate(r.ts)}</td><td className="mono">{r.model}</td><td>{r.kind}</td><td><Badge tone={r.ok ? 'ok' : 'crit'} dot>{r.ok ? 'ok' : r.error || 'failed'}</Badge></td><td className="r num">{(r.promptTokens || 0) + (r.outputTokens || 0)}</td></tr>)}</tbody></table></div>)}
            </>) : usage.error ? <ErrorState error={usage.error} onRetry={usage.reload} /> : <div className="small muted">Loading...</div>}
          </div>
        </div>
      </Card>
  );
}
