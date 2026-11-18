import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { QRCodeSVG } from 'qrcode.react';
import { Plus } from 'lucide-react';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { fmtDateTime, label } from '../lib/format';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Table, useAction } from '../components/ui';

export default function Trucks() {
  const t = useT();
  const { has } = useAuth();
  const [date, setDate] = useState('');
  const [search, setSearch] = useState('');
  const [book, setBook] = useState(false);
  const [pass, setPass] = useState<any>(null);
  const q = useQuery({ queryKey: ['truck-appointments', date, search], queryFn: () => api<any[]>(`/truck-appointments?${new URLSearchParams({ ...(date && { date }), ...(search && { search }) })}`) });
  const cancel = useAction((id: string) => post(`/truck-appointments/${id}/cancel`), { invalidate: [['truck-appointments']], success: 'Appointment cancelled' });

  return (
    <div>
      <PageHeader title={t('trucks')} subtitle="Slot-based truck appointment system — every truck needs a booked slot and a valid eDO for import pickup"
        actions={has('HAULIER') && <Button onClick={() => setBook(true)}><Plus className="h-4 w-4" />Book appointment</Button>} />
      <Card pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="max-w-44" />
          <Input placeholder={`${t('search')}: plate, appointment, container`} value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
        </div>
        <Table rows={q.data} loading={q.isLoading} cols={[
          { key: 'appt_no', header: 'Appointment', render: (r) => <span className="font-mono text-xs">{r.appt_no}</span> },
          { key: 'slot_start', header: 'Slot', render: (r) => fmtDateTime(r.slot_start) },
          { key: 'terminal_code', header: 'Terminal' },
          { key: 'direction', header: 'Move', render: (r) => label(r.direction) },
          { key: 'truck_plate', header: 'Truck', render: (r) => <><div className="font-mono">{r.truck_plate}</div><div className="text-xs text-slate-500">{r.driver_name}</div></> },
          { key: 'container_no', header: 'Container', render: (r) => <span className="font-mono text-xs">{r.container_no ?? '—'}</span> },
          { key: 'haulier_name', header: 'Haulier' },
          { key: 'status', header: t('status'), render: (r) => <Badge s={r.status} /> },
          { key: 'gate', header: 'Gate in / out', render: (r) => <span className="text-xs">{fmtDateTime(r.gate_in_at)}<br />{fmtDateTime(r.gate_out_at)}</span> },
          { key: 'x', header: '', render: (r) => r.status === 'BOOKED' && (
            <div className="flex gap-1"><Button size="sm" variant="secondary" onClick={() => setPass(r)}>Gate pass</Button>{has('HAULIER') && <Button size="sm" variant="ghost" onClick={() => cancel.mutate(r.id)}>Cancel</Button>}</div>) },
        ]} />
      </Card>
      {book && <BookModal onClose={() => setBook(false)} onBooked={(r) => { setBook(false); setPass(r); }} />}
      <Modal open={!!pass} onClose={() => setPass(null)} title="Gate pass">
        {pass && (
          <div className="flex items-center gap-5">
            <QRCodeSVG value={pass.token} size={140} />
            <div className="space-y-1 text-sm">
              <div className="font-mono text-lg font-semibold">{pass.token}</div>
              <div>{pass.appt_no}</div><div>Truck <b className="font-mono">{pass.truck_plate}</b></div>
              <div>{label(pass.direction)} {pass.container_no && <span className="font-mono">{pass.container_no}</span>}</div>
              <div className="text-slate-500">Slot {fmtDateTime(pass.slot_start)} – {new Date(pass.slot_end).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
              <p className="pt-2 text-xs text-slate-400">Present at the gate kiosk or let ANPR read the plate. Arrive within the slot (±2 h grace).</p>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function BookModal({ onClose, onBooked }: { onClose: () => void; onBooked: (r: any) => void }) {
  const terminals = useQuery({ queryKey: ['terminals'], queryFn: () => api<any[]>('/ref/terminals') });
  const dos = useQuery({ queryKey: ['delivery-orders', 'ISSUED'], queryFn: () => api<any[]>('/delivery-orders?status=ISSUED') });
  const [f, setF] = useState<any>({ direction: 'IMPORT_PICKUP', date: new Date().toISOString().slice(0, 10) });
  const slots = useQuery({ queryKey: ['slots', f.terminalId, f.date], queryFn: () => api<any[]>(`/gate/slots?terminalId=${f.terminalId}&date=${f.date}`), enabled: !!f.terminalId });
  const selDo = (dos.data ?? []).find((d) => d.id === f.doId);
  const save = useAction(() => post('/truck-appointments', { terminalId: f.terminalId, direction: f.direction, containerNo: f.containerNo || undefined, doId: f.doId || undefined, truckPlate: f.truckPlate, driverName: f.driverName, driverLicence: f.driverLicence, slotStart: f.slot }), { invalidate: [['truck-appointments']], success: 'Appointment booked', onDone: onBooked });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const now = Date.now();
  return (
    <Modal open onClose={onClose} wide title="Book truck appointment" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.slot || !f.truckPlate}>Book slot</Button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Terminal"><Select value={f.terminalId ?? ''} onChange={set('terminalId')} placeholder="Select…" options={(terminals.data ?? []).map((x) => ({ value: x.id, label: x.name }))} /></Field>
        <Field label="Move"><Select value={f.direction} onChange={set('direction')} options={['IMPORT_PICKUP', 'EXPORT_DROPOFF', 'EMPTY_RETURN', 'EMPTY_PICKUP'].map((x) => ({ value: x, label: label(x) }))} /></Field>
        <Field label="Date"><Input type="date" value={f.date} onChange={set('date')} /></Field>
        {f.direction === 'IMPORT_PICKUP' ? <>
          <Field label="Delivery order"><Select value={f.doId ?? ''} onChange={set('doId')} placeholder="Select issued eDO…" options={(dos.data ?? []).map((d) => ({ value: d.id, label: `${d.do_no} — B/L ${d.bl_no}` }))} /></Field>
          <Field label="Container"><Select value={f.containerNo ?? ''} onChange={set('containerNo')} placeholder="Select…" options={(selDo?.containers ?? []).map((c: string) => ({ value: c, label: c }))} /></Field>
          <div />
        </> : <Field label="Container (optional)" className="sm:col-span-3"><Input value={f.containerNo ?? ''} onChange={set('containerNo')} className="font-mono" /></Field>}
        <Field label="Truck plate"><Input value={f.truckPlate ?? ''} onChange={set('truckPlate')} className="font-mono uppercase" /></Field>
        <Field label="Driver name"><Input value={f.driverName ?? ''} onChange={set('driverName')} /></Field>
        <Field label="Driver licence"><Input value={f.driverLicence ?? ''} onChange={set('driverLicence')} /></Field>
      </div>
      {f.terminalId && (
        <div className="mt-4">
          <div className="mb-2 text-xs font-medium text-slate-600">Slots (green = available)</div>
          <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-8">
            {(slots.data ?? []).map((s) => {
              const past = new Date(s.end).getTime() < now;
              const full = s.available === 0;
              const sel = f.slot === s.start;
              return (
                <button key={s.start} disabled={past || full} onClick={() => setF({ ...f, slot: s.start })}
                  className={clsx('rounded-md border px-1 py-1.5 text-xs', sel ? 'border-navy-900 bg-navy-900 text-white' : past ? 'border-slate-100 text-slate-300' : full ? 'border-red-200 bg-red-50 text-red-400' : 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:border-emerald-500')}>
                  {new Date(s.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}<div className="text-[10px] opacity-70">{s.available}/{s.capacity}</div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </Modal>
  );
}
