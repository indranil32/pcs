import { createContext, useContext, useState, useEffect, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { X, Loader2, Inbox, CheckCircle2, AlertTriangle } from 'lucide-react';
import { label } from '../lib/format';

// ---------- Button ----------
type BtnVariant = 'primary' | 'secondary' | 'danger' | 'ghost' | 'success';
export function Button({ variant = 'primary', loading, className, children, size = 'md', ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; loading?: boolean; size?: 'sm' | 'md' }) {
  return (
    <button
      {...p}
      disabled={p.disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        {
          primary: 'bg-navy-900 text-white hover:bg-navy-800 shadow-sm',
          secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50',
          danger: 'bg-red-600 text-white hover:bg-red-700',
          success: 'bg-teal-600 text-white hover:bg-teal-500',
          ghost: 'text-slate-600 hover:bg-slate-100',
        }[variant],
        className,
      )}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

// ---------- Card / layout ----------
export function Card({ title, actions, children, className, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={clsx('rounded-xl border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-navy-900">{title}</h3>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={pad ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-navy-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">{actions}</div>
    </div>
  );
}

export function Stat({ label: l, value, hint, tone = 'navy', icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'navy' | 'teal' | 'amber' | 'red' | 'green'; icon?: ReactNode }) {
  const tones = { navy: 'text-navy-900', teal: 'text-teal-600', amber: 'text-amber-600', red: 'text-red-600', green: 'text-emerald-600' };
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between text-xs font-medium uppercase tracking-wide text-slate-500">
        <span>{l}</span>{icon}
      </div>
      <div className={clsx('num mt-1.5 text-2xl font-semibold', tones[tone])}>{value ?? '—'}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
}

// ---------- Status badge ----------
const GREEN = ['APPROVED', 'ACTIVE', 'RELEASED', 'ARRIVAL_CLEARED', 'DEPARTURE_CLEARED', 'BERTHED', 'COMPLETED', 'PAID', 'ISSUED', 'ACCEPTED', 'PROCESSED', 'GATED_OUT', 'SUCCEEDED', 'SENT', 'WORKING', 'LOADING', 'MOORED', 'CUSTOMS_APPROVED', 'SOUND', 'DELIVERED', 'IN_STORE', 'OPEN'];
const AMBER = ['PENDING', 'BERTH_REQUESTED', 'PRE_ARRIVAL_SUBMITTED', 'DEPARTURE_REQUESTED', 'DECLARED', 'REQUESTED', 'QUERY', 'UNDER_INSPECTION', 'BOOKED', 'NOTIFIED', 'ANNOUNCED', 'SCHEDULED', 'AMENDED', 'ESTIMATED', 'UNDER_REPAIR', 'PARTLY_DELIVERED', 'EXPECTED', 'IN_PROGRESS', 'NOT_DECLARED'];
const RED = ['REJECTED', 'HELD', 'CANCELLED', 'ERROR', 'SUSPENDED', 'REVOKED', 'NO_SHOW', 'FAILED', 'critical', 'DAMAGED', 'SHORT_LANDED', 'OVERDUE'];
const BLUE = ['BERTH_ALLOCATED', 'ARRIVED', 'GATED_IN', 'DISCHARGED', 'IN_YARD', 'SUBMITTED', 'PLANNED', 'ON_VESSEL', 'USED', 'DEPARTED', 'LOADED', 'ON_RAIL', 'ON_BARGE', 'IN_TRANSIT', 'AT_FACILITY', 'STUFFED'];
export function Badge({ s, children }: { s?: string | null; children?: ReactNode }) {
  const v = s ?? '';
  const cls = GREEN.includes(v) ? 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
    : AMBER.includes(v) ? 'bg-amber-50 text-amber-700 ring-amber-600/20'
    : RED.includes(v) ? 'bg-red-50 text-red-700 ring-red-600/20'
    : BLUE.includes(v) ? 'bg-sky-50 text-sky-700 ring-sky-600/20'
    : 'bg-slate-100 text-slate-600 ring-slate-500/20';
  return <span className={clsx('inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset', cls)}>{children ?? label(v)}</span>;
}

// ---------- Table ----------
export interface Col<T> { key: string; header: ReactNode; render?: (row: T) => ReactNode; className?: string }
export function Table<T extends Record<string, any>>({ rows, cols, onRow, empty, loading }: { rows?: T[]; cols: Col<T>[]; onRow?: (r: T) => void; empty?: string; loading?: boolean }) {
  if (loading) return <div className="flex items-center justify-center p-10 text-slate-400"><Loader2 className="h-5 w-5 animate-spin" /></div>;
  if (!rows?.length) return <Empty text={empty} />;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
            {cols.map((c) => <th key={c.key} className={clsx('px-3 py-2.5 font-medium', c.className)}>{c.header}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((r, i) => (
            <tr key={r.id ?? i} onClick={onRow ? () => onRow(r) : undefined} className={clsx(onRow && 'cursor-pointer hover:bg-slate-50')}>
              {cols.map((c) => <td key={c.key} className={clsx('px-3 py-2.5 align-top', c.className)}>{c.render ? c.render(r) : (r[c.key] ?? '—')}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Empty({ text = 'Nothing here yet' }: { text?: string }) {
  return <div className="flex flex-col items-center justify-center gap-2 p-10 text-sm text-slate-400"><Inbox className="h-6 w-6" />{text}</div>;
}

// ---------- Forms ----------
export function Field({ label: l, children, hint, className }: { label: ReactNode; children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <label className={clsx('block', className)}>
      <span className="mb-1 block text-xs font-medium text-slate-600">{l}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}
const inputCls = 'w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-teal-500 focus:ring-2 focus:ring-teal-500/20 disabled:bg-slate-50';
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={clsx(inputCls, p.className)} />;
export const Textarea = (p: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={clsx(inputCls, p.className)} />;
export function Select({ options, placeholder, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[]; placeholder?: string }) {
  return (
    <select {...p} className={clsx(inputCls, p.className)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

// ---------- Modal ----------
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    if (open) window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[1000] flex items-start justify-center overflow-y-auto bg-navy-950/40 p-4 pt-[8vh]" onMouseDown={onClose}>
      <div className={clsx('w-full rounded-xl bg-white shadow-xl', wide ? 'max-w-4xl' : 'max-w-lg')} onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
          <h2 className="font-semibold text-navy-900">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100"><X className="h-4 w-4" /></button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

// ---------- Tabs ----------
export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: ReactNode; count?: number }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200">
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)} className={clsx('-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', value === t.id ? 'border-teal-600 text-navy-900' : 'border-transparent text-slate-500 hover:text-slate-700')}>
          {t.label}{t.count != null && <span className="ml-1.5 rounded-full bg-slate-100 px-1.5 text-xs text-slate-600">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------- Key/value ----------
export function KV({ items, cols = 3 }: { items: [ReactNode, ReactNode][]; cols?: number }) {
  return (
    <dl className={clsx('grid gap-x-6 gap-y-3 text-sm', cols === 2 ? 'sm:grid-cols-2' : cols === 4 ? 'sm:grid-cols-2 lg:grid-cols-4' : 'sm:grid-cols-2 lg:grid-cols-3')}>
      {items.map(([k, v], i) => (
        <div key={i}><dt className="text-xs text-slate-500">{k}</dt><dd className="mt-0.5 font-medium text-slate-800">{v ?? '—'}</dd></div>
      ))}
    </dl>
  );
}

// ---------- Toasts ----------
type Toast = { id: number; kind: 'ok' | 'err'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = (kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'err' ? 7000 : 3500);
  };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[2000] flex w-96 max-w-[90vw] flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} className={clsx('flex items-start gap-2 rounded-lg px-4 py-3 text-sm shadow-lg', t.kind === 'ok' ? 'bg-navy-900 text-white' : 'bg-red-600 text-white')}>
            {t.kind === 'ok' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-400" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Mutation helper: runs fn, toasts success/error, invalidates queries. */
export function useAction<A = void>(fn: (arg: A) => Promise<any>, opts: { success?: string; invalidate?: string[][]; onDone?: (r: any) => void } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      if (opts.success) toast('ok', opts.success);
      (opts.invalidate ?? [[]]).forEach((k) => qc.invalidateQueries({ queryKey: k }));
      opts.onDone?.(r);
    },
    onError: (e: any) => toast('err', e.message ?? String(e)),
  });
}

export function Timeline({ items }: { items: { title: ReactNode; at?: string | null; who?: ReactNode; body?: ReactNode; tone?: 'ok' | 'warn' | 'bad' | 'info' }[] }) {
  if (!items.length) return <Empty />;
  return (
    <ol className="relative ml-2 border-l border-slate-200">
      {items.map((it, i) => (
        <li key={i} className="mb-4 ml-4">
          <span className={clsx('absolute -left-1.5 mt-1 h-3 w-3 rounded-full border-2 border-white', { ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500', info: 'bg-teal-500' }[it.tone ?? 'info'])} />
          <div className="text-sm font-medium text-slate-800">{it.title}</div>
          <div className="text-xs text-slate-500">{it.at ? new Date(it.at).toLocaleString() : ''}{it.who ? <> · {it.who}</> : null}</div>
          {it.body && <div className="mt-1 text-sm text-slate-600">{it.body}</div>}
        </li>
      ))}
    </ol>
  );
}
