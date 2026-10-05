import { useSyncExternalStore } from 'react';
import type { Plan } from '../types';

/**
 * Elevated actions that the user hid the dialog for. They keep being polled (by <BackgroundActions>) after the dialog and even the
 * page are gone, and finish with a toast, so closing the window never loses the outcome.
 */
export interface BgAction { ticket: string; label: string; plan: Plan }

let items: BgAction[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function addBackground(b: BgAction) {
  if (items.some((x) => x.ticket === b.ticket)) return;
  items = [...items, b];
  emit();
}
export function removeBackground(ticket: string) {
  items = items.filter((x) => x.ticket !== ticket);
  emit();
}
export function useBackground(): BgAction[] {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => { subs.delete(cb); }; }, () => items);
}
