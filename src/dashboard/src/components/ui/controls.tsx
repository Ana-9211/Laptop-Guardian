import { useId, type ReactNode } from 'react';
import { Icon } from './icons';

export function Switch({ checked, onChange, label, disabled, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; disabled?: boolean; hint?: ReactNode }) {
  return (
    <div className="stack" style={{ gap: 2 }}>
      <label className="switch">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span className="track" /><span>{label}</span>
      </label>
      {hint && <div className="hint" style={{ marginLeft: 44 }}>{hint}</div>}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items, label, children, listStyle, panelStyle }: { value: T; onChange: (v: T) => void; items: { id: T; label: string; count?: number }[]; label: string; children?: ReactNode; listStyle?: React.CSSProperties; panelStyle?: React.CSSProperties }) {
  const base = useId();
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const i = items.findIndex((x) => x.id === value);
    let n = -1;
    if (e.key === 'ArrowRight') n = (i + 1) % items.length;
    else if (e.key === 'ArrowLeft') n = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = items.length - 1;
    if (n < 0) return;
    e.preventDefault();
    onChange(items[n].id);
    const list = e.currentTarget;
    requestAnimationFrame(() => list.querySelectorAll<HTMLElement>('[role=tab]')[n]?.focus());
  };
  return (
    <>
      <div className="tabs" role="tablist" aria-label={label} onKeyDown={onKey} style={listStyle}>
        {items.map((t) => (
          <button key={t.id} id={`${base}-tab-${t.id}`} role="tab" aria-selected={value === t.id} aria-controls={children !== undefined && value === t.id ? `${base}-panel` : undefined} tabIndex={value === t.id ? 0 : -1} onClick={() => onChange(t.id)}>
            {t.label}{t.count != null && <span className="n">{t.count}</span>}
          </button>
        ))}
      </div>
      {children !== undefined && <div id={`${base}-panel`} role="tabpanel" aria-labelledby={`${base}-tab-${value}`} tabIndex={0} className="tabpanel" style={panelStyle}>{children}</div>}
    </>
  );
}

export function Seg<T extends string | number>({ value, onChange, items, label }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[]; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {items.map((i) => <button key={String(i.id)} aria-pressed={value === i.id} onClick={() => onChange(i.id)}>{i.label}</button>)}
    </div>
  );
}

export function SearchBox({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return <div className="search grow"><Icon name="search" size={14} /><input type="search" aria-label={placeholder} placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)} /></div>;
}
