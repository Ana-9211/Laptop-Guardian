import { useState } from 'react';
import { api, ApiError, useQuery } from '../api';
import type { Report } from '../types';
import { Badge, Card, Expander, Icon, useToast } from './ui';
import { useOverview } from '../state/overview';
import { fmtFull } from '../format';

interface Analysis {
  reportType: 'daily' | 'weekly'; reportId: string; reportGeneratedAt?: string; generatedAt: string; model?: string;
  briefing: string; patterns: { title: string; detail: string; evidence?: string[] }[]; recommendations: string[];
}

/**
 * "Analyze with AI" for the current (newest) report of a kind. On demand only: nothing is sent until the button is pressed. The answer is explanation
 * text, validated locally, saved next to the report data and shown again after a reload; it never runs a command.
 */
export function AiReportCard({ report }: { report: Report }) {
  const toast = useToast();
  const ov = useOverview();
  const saved = useQuery<{ analysis: Analysis | null }>(`/api/ai/report?type=${report.type}`);
  const [busy, setBusy] = useState(false);
  const [fresh, setFresh] = useState<Analysis | null>(null);
  const a = fresh || saved.data?.analysis || null;
  const ai = ov.data?.ai;
  const ready = !!ai?.enabled && !!ai?.keyConfigured;
  const latestId = ov.data?.[report.type]?.id;
  const isCurrent = !latestId || latestId === report.id;
  const run = async () => {
    setBusy(true);
    try { setFresh(await api.post<Analysis>('/api/ai/report', { type: report.type })); toast('ok', 'AI analysis received and validated.'); saved.reload(); }
    catch (e) { toast('error', `AI analysis unavailable: ${(e as ApiError).message}`); }
    finally { setBusy(false); }
  };
  const why = !ai ? '' : !ai.enabled ? 'AI analysis is off. Turn on Gemini in Settings.' : !ai.keyConfigured ? 'Add a Gemini API key in Settings.' : !isCurrent ? 'Only the newest report of each kind can be analysed.' : '';
  return (
    <Card title="AI analysis of this report" actions={
      <button className="btn" onClick={() => void run()} disabled={busy || !ready || !isCurrent} title={why || 'Send a short numeric summary of this report to Gemini and show its explanation'}>
        <Icon name="bolt" size={13} />{busy ? 'Analysing...' : a ? 'Run again' : 'Analyze with AI'}
      </button>}>
      {a ? (
        <div className="stack">
          <div className="row tight small muted"><Badge tone={a.reportId === report.id ? 'ok' : 'warn'}>{a.reportId === report.id ? 'This report' : `Report ${a.reportId}`}</Badge>{fmtFull(a.generatedAt)}{a.model ? ` - ${a.model}` : ''}</div>
          <p className="t2 measure">{a.briefing}</p>
          {a.patterns.length > 0 && <div>{a.patterns.map((p) => <Expander key={p.title} head={<b>{p.title}</b>}><p className="t2">{p.detail}</p>{(p.evidence || []).map((e) => <div key={e} className="small muted">- {e}</div>)}</Expander>)}</div>}
          {a.recommendations.length > 0 && <div><b>Suggestions</b><ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{a.recommendations.map((x) => <li key={x}>{x}</li>)}</ul></div>}
          <div className="small muted">Written by Gemini from a short numeric summary (no file paths or user name), checked locally. It explains; it never runs anything. Fixes still come from the Action Center.</div>
        </div>
      ) : (
        <div className="small muted">{why || 'Press the button to have Gemini read this report and explain what stands out. Nothing is sent until you do.'}</div>
      )}
    </Card>
  );
}
