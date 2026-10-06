import { useFindings, useRemediationHistory } from '../state/findings';
import { useMemo } from 'react';
import type { Finding, HistoryItem, RevoInfo } from '../types';
import { Badge, Card, Col, DataTable, Drawer, Empty, ErrorState, Icon, PageHead, SearchBox, SkeletonCards, Stat, Tabs } from '../components/ui';
import { FindingDetail } from '../components/FindingActions';
import { useActionFlow } from '../components/ActionFlow';
import { useStatus } from '../state/StatusProvider';
import { useHash, go, useBack } from '../router';
import { usePageState } from '../state/pageState';
import { RiskLink } from '../components/Linked';
import { CsvButton } from '../components/CsvButton';
import { ago, fmtFull, TONE_BY_RESULT } from '../format';
import { confidenceLabel, kindLabel } from '../labels';

type Tab = 'findings' | 'history';
const KINDS = [{ id: '', label: 'All' }, { id: 'process', label: 'Processes' }, { id: 'file', label: 'Files' }, { id: 'health', label: 'Health' }, { id: 'network', label: 'Network' }, { id: 'task', label: 'Schedule' }];

function RevoNote({ revo }: { revo: RevoInfo | null }) {
  if (!revo) return null;
  return (
    <div className={`notice ${revo.available ? '' : 'warn'}`}>
      <b>Revo Uninstaller:</b> {revo.available ? `available (version ${revo.version}). Guardian opens Revo's own window for an installed application you pick and only reports an uninstall as done after it verifies the program is gone.` : `not usable. ${revo.reason || ''} Use Windows Settings, Apps to uninstall programs instead.`}
    </div>
  );
}

export default function ActionCenter() {
  const { params } = useHash();
  const { check } = useStatus();
  const findings = useFindings();
  const hist = useRemediationHistory();
  const [ps, setPs] = usePageState('actions', { tab: 'findings', kind: '', q: '', risk: '', fix: '' });
  const tab = (ps.tab === 'history' ? 'history' : 'findings') as Tab; const kind = ps.kind; const text = ps.q;
  const setTab = (t: Tab) => setPs({ tab: t }); const setKind = (k: string) => setPs({ kind: k }); const setText = (q: string) => setPs({ q });
  const back = useBack();
  const flow = useActionFlow(() => { findings.reload(); hist.reload(); void check(true); });
  const openId = params.get('finding');
  const list = useMemo(() => findings.data?.findings ?? [], [findings.data]);
  const shown = useMemo(() => list.filter((f) => (!kind || f.kind === kind) && (!ps.risk || f.risk === ps.risk) && (!ps.fix || (ps.fix === 'admin' ? f.actions.some((a) => a.eligible && a.admin !== 'no') : f.actions.some((a) => a.eligible))) && (!text || `${f.title} ${f.what}`.toLowerCase().includes(text.toLowerCase()))), [list, kind, text, ps.risk, ps.fix]);
  const selected = openId ? list.find((f) => f.id === openId) ?? null : null;
  const fixable = list.filter((f) => f.actions.some((a) => a.eligible)).length;
  const admin = list.filter((f) => f.actions.some((a) => a.eligible && a.admin !== 'no')).length;
  const high = list.filter((f) => f.risk === 'HIGH').length;
  const select = (f: Finding | null) => go(f ? `/actions?finding=${encodeURIComponent(f.id)}` : '/actions');

  const cols: Col<Finding>[] = [
    { key: 'title', label: 'Finding', sort: (f) => f.title.toLowerCase(), render: (f) => <span className="stack tight"><b className="trunc" style={{ maxWidth: 520 }}>{f.title}</b><span className="small muted trunc" style={{ maxWidth: 520 }}>{f.what}</span></span> },
    { key: 'kind', label: 'Type', sort: (f) => f.kind, render: (f) => <a className="chip-link" href={`#/actions?kind=${f.kind}`} title="Show only this type" onClick={(e) => e.stopPropagation()}><Badge tone="outline">{kindLabel(f.kind)}</Badge></a> },
    { key: 'risk', label: 'Risk', sort: (f) => ['HIGH', 'MEDIUM', 'LOW', 'UNKNOWN'].indexOf(String(f.risk)), render: (f) => <RiskLink risk={String(f.risk)} to={`/actions?risk=${f.risk}`} /> },
    { key: 'conf', label: 'Confidence', align: 'r', sort: (f) => f.confidence, render: (f) => <span className="num" title={confidenceLabel(f.confidence)}>{Math.round(f.confidence * 100)}%</span> },
    { key: 'fix', label: 'Available fixes', render: (f) => <span className="row tight">{f.actions.filter((a) => a.eligible).map((a) => <Badge key={a.actionId + JSON.stringify(a.params)} tone={a.admin === 'yes' ? 'warn' : 'accent'}>{a.label}</Badge>)}{!f.actions.some((a) => a.eligible) && <span className="small muted">{f.manual ? f.manual.label : 'None'}</span>}</span> },
    { key: 'last', label: 'Last attempt', render: (f) => (f.attempts[0] ? <span className="row tight"><Badge tone={TONE_BY_RESULT[f.attempts[0].result] || ''}>{f.attempts[0].result}</Badge><span className="small muted">{ago(f.attempts[0].ts)}</span></span> : <span className="muted small">none</span>) },
  ];
  const hcols: Col<HistoryItem>[] = [
    { key: 'ts', label: 'When', sort: (h) => h.ts, render: (h) => <span className="small nowrap">{fmtFull(h.ts)}</span> },
    { key: 'label', label: 'Action', sort: (h) => h.label, render: (h) => <b>{h.label}</b> },
    { key: 'target', label: 'Target', render: (h) => <span className="mono trunc" style={{ maxWidth: 360, display: 'inline-block' }}>{h.target || ''}</span> },
    { key: 'result', label: 'Result', sort: (h) => h.result, render: (h) => <span className="row tight"><Badge tone={TONE_BY_RESULT[h.result] || ''} dot>{h.result}</Badge>{h.verified && <Badge tone="ok">verified</Badge>}{h.elevated && <Badge tone="warn">admin</Badge>}</span> },
    { key: 'msg', label: 'Detail', render: (h) => <span className="small t2">{h.error || h.message || ''}</span> },
    { key: 'undo', label: '', render: (h) => (h.canUndo ? <button className="btn sm" onClick={(e) => { e.stopPropagation(); void flow.runUndo(h.id); }}>Undo</button> : null) },
  ];

  return (
    <div className="page">
      <PageHead title="Action Center" sub="Every finding Guardian can fix, with the evidence, the exact action, and what happens to your laptop. Nothing runs without your explicit confirmation, and every result is verified and logged." actions={<><span className="small muted">{findings.data ? `Updated ${ago(findings.data.generatedAt)}` : 'Loading...'}</span><button className="btn" onClick={() => { findings.reload(); hist.reload(); }}><Icon name="refresh" size={14} />Refresh</button></>} />
      {findings.error ? <ErrorState error={findings.error} onRetry={findings.reload} /> : !findings.data ? <SkeletonCards n={4} /> : (
        <>
          <div className="grid g4">
            <Stat label="Open findings" value={String(list.length)} sub="from the latest scans" href="/actions?kind=&risk=&fix=&q=" />
            <Stat label="High risk" value={String(high)} tone={high ? 'crit' : 'ok'} sub={high ? 'review these first' : 'none'} href="/actions?risk=HIGH" />
            <Stat label="Can be fixed here" value={String(fixable)} sub="with a confirmed, allowlisted action" href="/actions?fix=1" />
            <Stat label="Need administrator" value={String(admin)} tone={admin ? 'warn' : ''} sub="Windows asks for permission" href="/actions?fix=admin" />
          </div>
          <RevoNote revo={findings.data.revo} />
          <Tabs<Tab> label="Action Center" value={tab} onChange={setTab} items={[{ id: 'findings', label: 'Findings', count: list.length }, { id: 'history', label: 'Activity and undo', count: hist.data?.items.length }]}>
          {tab === 'findings' && (
            <Card flush>
              <div className="filters">
                <SearchBox value={text} onChange={setText} placeholder="Search findings" />
                <div className="seg" role="group" aria-label="Type">{KINDS.map((k) => <button key={k.id} aria-pressed={kind === k.id} onClick={() => setKind(k.id)}>{k.label}</button>)}</div>
                <span className="small muted">{shown.length} of {list.length}</span>{(ps.risk || ps.fix) && <button className="btn sm ghost" onClick={() => setPs({ risk: '', fix: '' })}>Clear {ps.risk ? `risk: ${ps.risk}` : ps.fix === 'admin' ? 'administrator filter' : 'fixable filter'}</button>}
              </div>
              <DataTable<Finding> label="Findings" cols={cols} rows={shown} rowKey={(f) => f.id} onRow={select} selected={selected?.id} initialSort={{ key: 'risk', dir: 1 }} persistKey="actions-findings"
                empty={<Empty icon="check" title="Nothing to fix">Guardian found nothing it can act on in the latest scans.</Empty>} />
            </Card>
          )}
          {tab === 'history' && (
            <Card flush>
              {hist.error ? <div className="pad"><ErrorState error={hist.error} onRetry={hist.reload} /></div> : !hist.data ? <div className="pad"><SkeletonCards n={1} /></div> : (<>
                <div className="filters"><span className="small muted">{hist.data.items.length} action(s)</span><CsvButton name="laptop-guardian-action-history" rows={hist.data.items} cols={[{ label: 'When', get: (h: HistoryItem) => h.ts }, { label: 'Action', get: (h: HistoryItem) => h.label }, { label: 'Action id', get: (h: HistoryItem) => h.actionId }, { label: 'Target', get: (h: HistoryItem) => h.target }, { label: 'Result', get: (h: HistoryItem) => h.result }, { label: 'Verified', get: (h: HistoryItem) => h.verified }, { label: 'Administrator', get: (h: HistoryItem) => h.elevated }, { label: 'Detail', get: (h: HistoryItem) => h.error || h.message }]} /></div>
                <DataTable<HistoryItem> label="Action history" cols={hcols} rows={hist.data.items} rowKey={(h) => h.id} initialSort={{ key: 'ts', dir: -1 }} persistKey="actions-history"
                  empty={<Empty icon="activity" title="No actions yet">Fixes you confirm, and ones Guardian refused, are listed here with their verified outcome.</Empty>} /></>
              )}
            </Card>
          )}
          </Tabs>
        </>
      )}
      {selected && (
        <Drawer title={selected.title} sub={<span className="row tight"><Icon name="bolt" size={13} />Action Center</span>} onClose={() => select(null)} back={back}>
          <FindingDetail finding={selected} flow={flow} />
        </Drawer>
      )}
      {flow.node}
    </div>
  );
}

