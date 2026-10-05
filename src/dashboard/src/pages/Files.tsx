import { useState } from 'react';
import { api, ApiError, useQuery } from '../api';
import type { FileCandidate, FilesData, Metric } from '../types';
import { Badge, Card, Col, DataTable, Empty, ErrorState, KV, PageHead, RiskBadge, SkeletonCards, Stat, Tabs, useToast, Icon } from '../components/ui';
import { LineChart, RangeSelect, Range, filterRange, SERIES_COLORS } from '../components/Chart';
import { fmtDate, fmtMB, NA } from '../format';
import { useActionFlow } from '../components/ActionFlow';

type Tab = 'overview' | 'large' | 'duplicates' | 'recommended' | 'ignored' | 'trends';
const CLS_TONE: Record<string, string> = { KEEP: 'ok', REVIEW: 'info', LIKELY_UNNECESSARY: 'warn', HIGH_RISK: 'crit', UNKNOWN: '' };

function FileCard({ f, onIgnore, onRecycle }: { f: FileCandidate; onIgnore: (f: FileCandidate) => void; onRecycle: (f: FileCandidate) => void }) {
  return (
    <article className="card" style={{ padding: 14, display: 'grid', gap: 8 }} aria-label={f.name}>
      <div className="row spread" style={{ flexWrap: 'nowrap' }}>
        <div style={{ minWidth: 0 }}><b className="trunc" style={{ display: 'block' }}>{f.name}</b><div className="path trunc" title={f.path}>{f.path}</div></div>
        <Badge tone={CLS_TONE[f.classification]}>{f.classification.replace('_', ' ')}</Badge>
      </div>
      <p className="t2">{f.whatIsIt}</p>
      <div><div className="small muted">Why flagged</div><ul style={{ margin: '2px 0 0', paddingLeft: 18 }}>{(f.whyFlagged || []).map((w) => <li key={w}>{w}</li>)}</ul></div>
      <KV items={[['Size', <b key="s" className="num">{fmtMB(f.sizeMB)}</b>], ['Last modified', `${fmtDate(f.lastModified)}${f.ageDays != null ? ` (${f.ageDays} d ago)` : ''}`], ['Duplicate', f.duplicateOf ? <code key="d">{f.duplicateOf}</code> : 'No'], ['Used by software', f.referencedBySoftware == null ? 'Unknown' : f.referencedBySoftware ? 'Yes' : 'No'], ['If deleted', f.ifDeleted]]} />
      <div className="row spread"><span className="row tight"><RiskBadge risk={f.risk} /><span className="small t2">{f.recommendedAction}</span></span>
        <span className="row tight">
          <button className="btn sm" onClick={() => onIgnore(f)}>{f.ignored ? 'Stop ignoring' : 'Ignore'}</button>
          {f.classification !== 'KEEP' && <button className="btn sm danger" onClick={() => onRecycle(f)}><Icon name="trash" size={13} />Recycle file</button>}
        </span></div>
    </article>
  );
}

export default function Files() {
  const q = useQuery<FilesData>('/api/files');
  const m = useQuery<Metric[]>('/api/metrics?range=all');
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('overview');
  const [range, setRange] = useState<Range>(30);
  const [cls, setCls] = useState('');
  const d = q.data;
  const cands = d?.candidates || [];
  const active = cands.filter((c) => !c.ignored);
  const ignored = cands.filter((c) => c.ignored);

  const ignore = async (f: FileCandidate) => {
    try { await api.post('/api/files/ignore', { id: f.id, ignored: !f.ignored }); toast('ok', f.ignored ? 'No longer ignored.' : 'Ignored. It will not be recommended again.'); q.reload(); } catch (e) { toast('error', (e as ApiError).message); }
  };
  // Recycling goes through the confirmed Action flow: the exact path, size and age are shown, and Guardian re-checks the file first.
  const flow = useActionFlow(() => q.reload());
  const recycle = (f: FileCandidate) => void flow.run('file.recycle', { path: f.path }, 'Recycle file');

  const reclaim = active.filter((c) => c.classification === 'LIKELY_UNNECESSARY' || c.classification === 'REVIEW').reduce((a, c) => a + c.sizeMB, 0);
  const metrics = filterRange(m.data || [], range);
  const fileCols: Col<{ path: string; sizeMB: number; lastModified?: string }>[] = [
    { key: 'path', label: 'Path', sort: (r) => r.path.toLowerCase(), render: (r) => <span className="path">{r.path}</span> },
    { key: 'size', label: 'Size', sort: (r) => r.sizeMB, align: 'r', render: (r) => <span className="num">{fmtMB(r.sizeMB)}</span> },
    { key: 'mod', label: 'Modified', sort: (r) => r.lastModified || '', render: (r) => <span className="small t2">{fmtDate(r.lastModified)}</span> },
  ];
  const clsFiltered = active.filter((c) => !cls || c.classification === cls);

  return (
    <div className="page">
      <PageHead title="Files & Storage" sub={d?.generatedAt ? `Weekly storage scan from ${fmtDate(d.generatedAt)}. Guardian never deletes files on its own; Recycle Bin moves need your confirmation.` : 'Storage analysis runs weekly.'} />
      {q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !d ? <SkeletonCards n={4} /> : (
        <>
          <Tabs<Tab> value={tab} onChange={setTab} label="Storage views" items={[{ id: 'overview', label: 'Overview' }, { id: 'large', label: 'Large files', count: d.largest?.length }, { id: 'duplicates', label: 'Duplicates', count: d.duplicates?.length }, { id: 'recommended', label: 'Recommended', count: active.length }, { id: 'ignored', label: 'Ignored', count: ignored.length }, { id: 'trends', label: 'Trends' }]} />
          {tab === 'overview' && (
            <>
              <div className="grid g4">
                {(d.drives || []).map((dr) => <Stat key={dr.drive} label={`${dr.drive} ${dr.type || ''}`} value={dr.freeGB.toFixed(0)} unit=" GB free" sub={`of ${dr.totalGB.toFixed(0)} GB`} bar={100 - (dr.freeGB / dr.totalGB) * 100} tone={dr.freeGB / dr.totalGB < 0.08 ? 'crit' : dr.freeGB / dr.totalGB < 0.15 ? 'warn' : 'ok'} />)}
                <Stat label="Downloads" value={d.downloads?.sizeGB?.toFixed(1) ?? NA} unit=" GB" sub={`${d.downloads?.count ?? 0} files - ${d.downloads?.oldCount ?? 0} older than a year`} />
                <Stat label="Worth reviewing" value={active.length} sub={`${fmtMB(reclaim)} potentially reclaimable`} />
                <Stat label="Duplicate groups" value={d.duplicates?.length ?? 0} sub="Identical content by hash" />
              </div>
              <Card title="Classifications"><div className="row">{['KEEP', 'REVIEW', 'LIKELY_UNNECESSARY', 'HIGH_RISK', 'UNKNOWN'].map((c) => <Badge key={c} tone={CLS_TONE[c]}>{c.replace('_', ' ')} - {active.filter((x) => x.classification === c).length}</Badge>)}</div>
                <p className="small muted" style={{ marginTop: 8 }}>When Guardian is unsure it chooses REVIEW. Personal documents are classified KEEP and are never suggested for removal.</p></Card>
            </>
          )}
          {tab === 'large' && <Card flush><DataTable label="Largest files" cols={fileCols} rows={d.largest || []} rowKey={(r) => r.path} initialSort={{ key: 'size', dir: -1 }} empty={<Empty title="No large files recorded" />} /></Card>}
          {tab === 'duplicates' && (d.duplicates?.length ? <div className="grid g2">{d.duplicates.map((g, i) => <Card key={g.hash || i} title={`Group ${g.hash?.slice(0, 8) || i + 1}`} actions={<Badge>{fmtMB(g.sizeMB)} each</Badge>}><div className="stack">{g.files.map((p) => <div key={p} className="path">{p}</div>)}<div className="small muted">Keep one copy. Review before removing the others; Guardian does not pick for you.</div></div></Card>)}</div> : <Card><Empty icon="check" title="No duplicates found" /></Card>)}
          {tab === 'recommended' && (
            <>
              <div className="row"><select aria-label="Classification" value={cls} onChange={(e) => setCls(e.target.value)}><option value="">All classifications</option>{['KEEP', 'REVIEW', 'LIKELY_UNNECESSARY', 'HIGH_RISK', 'UNKNOWN'].map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}</select><span className="small muted">{clsFiltered.length} files</span></div>
              {clsFiltered.length ? <div className="grid g2">{clsFiltered.map((f) => <FileCard key={f.id} f={f} onIgnore={ignore} onRecycle={recycle} />)}</div> : <Card><Empty icon="check" title="Nothing to review" /></Card>}
            </>
          )}
          {tab === 'ignored' && (ignored.length ? <div className="grid g2">{ignored.map((f) => <FileCard key={f.id} f={f} onIgnore={ignore} onRecycle={recycle} />)}</div> : <Card><Empty title="No ignored files">Files you ignore are kept here and never recommended again.</Empty></Card>)}
          {tab === 'trends' && (
            <div className="stack">
              <div className="row spread"><h2>Storage over time</h2><RangeSelect value={range} onChange={setRange} /></div>
              <div className="grid g2">
                <Card title="Free space"><LineChart title="Free disk space" x={metrics.map((r) => r.ts)} unit=" GB" area series={[{ id: 'f', label: 'Free', color: SERIES_COLORS.disk, values: metrics.map((r) => r.diskFreeGB) }]} hideLegend /></Card>
                <Card title="Downloads size"><LineChart title="Downloads" x={metrics.map((r) => r.ts)} unit=" GB" series={[{ id: 'd', label: 'Downloads', color: SERIES_COLORS.ram, values: metrics.map((r) => r.downloadsGB) }]} hideLegend /></Card>
              </div>
            </div>
          )}
        </>
      )}
      {flow.node}
    </div>
  );
}
