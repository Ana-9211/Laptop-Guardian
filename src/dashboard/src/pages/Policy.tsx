import { useState } from 'react';
import type React from 'react';
import { api, ApiError, useQuery } from '../api';
import type { ActionEvent, Policy, PolicyEntry } from '../types';
import { Badge, Card, Col, DataTable, Drawer, Empty, ErrorState, Icon, KV, PageHead, useOverlay, SkeletonCards, useConfirm, useToast } from '../components/ui';
import { ActionTimeline } from '../components/common';
import { fmtDate, fmtFull, NA } from '../format';
import { useOverview } from '../state/overview';
import { PolicyDialog } from '../components/ProcessDrawer';

export function PolicyPage({ list }: { list: 'blacklist' | 'whitelist' }) {
  const pol = useQuery<Policy>('/api/policy');
  const ov = useOverview();
  const toast = useToast();
  const { confirm, node } = useConfirm();
  const [hist, setHist] = useState<PolicyEntry | null>(null);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [dlg, setDlg] = useState<string | null>(null);
  const isBl = list === 'blacklist';
  const rows = pol.data?.[list] || [];
  const s = ov.data?.safety;

  const patch = async (e: PolicyEntry, body: object, msg: string) => {
    const before: Record<string, unknown> = {}; for (const k of Object.keys(body)) before[k] = (e as unknown as Record<string, unknown>)[k] ?? null;
    try {
      await api.patch(`/api/policy/${list}/${e.id}`, body);
      toast('ok', msg, { undo: async () => { try { await api.patch(`/api/policy/${list}/${e.id}`, before); toast('ok', 'Change undone.'); pol.reload(); } catch (x) { toast('error', (x as ApiError).message); } } });
      pol.reload();
    } catch (x) { toast('error', (x as ApiError).message); }
  };
  const remove = (e: PolicyEntry) => confirm({
    title: `Remove ${e.name} from the ${list}?`, confirmLabel: 'Remove', 
    body: isBl ? <>Guardian will stop terminating <code>{e.name}</code>. If it is a nuisance it will be flagged again by the normal checks.</> : <>Guardian may flag and recommend <code>{e.name}</code> again.</>,
    onConfirm: async () => {
      try {
        await api.del(`/api/policy/${list}/${e.id}`);
        toast('ok', `${e.name} removed.`, { undo: async () => { try { await api.post('/api/policy', { list, name: e.name, path: e.path || undefined, reason: e.reason || undefined }); toast('ok', `${e.name} is back on the ${list}.`); pol.reload(); } catch (x) { toast('error', (x as ApiError).message); } } });
        pol.reload();
      } catch (x) { toast('error', (x as ApiError).message); }
    },
  });
  const pause = (e: PolicyEntry) => {
    const until = new Date(Date.now() + 7 * 86400000).toISOString();
    patch(e, { disabledUntil: until }, `${e.name} paused for 7 days.`);
  };

  const cols: Col<PolicyEntry>[] = [
    { key: 'name', label: 'Process', sort: (e) => e.name.toLowerCase(), render: (e) => <b>{e.name}</b> },
    { key: 'added', label: 'Date added', sort: (e) => e.addedAt || '', render: (e) => <span className="small t2 nowrap">{fmtDate(e.addedAt)}</span> },
    { key: 'reason', label: 'Reason', render: (e) => <span className="t2" style={{ minWidth: 160, maxWidth: 260, display: 'inline-block' }}>{e.reason || <span className="muted">none given</span>}</span> },
    ...(isBl ? [
      { key: 'act', label: 'Automatic action', render: () => <Badge tone={s?.safeMode || s?.automationPaused || !s?.autoKillBlacklisted ? 'warn' : 'crit'}>{s?.safeMode || s?.automationPaused || !s?.autoKillBlacklisted ? 'Terminate (held)' : 'Terminate daily'}</Badge> },
      { key: 'count', label: 'Terminated', sort: (e: PolicyEntry) => e.terminatedCount || 0, render: (e: PolicyEntry) => <span className="num">{e.terminatedCount || 0}x</span>, align: 'r' as const },
      { key: 'last', label: 'Last', sort: (e: PolicyEntry) => e.lastTerminatedAt || '', render: (e: PolicyEntry) => <span className="small t2 nowrap">{e.lastTerminatedAt ? fmtDate(e.lastTerminatedAt) : NA}</span> },
    ] : []),
    { key: 'path', label: 'Executable path', render: (e) => <span className="path trunc" style={{ display: 'inline-block', maxWidth: 200, verticalAlign: 'middle' }} title={e.path || ''}>{e.path || 'any path'}</span> },
    { key: 'status', label: 'Policy status', sort: (e) => (e.enabled ? 1 : 0), render: (e) => { const paused = e.disabledUntil && Date.parse(e.disabledUntil) > Date.now(); return paused ? <Badge tone="warn" dot>Paused until {fmtDate(e.disabledUntil)}</Badge> : <Badge tone={e.enabled ? 'ok' : ''} dot>{e.enabled ? 'Active' : 'Disabled'}</Badge>; } },
    { key: 'ops', label: '', render: (e) => (
      <span className="row tight" style={{ flexWrap: 'nowrap' }} onClick={(ev) => ev.stopPropagation()}>
        <button className="btn sm" onClick={() => patch(e, { enabled: !e.enabled, disabledUntil: null }, `${e.name} ${e.enabled ? 'disabled' : 'enabled'}.`)}>{e.enabled ? 'Disable' : 'Enable'}</button>
        {isBl && e.enabled && <button className="btn sm" onClick={() => pause(e)}>Pause 7 d</button>}
        <button className="btn sm" onClick={() => setHist(e)}>History</button>
        <button className="btn sm danger" onClick={() => remove(e)}>Remove</button>
      </span>) },
  ];

  return (
    <div className="page">
      <PageHead title={isBl ? 'Blacklist' : 'Whitelist'}
        sub={isBl ? 'Processes you chose to terminate automatically. Only entries here are ever stopped by the daily agent; unknown processes never are.' : 'Processes Guardian will never flag or recommend. Whitelisting does not prevent you from stopping a process manually.'}
        actions={<button className="btn primary" onClick={() => setAdding(true)}><Icon name={isBl ? 'blacklist' : 'whitelist'} size={14} />Add process</button>} />
      {isBl && (s?.safeMode || s?.automationPaused || s?.autoKillBlacklisted === false) && (
        <div className="notice warn"><b>Automatic termination is currently held.</b> {s?.safeMode ? 'Safe mode is on.' : s?.automationPaused ? 'Automation is paused.' : 'Automatic blacklisted-process termination is turned off.'} Entries below are recorded but not enforced. <a href="#/settings">Change in Settings</a>.</div>
      )}
      {pol.error ? <ErrorState error={pol.error} onRetry={pol.reload} /> : !pol.data ? <SkeletonCards n={2} /> : (
        <Card flush>
          <DataTable stickyLast label={list} cols={cols} rows={rows} rowKey={(e) => e.id} onRow={setHist}
            empty={<Empty icon={isBl ? 'blacklist' : 'whitelist'} title={`No processes on the ${list}`}>{isBl ? 'Blacklist a process from its detail panel on the Processes page, or add one by name here.' : 'Whitelist a process from its detail panel to stop it being flagged.'}</Empty>} />
        </Card>
      )}
      {!isBl && pol.data && (
        <Card title={`Ignored processes (${pol.data.ignored.length})`} flush>
          {pol.data.ignored.length === 0 ? <Empty icon="check" title="Nothing is ignored">When you choose Ignore on a recommendation, the program appears here so you can bring it back.</Empty> : (
            <ul className="plain-list" style={{ padding: '0 14px' }}>
              {pol.data.ignored.map((e) => (
                <li key={e.id} className="row spread" style={{ padding: '8px 0' }}>
                  <span className="stack tight"><b>{e.name}</b><span className="small muted">Ignored {fmtDate(e.addedAt)}{e.path ? ` - ${e.path}` : ' - any path'}</span></span>
                  <button className="btn sm" onClick={() => { void api.del(`/api/policy/ignored/${e.id}`).then(() => { toast('ok', `${e.name} will be flagged again if it misbehaves.`, { undo: async () => { try { await api.post('/api/policy', { list: 'ignored', name: e.name, path: e.path || undefined, reason: e.reason || undefined }); toast('ok', `${e.name} is ignored again.`); pol.reload(); } catch (x2) { toast('error', (x2 as ApiError).message); } } }); pol.reload(); }).catch((x: ApiError) => toast('error', x.message)); }}>Stop ignoring</button>
                </li>
              ))}
            </ul>
          )}
          <p className="small muted pad">Ignoring hides recommendations about a program. It does not whitelist it and never prevents you from stopping it.</p>
        </Card>
      )}
      {adding && <AddDialog list={list} name={newName} setName={setNewName} onClose={() => setAdding(false)} onNext={() => { setDlg(newName.trim()); setAdding(false); }} />}
      {dlg && <PolicyDialog list={list} name={dlg} onClose={() => setDlg(null)} onDone={() => { setDlg(null); setNewName(''); pol.reload(); }} />}
      {hist && <PolicyHistory entry={hist} onClose={() => setHist(null)} />}
      {node}
    </div>
  );
}

function AddDialog({ list, name, setName, onClose, onNext }: { list: string; name: string; setName: (v: string) => void; onClose: () => void; onNext: () => void }) {
  const ref = useOverlay(onClose);
  return (
    <>
      <div className="scrim" style={{ zIndex: 62 }} onClick={onClose} />
      <form className="dialog" style={{ zIndex: 66 }} role="dialog" aria-modal="true" aria-label={`Add a process to the ${list}`} ref={ref as React.RefObject<HTMLFormElement & HTMLDivElement>} tabIndex={-1} onSubmit={(e) => { e.preventDefault(); if (name.trim()) onNext(); }}>
        <div className="card-body"><h2>Add a process to the {list}</h2>
          <label className="field"><span>Process name (without .exe)</span><input data-autofocus value={name} onChange={(e) => setName(e.target.value)} maxLength={128} placeholder="e.g. updater" /></label>
          <div className="hint">Matches by name on any path. To limit a rule to one executable path, use the process detail panel.</div></div>
        <div className="dialog-foot"><button type="button" className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!name.trim()}>Continue</button></div>
      </form>
    </>
  );
}

function PolicyHistory({ entry, onClose }: { entry: PolicyEntry; onClose: () => void }) {
  const q = useQuery<ActionEvent[]>(`/api/actions?q=${encodeURIComponent(entry.name)}&limit=100`);
  return (
    <Drawer title={entry.name} sub={`Policy history - added ${fmtFull(entry.addedAt)}`} onClose={onClose}>
      <Card title="Entry"><KV items={[['Process', entry.name], ['Executable path', entry.path || 'any path'], ['Reason', entry.reason || 'none given'], ['Added', `${fmtFull(entry.addedAt)} by ${entry.addedBy === 'user' ? 'you' : entry.addedBy || NA}`], ['Automatic action', entry.action === 'terminate' ? 'Terminate when found (only if Safe Mode is off)' : 'None'], ['State', entry.disabledUntil && Date.parse(entry.disabledUntil) > Date.now() ? `Paused until ${fmtFull(entry.disabledUntil)}` : entry.enabled ? 'Active' : 'Disabled'], ['Terminated so far', `${entry.terminatedCount ?? 0} time(s)${entry.lastTerminatedAt ? `, last ${fmtFull(entry.lastTerminatedAt)}` : ''}`]]} /></Card>
      <Card title="Related actions">{q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <SkeletonCards n={1} /> : q.data.length ? <ActionTimeline rows={q.data} max={50} /> : <Empty title="No related actions" />}</Card>
    </Drawer>
  );
}

export const BlacklistPage = () => <PolicyPage list="blacklist" />;
export const WhitelistPage = () => <PolicyPage list="whitelist" />;
