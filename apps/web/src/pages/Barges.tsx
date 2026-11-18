import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { fmtDateTime, fmtNum, toLocalInput } from '../lib/format';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Table, Textarea, useAction } from '../components/ui';

const NEXT: Record<string, [string, string, 'op' | 'port'][]> = {
  PLANNED: [['notify', 'Pre-notify port', 'op'], ['cancel', 'Cancel', 'op']],
  NOTIFIED: [['arrive', 'Record arrival', 'port'], ['cancel', 'Cancel', 'op']],
  ARRIVED: [['start', 'Start operations', 'port'], ['depart', 'Record departure', 'port']],
  WORKING: [['depart', 'Record departure', 'port']],
};

export default function Barges() {
  const t = useT();
  const { me, has } = useAuth();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['barge-calls'], queryFn: () => api<any[]>('/barge-calls') });
  const act = useAction((a: { id: string; action: string }) => post(`/barge-calls/${a.id}/${a.action}`), { invalidate: [['barge-calls']], success: 'Barge call updated' });
  return (
    <div>
      <PageHeader title={t('barges')} subtitle="Inland waterway convoys — pre-notification, barge berth allocation and turnaround"
        actions={has('BARGE_OPERATOR') && <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />New barge call</Button>} />
      <Card pad={false}>
        <Table rows={q.data} loading={q.isLoading} cols={[
          { key: 'call_no', header: 'Call', render: (r) => <span className="font-mono text-xs">{r.call_no}</span> },
          { key: 'barge_name', header: 'Barge', render: (r) => <><div className="font-medium">{r.barge_name}</div><div className="text-xs text-slate-500">ENI {r.eni}{r.convoy_ref ? ` · convoy ${r.convoy_ref}` : ''}</div></> },
          { key: 'operator_name', header: 'Operator' },
          { key: 'route', header: 'Route', render: (r) => `${r.origin ?? '—'} → ${r.destination ?? '—'}` },
          { key: 'terminal_code', header: 'Terminal / berth', render: (r) => `${r.terminal_code ?? '—'} / ${r.berth_code ?? '—'}` },
          { key: 'cargo', header: 'Cargo', render: (r) => <>{r.cargo_description}<div className="text-xs text-slate-500">{fmtNum(r.tonnage)} t{r.containers.length ? ` · ${r.containers.length} cntr` : ''}</div></> },
          { key: 'eta', header: 'ETA / ATA', render: (r) => <>{fmtDateTime(r.eta)}<div className="text-xs text-slate-500">{fmtDateTime(r.ata)}</div></> },
          { key: 'status', header: t('status'), render: (r) => <Badge s={r.status} /> },
          { key: 'x', header: '', render: (r) => (
            <div className="flex gap-1">{(NEXT[r.status] ?? []).filter(([, , who]) => who === 'op' ? r.operator_org_id === me?.user.orgId : has('HARBOUR_MASTER', 'TERMINAL_OPERATOR') || r.operator_org_id === me?.user.orgId).map(([a, l]) => (
              <Button key={a} size="sm" variant={a === 'cancel' ? 'ghost' : 'secondary'} onClick={() => act.mutate({ id: r.id, action: a })}>{l}</Button>
            ))}</div>) },
        ]} />
      </Card>
      {open && <NewBarge onClose={() => setOpen(false)} />}
    </div>
  );
}

function NewBarge({ onClose }: { onClose: () => void }) {
  const terminals = useQuery({ queryKey: ['terminals'], queryFn: () => api<any[]>('/ref/terminals') });
  const berths = useQuery({ queryKey: ['berths'], queryFn: () => api<any[]>('/ref/berths') });
  const [f, setF] = useState<any>({ eta: toLocalInput(new Date(Date.now() + 864e5)) });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = useAction(() => post('/barge-calls', {
    bargeName: f.bargeName, eni: f.eni, convoyRef: f.convoyRef, origin: f.origin, destination: f.destination, terminalId: f.terminalId || undefined, berthId: f.berthId || undefined,
    eta: new Date(f.eta), cargoDescription: f.cargo, tonnage: f.tonnage ? Number(f.tonnage) : undefined, containers: (f.containers ?? '').split(/[\s,]+/).filter(Boolean),
  }), { invalidate: [['barge-calls']], success: 'Barge call created', onDone: onClose });
  return (
    <Modal open onClose={onClose} wide title="New barge call" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Create</Button></>}>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Barge name"><Input value={f.bargeName ?? ''} onChange={set('bargeName')} /></Field>
        <Field label="ENI (8 digits)"><Input value={f.eni ?? ''} onChange={set('eni')} maxLength={8} /></Field>
        <Field label="Convoy ref."><Input value={f.convoyRef ?? ''} onChange={set('convoyRef')} /></Field>
        <Field label="Origin"><Input value={f.origin ?? ''} onChange={set('origin')} /></Field>
        <Field label="Destination"><Input value={f.destination ?? ''} onChange={set('destination')} /></Field>
        <Field label="ETA"><Input type="datetime-local" value={f.eta} onChange={set('eta')} /></Field>
        <Field label="Terminal"><Select value={f.terminalId ?? ''} onChange={set('terminalId')} placeholder="—" options={(terminals.data ?? []).map((x) => ({ value: x.id, label: x.name }))} /></Field>
        <Field label="Barge berth"><Select value={f.berthId ?? ''} onChange={set('berthId')} placeholder="—" options={(berths.data ?? []).filter((b) => b.barge_berth).map((b) => ({ value: b.id, label: b.name }))} /></Field>
        <Field label="Tonnage (t)"><Input type="number" value={f.tonnage ?? ''} onChange={set('tonnage')} /></Field>
        <Field label="Cargo" className="sm:col-span-3"><Input value={f.cargo ?? ''} onChange={set('cargo')} /></Field>
        <Field label="Containers (ISO 6346, comma or space separated)" className="sm:col-span-3"><Textarea rows={2} className="font-mono text-xs" value={f.containers ?? ''} onChange={set('containers')} /></Field>
      </div>
    </Modal>
  );
}
