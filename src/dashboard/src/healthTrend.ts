/** Which factors cost the health score points over the last runs, from the reasons stored with each metrics row. Pure. */
export interface Deduction { text: string; runs: number; avgPoints: number; latest: boolean }

export function deductionTrend(rows: { healthReasons?: string[] }[], last = 30): { runs: number; items: Deduction[] } {
  const recent = rows.filter((r) => Array.isArray(r.healthReasons)).slice(-last);
  const by = new Map<string, { n: number; pts: number }>();
  for (const r of recent) for (const raw of r.healthReasons || []) {
    const m = /^-(\d+)\s+(.*)$/.exec(raw); if (!m) continue;
    const e = by.get(m[2]) || { n: 0, pts: 0 }; e.n++; e.pts += Number(m[1]); by.set(m[2], e);
  }
  const latest = new Set(((recent[recent.length - 1] || {}).healthReasons || []).map((x) => x.replace(/^-\d+\s+/, '')));
  const items = [...by.entries()].map(([text, e]) => ({ text, runs: e.n, avgPoints: Math.round((e.pts / e.n) * 10) / 10, latest: latest.has(text) })).sort((a, b) => b.runs - a.runs || b.avgPoints - a.avgPoints).slice(0, 6);
  return { runs: recent.length, items };
}
