import { createContext, useContext } from 'react';
import type { Query } from '../api';
import type { Overview } from '../types';

/** The shared `/api/overview` query, provided once by <App> so pages do not each refetch it. */
export const OverviewContext = createContext<Query<Overview> | null>(null);

export function useOverview(): Query<Overview> {
  const q = useContext(OverviewContext);
  if (!q) throw new Error('useOverview must be used inside the app shell');
  return q;
}
