/** CSV export of what a table currently shows. Built in the browser from data the page already holds; nothing is sent anywhere. */
export interface CsvCol<T> { label: string; get: (row: T) => unknown }

/** One cell: quoted when needed, and text that a spreadsheet would run as a formula (starts with = + - @ or a tab) is prefixed with an apostrophe. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCsv<T>(cols: CsvCol<T>[], rows: T[]): string {
  return [cols.map((c) => csvCell(c.label)).join(','), ...rows.map((r) => cols.map((c) => csvCell(c.get(r))).join(','))].join('\r\n') + '\r\n';
}
export function downloadCsv<T>(name: string, cols: CsvCol<T>[], rows: T[]) {
  const blob = new Blob(['\uFEFF' + toCsv(cols, rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
