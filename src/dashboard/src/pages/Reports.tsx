import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, fetchText, useQuery } from '../api';
import type { Any, Report, ReportRow } from '../types';
import { Badge, Card, Drawer, Empty, ErrorState, PageHead, SearchBox, Seg, Skeleton, SkeletonCards, Tabs, useConfirm, useToast, Icon, DownloadButton } from '../components/ui';
import { ReportView } from '../components/ReportView';
import { fmtFull, scoreTone, NA } from '../format';
import { go, useHash } from '../router';

type Type = 'all' | 'daily' | 'weekly';
const key = (r: { type: string; id: string }) => `${r.type}/${r.id}`;

function OpenReport({ row, onClose }: { row: ReportRow; onClose: () => void }) {
  const q = useQuery<Report>(`/api/reports/${row.type}/${row.id}`);
  const [tab, setTab] = useState<'summary' | 'html' | 'json'>('summary');
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    if (tab !== 'html' || row.hasHtml === false || html !== null) return;
    let live = true;
    fetchText(`/api/reports/${row.type}/${row.id}/html`).then((t) => { if (live) setHtml(t); }).catch(() => { if (live) setHtml('<p>The rendered report could not be loaded.</p>'); });
    return () => { live = false; };
  }, [tab, row.type, row.id, row.hasHtml, html]);
  return (
    <Drawer title={`${row.type === 'daily' ? 'Daily' : 'Weekly'} report ${row.id}`} sub={fmtFull(row.generatedAt)} onClose={onClose}
      footer={<><DownloadButton path={`/api/reports/export?type=${row.type}&id=${row.id}&format=json`} name={`${row.type}-${row.id}.json`}><Icon name="download" size={13} />JSON</DownloadButton><DownloadButton path={`/api/reports/export?type=${row.type}&id=${row.id}&format=csv`} name={`${row.type}-${row.id}.csv`}><Icon name="download" size={13} />CSV</DownloadButton></>}>
      <Tabs value={tab} onChange={setTab} label="Report views" items={[{ id: 'summary', label: 'Summary' }, { id: 'html', label: 'Rendered report' }, { id: 'json', label: 'Raw data' }]} />
      {tab === 'summary' && (q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : q.data ? <ReportView r={q.data} /> : <Skeleton h={120} />)}
      {tab === 'html' && (row.hasHtml === false ? <Empty title="No rendered HTML for this report" /> : <iframe className="report-frame" title="Rendered report" sandbox="" srcDoc={html ?? ''} />)}
      {tab === 'json' && (q.data ? <pre className="mono-block" style={{ maxHeight: '65vh', overflow: 'auto', whiteSpace: 'pre-wrap' }}>{JSON.stringify(q.data, null, 2)}</pre> : <Skeleton h={120} />)}
    </Drawer>
  );
}

function Compare({ a, b, onClose }: { a: ReportRow; b: ReportRow; onClose: () => void }) {
  const qa = useQuery<Report>(`/api/reports/${a.type}/${a.id}`); const qb = useQuery<Report>(`/api/reports/${b.type}/${b.id}`);
  const rows: [string, (r: Report) => number | string | undefined | null, boolean?][] = [
    ['Health score', (r) => r.healthScore], ['CPU %', (r) => (r.sections as Any)?.system?.cpu?.usagePct], ['RAM %', (r) => (r.sections as Any)?.system?.ram?.usedPct],
    ['Disk free (GB)', (r) => (r.sections as Any)?.system?.disks?.[0]?.freeGB], ['Processes', (r) => (r.sections as Any)?.processes?.total], ['Flagged processes', (r) => (r.sections as Any)?.processes?.flagged],
    ['Startup items', (r) => (r.sections as Any)?.startup?.count], ['Defender threats', (r) => (r.sections as Any)?.defender?.threats], ['System event errors', (r) => (r.sections as Any)?.windowsHealth?.eventErrors?.system],
    ['Open recommendations', (r) => r.recommendations?.length], ['Duration (s)', (r) => r.durationSec], ['Status', (r) => r.status],
  ];
  return (
    <Drawer title="Compare reports" sub={`${key(a)} vs ${key(b)}`} onClose={onClose}>
      {!qa.data || !qb.data ? <Skeleton h={160} /> : (
        <Card flush><table className="t"><thead><tr><th>Metric</th><th className="r">{a.id}</th><th className="r">{b.id}</th><th className="r">Change</th></tr></thead>
          <tbody>{rows.map(([label, f]) => { const x = f(qa.data!); const y = f(qb.data!); const d = typeof x === 'number' && typeof y === 'number' ? y - x : null; const worse = d != null && d !== 0 && (label.startsWith('Disk') || label.startsWith('Health') ? d < 0 : d > 0);
            return <tr key={label}><td>{label}</td><td className="r num">{x ?? NA}</td><td className="r num">{y ?? NA}</td><td className={`r num ${d ? (worse ? 'diff-up' : 'diff-down') : ''}`}>{d == null ? '' : `${d > 0 ? '+' : ''}${Math.round(d * 10) / 10}`}</td></tr>; })}</tbody></table></Card>
      )}
      <div className="small muted">Red marks a change in the unhealthy direction, green the healthy direction.</div>
    </Drawer>
  );
}

export default function Reports() {
  const q = useQuery<ReportRow[]>('/api/reports');
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const { params } = useHash();
  const [type, setType] = useState<Type>('all');
  const [status, setStatus] = useState('');
  const [text, setText] = useState('');
  const [open, setOpen] = useState<ReportRow | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [cmp, setCmp] = useState(false);
  const rowsAll = useMemo(() => q.data ?? [], [q.data]);

  useEffect(() => {
    const t = params.get('type'); const id = params.get('id');
    if (t && id && q.data) { const r = q.data.find((x) => x.type === t && x.id === id); if (r) setOpen(r); }
  }, [params, q.data]);

  const rows = useMemo(() => rowsAll.filter((r) => (type === 'all' || r.type === type) && (!status || r.status === status) && (!text || `${r.id} ${r.summary?.headline} ${r.summary?.bullets?.join(' ')}`.toLowerCase().includes(text.toLowerCase()))), [rowsAll, type, status, text]);
  const togglePick = (r: ReportRow) => setPicked((p) => (p.includes(key(r)) ? p.filter((x) => x !== key(r)) : [...p.slice(-1), key(r)]));
  const pickedRows = picked.map((k) => rowsAll.find((r) => key(r) === k)).filter(Boolean) as ReportRow[];

  const del = (r: ReportRow) => confirm({
    title: `Delete ${r.type} report ${r.id}?`, confirmLabel: 'Delete report', danger: true,
    body: <>This permanently removes the data and rendered HTML from disk. Metrics and the action log are kept. No automatic retention is applied; this only happens because you asked.</>,
    onConfirm: async () => { try { await api.del(`/api/reports/${r.type}/${r.id}`); toast('ok', 'Report deleted.'); setPicked((p) => p.filter((x) => x !== key(r))); q.reload(); } catch (e) { toast('error', (e as ApiError).message); } },
  });

  return (
    <div className="page">
      <PageHead title="Reports" sub="Every daily and weekly run is saved as structured data plus a rendered page. Reports survive reboots and are only deleted when you delete them."
        actions={<button className="btn" disabled={pickedRows.length !== 2} onClick={() => setCmp(true)}><Icon name="compare" size={14} />Compare selected ({picked.length}/2)</button>} />
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <SkeletonCards n={3} h={70} /> : (
        <Card flush>
          <div className="filters">
            <SearchBox value={text} onChange={setText} placeholder="Search reports" />
            <Seg<Type> value={type} onChange={setType} label="Report type" items={[{ id: 'all', label: 'All' }, { id: 'daily', label: 'Daily' }, { id: 'weekly', label: 'Weekly' }]} />
            <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any status</option><option>complete</option><option>partial</option><option>failed</option></select>
            <span className="small muted">{rows.length} of {rowsAll.length}</span>
          </div>
          {rows.length === 0 ? <Empty icon="reports" title="No reports match">{rowsAll.length ? 'Clear the filters to see all reports.' : 'Reports appear after the first scan.'}</Empty> : (
            <div className="table-wrap" style={{ maxHeight: '68vh' }}>
              <table className="t" aria-label="Reports">
                <thead><tr><th style={{ width: 36 }}><span className="sr-only">Select for compare</span></th><th>Report</th><th>Generated</th><th className="r">Health</th><th>Status</th><th>Summary</th><th className="r">Size</th><th /></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={key(r)} className="click" tabIndex={0} onClick={() => { setOpen(r); go(`/reports?type=${r.type}&id=${r.id}`); }} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(r); }}>
                    <td onClick={(e) => e.stopPropagation()}><input type="checkbox" aria-label={`Select ${r.id} for comparison`} checked={picked.includes(key(r))} onChange={() => togglePick(r)} /></td>
                    <td><Badge tone={r.type === 'weekly' ? 'info' : ''}>{r.type}</Badge> <b>{r.id}</b></td>
                    <td className="small t2">{fmtFull(r.generatedAt)}</td>
                    <td className="r"><Badge tone={scoreTone(r.healthScore)}>{r.healthScore ?? NA}</Badge></td>
                    <td><Badge tone={r.status === 'complete' ? 'ok' : 'warn'} dot>{r.status}</Badge></td>
                    <td className="t2 trunc" style={{ maxWidth: 360 }}>{r.summary?.headline}</td>
                    <td className="r num small muted">{r.sizeKB} KB</td>
                    <td onClick={(e) => e.stopPropagation()}><span className="row tight" style={{ flexWrap: 'nowrap' }}>
                      <DownloadButton className="btn sm" path={`/api/reports/export?type=${r.type}&id=${r.id}&format=json`} name={`${r.type}-${r.id}.json`} ariaLabel={`Export ${r.id}`}><Icon name="download" size={13} />Export</DownloadButton>
                      <button className="btn sm danger" onClick={() => del(r)} aria-label={`Delete ${r.id}`}><Icon name="trash" size={13} /></button></span></td>
                  </tr>))}</tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      {open && <OpenReport row={open} onClose={() => { setOpen(null); if (params.get('id')) go('/reports'); }} />}
      {cmp && pickedRows.length === 2 && <Compare a={pickedRows[0]} b={pickedRows[1]} onClose={() => setCmp(false)} />}
      {node}
    </div>
  );
}
