import { reloadAllQueries } from '../api';
import { removeBackground, useBackground, BgAction } from '../state/background';
import { statusView, useTicketPoll } from './ActionFlow';
import { Icon, useToast } from './ui';

/** One hidden elevated action: keeps polling its result and announces the outcome when it finishes. */
function Item({ item }: { item: BgAction }) {
  const toast = useToast();
  useTicketPoll(item.ticket, () => undefined, (r) => {
    const v = statusView(r);
    toast(v.tone === 'ok' ? 'ok' : v.tone === 'crit' ? 'error' : 'warn', `${item.label}: ${v.title}`);
    removeBackground(item.ticket);
    void reloadAllQueries();
  });
  return <a className="bg-chip" href="#/actions"><span className="spin"><Icon name="refresh" size={13} /></span>{item.label} is still running</a>;
}

/** A small indicator, visible on every page, while hidden actions are still running. */
export function BackgroundActions() {
  const items = useBackground();
  if (!items.length) return null;
  return <div className="bg-actions" role="status" aria-live="polite">{items.map((i) => <Item key={i.ticket} item={i} />)}</div>;
}
