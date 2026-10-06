import { createContext, useContext } from 'react';
import type { Query } from '../api';
import type { Finding, HistoryItem, RevoInfo } from '../types';

export type FindingsData = { generatedAt: string; revo: RevoInfo | null; findings: Finding[] };
export type HistoryData = { items: HistoryItem[] };

/** The shared Action Center queries, provided once by <App>, so the Action Center, Health, Recommendations and Network Guard do not each fetch them again. */
export const FindingsContext = createContext<Query<FindingsData> | null>(null);
export const RemediationHistoryContext = createContext<Query<HistoryData> | null>(null);

export function useFindings(): Query<FindingsData> {
  const q = useContext(FindingsContext);
  if (!q) throw new Error('useFindings must be used inside the app shell');
  return q;
}
export function useRemediationHistory(): Query<HistoryData> {
  const q = useContext(RemediationHistoryContext);
  if (!q) throw new Error('useRemediationHistory must be used inside the app shell');
  return q;
}
