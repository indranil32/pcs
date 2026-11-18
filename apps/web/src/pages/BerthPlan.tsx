import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { fmtDateTime, label } from '../lib/format';
import { Button, Card, PageHeader } from '../components/ui';

const COLORS: Record<string, string> = {
  BERTH_ALLOCATED: 'bg-sky-500', PRE_ARRIVAL_SUBMITTED: 'bg-amber-500', ARRIVAL_CLEARED: 'bg-teal-500', ARRIVED: 'bg-indigo-500',
  BERTHED: 'bg-navy-800', DEPARTURE_REQUESTED: 'bg-amber-600', DEPARTURE_CLEARED: 'bg-emerald-600', DEPARTED: 'bg-slate-400', BERTH_REQUESTED: 'bg-slate-300',
};

export default function BerthPlan() {
  const t = useT();
  const nav = useNavigate();
  const [offset, setOffset] = useState(0);
  const from = new Date(Date.now() + (offset - 2) * 864e5); from.setHours(0, 0, 0, 0);
  const to = new Date(from.getTime() + 10 * 864e5);
  const q = useQuery({ queryKey: ['berth-schedule', offset], queryFn: () => api(`/berth-schedule?from=${from.toISOString()}&to=${to.toISOString()}`) });
  const span = to.getTime() - from.getTime();
  const pos = (d: string) => Math.max(0, Math.min(100, ((new Date(d).getTime() - from.getTime()) / span) * 100));
  const days = Array.from({ length: 10 }, (_, i) => new Date(from.getTime() + i * 864e5));
  const unassigned = (q.data?.calls ?? []).filter((c: any) => !c.berth_id);

  return (
    <div>
      <PageHeader title={t('berthPlan')} subtitle="Allocated berth windows (ETA→ETD, actuals where recorded)" actions={<>
        <Button variant="secondary" onClick={() => setOffset(offset - 7)}>← Week</Button><Button variant="secondary" onClick={() => setOffset(0)}>Today</Button><Button variant="secondary" onClick={() => setOffset(offset + 7)}>Week →</Button>
      </>} />
      <Card pad={false}>
        <div className="overflow-x-auto">
          <div className="min-w-[900px]">
            <div className="flex border-b border-slate-200 text-xs text-slate-500">
              <div className="w-40 shrink-0 px-3 py-2 font-medium">Berth</div>
              <div className="relative flex flex-1">{days.map((d) => <div key={d.toISOString()} className={clsx('flex-1 border-l border-slate-100 px-1 py-2', d.toDateString() === new Date().toDateString() && 'bg-teal-50 font-semibold text-teal-700')}>{d.toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short' })}</div>)}</div>
            </div>
            {(q.data?.berths ?? []).map((b: any) => (
              <div key={b.id} className="flex border-b border-slate-100">
                <div className="w-40 shrink-0 px-3 py-3"><div className="text-sm font-semibold">{b.code}</div><div className="text-[11px] text-slate-500">{b.terminal_name} · {b.length_m} m / {b.depth_m} m</div></div>
                <div className="relative h-16 flex-1">
                  {days.map((d, i) => <div key={i} className="absolute top-0 h-full border-l border-slate-100" style={{ left: `${i * 10}%` }} />)}
                  <div className="absolute top-0 h-full w-0.5 bg-red-400" style={{ left: `${pos(new Date().toISOString())}%` }} />
                  {(q.data?.calls ?? []).filter((c: any) => c.berth_id === b.id).map((c: any) => {
                    const s = c.berthed_at ?? c.eta, e = c.atd ?? c.etd;
                    const l = pos(s), w = Math.max(1.5, pos(e) - l);
                    return (
                      <button key={c.id} onClick={() => nav(`/vessel-calls/${c.id}`)} title={`${c.vessel_name} · ${label(c.status)} · ${fmtDateTime(s)} → ${fmtDateTime(e)}`}
                        className={clsx('absolute top-2 h-12 overflow-hidden rounded-md px-2 py-1 text-left text-[11px] text-white shadow-sm hover:ring-2 hover:ring-teal-300', COLORS[c.status] ?? 'bg-slate-400')} style={{ left: `${l}%`, width: `${w}%` }}>
                        <div className="truncate font-semibold">{c.vessel_name}</div><div className="truncate opacity-80">{c.agent_name} · LOA {c.loa}</div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap gap-3 border-t border-slate-100 px-4 py-3 text-xs text-slate-600">
          {Object.entries(COLORS).filter(([k]) => k !== 'BERTH_REQUESTED').map(([k, c]) => <span key={k} className="flex items-center gap-1.5"><span className={clsx('h-3 w-3 rounded', c)} />{label(k)}</span>)}
          <span className="flex items-center gap-1.5"><span className="h-3 w-0.5 bg-red-400" />Now</span>
        </div>
      </Card>
      {unassigned.length > 0 && (
        <Card title={`Awaiting berth allocation (${unassigned.length})`} className="mt-5">
          <div className="flex flex-wrap gap-2">
            {unassigned.map((c: any) => <button key={c.id} onClick={() => nav(`/vessel-calls/${c.id}`)} className="rounded-lg border border-slate-200 px-3 py-2 text-left text-sm hover:border-teal-500"><div className="font-medium">{c.vessel_name}</div><div className="text-xs text-slate-500">ETA {fmtDateTime(c.eta)} · LOA {c.loa} m · req. {c.requested_berth_code ?? '—'}</div></button>)}
          </div>
        </Card>
      )}
    </div>
  );
}
