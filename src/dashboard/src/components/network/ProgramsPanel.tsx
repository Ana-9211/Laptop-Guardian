import { useQuery } from '../../api';
import { Badge, Card, Col, DataTable, Empty, ErrorState, SkeletonCards } from '../ui';
import { BarChart } from '../Chart';
import { ActionButton } from '../ActionFlow';
import { CsvButton } from '../CsvButton';
import type { Flow } from './shared';
import { signedBadge } from './shared';
import { ago, fmtFull } from '../../format';

export interface ProgramRow { name: string; path: string | null; signed: boolean | null; publisher: string | null; pid: number; startTime: string | null; connections: number; established: number; listening: number; remoteHosts: number; firstSeen: string | null; lastSeen: string | null; bytes: number | null }
interface ProgramsData { generatedAt: string | null; programs: ProgramRow[]; timeline: { source: 'deep' | 'snapshots'; unit: string; buckets: { ts: string; opens: number; closes: number }[] }; bytesNote: string }

/** One row per program (connections, distinct remote hosts, first seen), a simple activity timeline, and the same confirmed block and stop buttons as elsewhere. */
export function ProgramsPanel({ flow }: { flow: Flow }) {
  const q = useQuery<ProgramsData>('/api/network/programs');
  const d = q.data;
  const cols: Col<ProgramRow>[] = [
    { key: 'name', label: 'Program', sort: (p) => p.name.toLowerCase(), render: (p) => <span className="stack tight"><a href={`#/network?tab=connections&q=${encodeURIComponent(p.name)}&state=&unsigned=`} title="Show this program's connections"><b>{p.name}</b></a><span className="small muted num">PID {p.pid}</span></span> },
    { key: 'sig', label: 'Signature', sort: (p) => String(p.signed), render: (p) => signedBadge(p) },
    { key: 'conn', label: 'Connections', align: 'r', sort: (p) => p.connections, render: (p) => <a className="num" href={`#/network?tab=connections&q=${encodeURIComponent(p.name)}&state=&unsigned=`}>{p.connections}</a> },
    { key: 'hosts', label: 'Remote hosts', align: 'r', sort: (p) => p.remoteHosts, render: (p) => <span className="num">{p.remoteHosts}</span> },
    { key: 'listen', label: 'Listening', align: 'r', sort: (p) => p.listening, render: (p) => (p.listening ? <a className="num" href="#/network?tab=listening">{p.listening}</a> : <span className="muted">0</span>) },
    { key: 'first', label: 'First seen', sort: (p) => p.firstSeen || '', render: (p) => (p.firstSeen ? <span className="small" title={fmtFull(p.firstSeen)}>{ago(p.firstSeen)}</span> : <span className="small muted" title="Deep Network Guard has not recorded this program">unknown</span>) },
    { key: 'bytes', label: 'Bytes', align: 'r', render: () => <span className="small muted" title={d?.bytesNote}>n/a</span> },
    { key: 'act', label: '', render: (p) => (
      <span className="row tight" style={{ flexWrap: 'nowrap' }}>
        <ActionButton actionId="firewall.block-program" params={{ path: p.path || '', direction: 'Outbound', duration: '24h' }} label="Block 24 h" disabled={!p.path} title={p.path ? 'Block this program outbound for 24 hours' : 'Guardian cannot read this program\'s path'} flow={flow} />
        <ActionButton actionId="process.stop" params={{ pid: p.pid, name: p.name, ...(p.path ? { path: p.path } : {}), ...(p.startTime ? { startTime: p.startTime } : {}) }} label="Stop" tone="danger" flow={flow} />
      </span>) },
  ];
  const t = d?.timeline;
  return (
    <div className="stack-lg">
      <Card title="Activity timeline" actions={t && <Badge tone="outline">{t.source === 'deep' ? 'Deep Network Guard, per hour' : 'snapshots, last 24 h'}</Badge>}>
        {!t ? <SkeletonCards n={1} h={120} /> : t.buckets.length === 0 ? <Empty icon="network" title="No activity recorded yet">Take snapshots, or turn on Deep Network Guard, to build a timeline.</Empty>
          : <BarChart title={t.source === 'deep' ? 'Connections opened per hour' : 'Established connections per snapshot'} x={t.buckets.map((b) => b.ts)} values={t.buckets.map((b) => b.opens)} color="var(--accent)" />}
        {t?.source === 'snapshots' && <p className="small muted">Deep Network Guard is off, so this shows the established-connection count at each snapshot rather than every connection.</p>}
      </Card>
      <Card flush title="Programs" actions={d && <CsvButton name="laptop-guardian-network-programs" rows={d.programs} cols={[{ label: 'Program', get: (p: ProgramRow) => p.name }, { label: 'PID', get: (p: ProgramRow) => p.pid }, { label: 'Signed', get: (p: ProgramRow) => p.signed }, { label: 'Publisher', get: (p: ProgramRow) => p.publisher }, { label: 'Connections', get: (p: ProgramRow) => p.connections }, { label: 'Remote hosts', get: (p: ProgramRow) => p.remoteHosts }, { label: 'Listening', get: (p: ProgramRow) => p.listening }, { label: 'First seen', get: (p: ProgramRow) => p.firstSeen }, { label: 'Path', get: (p: ProgramRow) => p.path }]} />}>
        {q.error ? <div className="pad"><ErrorState error={q.error} onRetry={q.reload} /></div> : !d ? <div className="pad"><SkeletonCards n={1} /></div>
          : <DataTable<ProgramRow> label="Programs on the network" cols={cols} rows={d.programs} rowKey={(p) => p.path || `${p.name}:${p.pid}`} initialSort={{ key: 'conn', dir: -1 }} persistKey="network-programs" empty={<Empty icon="network" title="No snapshot yet">Take a network snapshot first.</Empty>} />}
      </Card>
      <p className="small muted">Bytes are not shown: Windows does not report them per connection without capturing traffic, which Guardian never does.</p>
    </div>
  );
}
