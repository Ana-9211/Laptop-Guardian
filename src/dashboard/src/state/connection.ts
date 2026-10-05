// Pure model of "what is the dashboard's live connection doing". No React, no I/O, so it is unit-testable.
// StatusProvider owns the single poll loop and feeds this model; every status chip, banner and button reads the result.
import type { StatusData } from '../types';
import { POLL_MS, STALE_AFTER_MS } from '../config.ts';

export type Link = 'connecting' | 'online' | 'offline';
export type RunState = StatusData['run'];
export interface FinishedScan { type: string; mode?: string; at: string }

export type ScanPhase =
  | { phase: 'idle' }
  | { phase: 'running'; type: string; mode?: string; startedAt?: string; stepName?: string; elapsedSec?: number | null; shutdownPossible?: boolean }
  | { phase: 'finished'; type: string; at: string };

export interface LiveState {
  /** connecting = nothing received yet; online = last poll succeeded; offline = last poll failed. */
  link: Link;
  /** A manual refresh is in flight (polls are silent and never set this). */
  refreshing: boolean;
  scan: ScanPhase;
  /** We are showing data that may be out of date: offline, or no successful poll recently. */
  stale: boolean;
  /** Task Scheduler rows are still loading on a cold start. */
  schedulePending: boolean;
  /** The user was sent a UAC prompt that has not been answered yet. */
  elevationPending: boolean;
  errorMessage: string | null;
}

export interface LiveInputs {
  hasStatus: boolean;
  status: StatusData | null;
  failed: boolean;
  errorMessage: string | null;
  refreshing: boolean;
  finished: FinishedScan | null;
  /** No successful poll for STALE_AFTER_MS (see isAged). */
  aged: boolean;
}

export const isAged = (lastOkAt: number | null, now: number): boolean => lastOkAt != null && now - lastOkAt > STALE_AFTER_MS;

export function deriveLive(i: LiveInputs): LiveState {
  const link: Link = i.failed ? 'offline' : i.hasStatus ? 'online' : 'connecting';
  const running = i.status?.run.running;
  const scan: ScanPhase = running
    ? { phase: 'running', type: running.type, mode: running.mode, startedAt: running.startedAt, stepName: running.phase, elapsedSec: running.elapsedSec, shutdownPossible: running.shutdownPossible }
    : i.finished ? { phase: 'finished', type: i.finished.type, at: i.finished.at } : { phase: 'idle' };
  return {
    link, refreshing: i.refreshing, scan,
    stale: link === 'offline' || (link === 'online' && i.aged),
    schedulePending: !!i.status?.schedule.pending,
    elevationPending: !!i.status?.schedule.elevationPending,
    errorMessage: i.errorMessage,
  };
}

/** Run identity used to notice that a scan completed even when it started and ended between two polls. */
export const finishKey = (s: StatusData) => `${s.run.lastDaily?.finishedAt || ''}|${s.run.lastWeekly?.finishedAt || ''}`;

/**
 * A scan counts as finished when we saw it running and it stopped, or when a run's recorded finish time changed
 * (short scans can fall entirely between two polls). Returns null when nothing finished.
 */
export function detectFinished(prevRunning: RunState['running'], prevKey: string | null, next: StatusData): FinishedScan | null {
  const cur = next.run.running || null;
  if (prevRunning && !cur) return { type: prevRunning.type, mode: prevRunning.mode, at: next.now };
  const key = finishKey(next);
  if (prevKey !== null && prevKey !== key) {
    const dailyChanged = prevKey.split('|')[0] !== key.split('|')[0];
    return { type: dailyChanged ? 'daily' : 'weekly', at: next.now };
  }
  return null;
}

/** How long to wait before the next status poll, given what the dashboard currently knows. */
export function nextPollDelay(live: Pick<LiveState, 'link' | 'scan' | 'schedulePending' | 'elevationPending'>): number {
  if (live.link === 'offline') return POLL_MS.offline;
  if (live.scan.phase === 'running') return POLL_MS.scan;
  if (live.schedulePending || live.elevationPending) return POLL_MS.elevation;
  return POLL_MS.idle;
}
