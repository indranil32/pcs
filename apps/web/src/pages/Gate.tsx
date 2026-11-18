import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { CheckCircle2, XCircle, ScanLine } from 'lucide-react';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { fmtDateTime, label } from '../lib/format';
import { Badge, Button, Card, Field, Input, PageHeader, Select, Table, useAction } from '../components/ui';

export default function Gate() {
  const t = useT();
  const { me } = useAuth();
  const terminals = useQuery({ queryKey: ['terminals'], queryFn: () => api<any[]>('/ref/terminals') });
  const mine = (terminals.data ?? []).filter((x) => x.operator_org_id === me?.user.orgId || me?.user.roles.includes('PORT_ADMIN') || me?.user.roles.includes('SYS_ADMIN'));
  const [terminalId, setTerminalId] = useState('');
  const tid = terminalId || mine[0]?.id || '';
  const [f, setF] = useState<any>({ direction: 'IN', source: 'ANPR' });
  const [result, setResult] = useState<any>(null);
  const events = useQuery({ queryKey: ['gate-events', tid], queryFn: () => api<any[]>(`/gate/events?terminalId=${tid}`), enabled: !!tid, refetchInterval: 10_000 });
  const today = useQuery({ queryKey: ['truck-appointments', 'today', tid], queryFn: () => api<any[]>(`/truck-appointments?terminalId=${tid}&date=${new Date().toISOString().slice(0, 10)}`), enabled: !!tid });
  const tx = useAction(() => post('/gate/transactions', { terminalId: tid, direction: f.direction, truckPlate: f.plate, token: f.token || undefined, source: f.source }), {
    invalidate: [['gate-events'], ['truck-appointments'], ['containers']], onDone: (r) => { setResult(r); setF({ ...f, plate: '', token: '' }); },
  });

  return (
    <div className="space-y-5">
      <PageHeader title={t('gate')} subtitle="Validates appointment, eDO, customs release and holds in one step — every attempt is logged" actions={
        <Select value={tid} onChange={(e) => setTerminalId(e.target.value)} options={mine.map((x) => ({ value: x.id, label: x.name }))} />
      } />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card title={<span className="flex items-center gap-2"><ScanLine className="h-4 w-4" />Gate transaction</span>}>
          <form onSubmit={(e) => { e.preventDefault(); tx.mutate(); }} className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {['IN', 'OUT'].map((d) => <button type="button" key={d} onClick={() => setF({ ...f, direction: d })} className={clsx('rounded-lg border py-3 text-sm font-semibold', f.direction === d ? 'border-navy-900 bg-navy-900 text-white' : 'border-slate-200')}>Gate {d}</button>)}
            </div>
            <Field label="Truck plate (ANPR / manual)"><Input required value={f.plate ?? ''} onChange={(e) => setF({ ...f, plate: e.target.value })} className="font-mono text-lg uppercase" /></Field>
            <Field label="Gate pass token (QR)" hint="Optional — plate lookup finds the nearest booked slot"><Input value={f.token ?? ''} onChange={(e) => setF({ ...f, token: e.target.value })} className="font-mono uppercase" /></Field>
            <Field label="Source"><Select value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} options={['ANPR', 'MANUAL', 'OCR'].map((x) => ({ value: x, label: x }))} /></Field>
            <Button type="submit" className="w-full" loading={tx.isPending}>Process</Button>
          </form>
          {result && (
            <div className={clsx('mt-4 rounded-lg p-4', result.result === 'ACCEPTED' ? 'bg-emerald-50' : 'bg-red-50')}>
              <div className={clsx('flex items-center gap-2 text-lg font-semibold', result.result === 'ACCEPTED' ? 'text-emerald-700' : 'text-red-700')}>
                {result.result === 'ACCEPTED' ? <CheckCircle2 className="h-6 w-6" /> : <XCircle className="h-6 w-6" />}{result.result === 'ACCEPTED' ? 'Barrier open' : 'Rejected'}
              </div>
              {result.reason && <div className="mt-1 text-sm text-red-700">{result.reason}</div>}
              {result.warnings?.length > 0 && <div className="mt-1 text-sm text-amber-700">{result.warnings.join('; ')}</div>}
              {result.appointment && <div className="mt-2 text-xs text-slate-600">{result.appointment.appt_no} · {label(result.appointment.direction)} · <span className="font-mono">{result.appointment.container_no ?? ''}</span></div>}
            </div>
          )}
        </Card>
        <Card title="Today's appointments" className="lg:col-span-2" pad={false}>
          <Table rows={today.data} empty="No appointments today" cols={[
            { key: 'slot_start', header: 'Slot', render: (r) => new Date(r.slot_start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) },
            { key: 'truck_plate', header: 'Truck', render: (r) => <button className="font-mono text-teal-700 hover:underline" onClick={() => setF({ ...f, plate: r.truck_plate, token: r.token, direction: r.status === 'GATED_IN' ? 'OUT' : 'IN' })}>{r.truck_plate}</button> },
            { key: 'haulier_name', header: 'Haulier' }, { key: 'direction', header: 'Move', render: (r) => label(r.direction) },
            { key: 'container_no', header: 'Container', render: (r) => <span className="font-mono text-xs">{r.container_no ?? '—'}</span> },
            { key: 'status', header: 'Status', render: (r) => <Badge s={r.status} /> },
          ]} />
        </Card>
      </div>
      <Card title="Gate log" pad={false}>
        <Table rows={events.data} cols={[
          { key: 'at', header: 'Time', render: (r) => fmtDateTime(r.at) },
          { key: 'direction', header: 'Dir.' }, { key: 'truck_plate', header: 'Truck', render: (r) => <span className="font-mono">{r.truck_plate}</span> },
          { key: 'container_no', header: 'Container', render: (r) => <span className="font-mono text-xs">{r.container_no ?? '—'}</span> },
          { key: 'appt_no', header: 'Appointment', render: (r) => <span className="font-mono text-xs">{r.appt_no ?? '—'}</span> },
          { key: 'source', header: 'Source' },
          { key: 'result', header: 'Result', render: (r) => <Badge s={r.result} /> }, { key: 'reason', header: 'Reason' },
        ]} />
      </Card>
    </div>
  );
}
