import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { fmtDateTime, label, toLocalInput } from '../lib/format';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Table, Textarea, useAction } from '../components/ui';

const NEXT: Record<string, [string, string][]> = {
  PLANNED: [['announce', 'Announce'], ['cancel', 'Cancel']], ANNOUNCED: [['arrive', 'Arrived'], ['cancel', 'Cancel']],
  ARRIVED: [['load', 'Start loading'], ['depart', 'Departed']], LOADING: [['depart', 'Departed']],
};

export default function Rail() {
  const t = useT();
  const { has } = useAuth();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['rail-visits'], queryFn: () => api<any[]>('/rail-visits') });
  const act = useAction((a: { id: string; action: string }) => post(`/rail-visits/${a.id}/${a.action}`), { invalidate: [['rail-visits']], success: 'Train visit updated' });
  return (
    <div>
      <PageHeader title={t('rail')} subtitle="Train announcements, wagon lists and terminal rail operations" actions={has('RAIL_OPERATOR') && <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Announce train</Button>} />
      <Card pad={false}>
        <Table rows={q.data} loading={q.isLoading} cols={[
          { key: 'visit_no', header: 'Visit', render: (r) => <span className="font-mono text-xs">{r.visit_no}</span> },
          { key: 'train_no', header: 'Train', render: (r) => <><div className="font-medium">{r.train_no}</div><div className="text-xs text-slate-500">{r.operator_name}</div></> },
          { key: 'direction', header: 'Direction', render: (r) => label(r.direction) },
          { key: 'route', header: 'Route', render: (r) => `${r.origin ?? '—'} → ${r.destination ?? '—'}` },
          { key: 'terminal_code', header: 'Terminal' }, { key: 'wagon_count', header: 'Wagons' },
          { key: 'eta', header: 'ETA', render: (r) => fmtDateTime(r.eta) },
          { key: 'status', header: t('status'), render: (r) => <Badge s={r.status} /> },
          { key: 'x', header: '', render: (r) => <div className="flex gap-1">{(NEXT[r.status] ?? []).map(([a, l]) => <Button key={a} size="sm" variant={a === 'cancel' ? 'ghost' : 'secondary'} onClick={() => act.mutate({ id: r.id, action: a })}>{l}</Button>)}</div> },
        ]} />
      </Card>
      {open && <NewTrain onClose={() => setOpen(false)} />}
    </div>
  );
}

function NewTrain({ onClose }: { onClose: () => void }) {
  const terminals = useQuery({ queryKey: ['terminals'], queryFn: () => api<any[]>('/ref/terminals') });
  const [f, setF] = useState<any>({ direction: 'OUTBOUND', eta: toLocalInput(new Date(Date.now() + 6 * 36e5)), wagons: 'WAGON-001; MSCU1234565 TGHU8765437\nWAGON-002;' });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = useAction(() => post('/rail-visits', {
    trainNo: f.trainNo, direction: f.direction, terminalId: f.terminalId || undefined, origin: f.origin, destination: f.destination, eta: new Date(f.eta),
    wagons: f.wagons.split('\n').filter((l: string) => l.trim()).map((l: string) => { const [w, c] = l.split(';'); return { wagonNo: w.trim(), containers: (c ?? '').split(/[\s,]+/).filter(Boolean) }; }),
  }), { invalidate: [['rail-visits']], success: 'Train created', onDone: onClose });
  return (
    <Modal open onClose={onClose} title="Announce train" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Create</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Train no."><Input value={f.trainNo ?? ''} onChange={set('trainNo')} /></Field>
        <Field label="Direction"><Select value={f.direction} onChange={set('direction')} options={[{ value: 'INBOUND', label: 'Inbound' }, { value: 'OUTBOUND', label: 'Outbound' }]} /></Field>
        <Field label="Terminal"><Select value={f.terminalId ?? ''} onChange={set('terminalId')} placeholder="—" options={(terminals.data ?? []).map((x) => ({ value: x.id, label: x.name }))} /></Field>
        <Field label="ETA"><Input type="datetime-local" value={f.eta} onChange={set('eta')} /></Field>
        <Field label="Origin"><Input value={f.origin ?? ''} onChange={set('origin')} /></Field>
        <Field label="Destination"><Input value={f.destination ?? ''} onChange={set('destination')} /></Field>
        <Field label="Wagons — one per line: wagon no.; containers" className="sm:col-span-2"><Textarea rows={4} className="font-mono text-xs" value={f.wagons} onChange={set('wagons')} /></Field>
      </div>
    </Modal>
  );
}
