import { downloadCsv, type CsvCol } from '../csv';
import { Icon } from './ui';

/** Exports the rows the table is showing (filters applied) as a CSV file. */
export function CsvButton<T>({ name, cols, rows, label = 'Export CSV' }: { name: string; cols: CsvCol<T>[]; rows: T[]; label?: string }) {
  const stamp = new Date().toISOString().slice(0, 10);
  return <button className="btn sm" disabled={rows.length === 0} title={rows.length ? `Download the ${rows.length} row(s) shown` : 'Nothing to export'} onClick={() => downloadCsv(`${name}-${stamp}.csv`, cols, rows)}><Icon name="download" size={13} />{label}</button>;
}
