import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { VESSEL_CALL_STATUS } from '@pcs/shared';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { fmtDateTime, label, toLocalInput } from '../lib/format';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Table, Textarea, useAction } from '../components/ui';

export default function VesselCalls() {
  const t = useT();
  const nav = useNavigate();
  const { has } = useAuth();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['vessel-calls', status, search], queryFn: () => api<any[]>(`/vessel-calls?${new URLSearchParams({ ...(status && { status }), ...(search && { search }) })}`) });

  return (
    <div>
      <PageHeader title={t('vesselCalls')} subtitle="Berthing requests, pre-arrival notifications, clearances and movements"
        actions={has('SHIPPING_AGENT', 'SHIPPING_LINE') && <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />New vessel call</Button>} />
      <Card pad={false}>
        <div className="flex flex-wrap gap-2 border-b border-slate-100 p-3">
          <Input placeholder={`${t('search')}: vessel, IMO, call no.`} value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder={`${t('status')}: ${t('all')}`} options={VESSEL_CALL_STATUS.map((s) => ({ value: s, label: label(s) }))} className="max-w-xs" />
        </div>
        <Table rows={q.data} loading={q.isLoading} onRow={(r) => nav(`/vessel-calls/${r.id}`)} cols={[
          { key: 'call_no', header: 'Call no.', render: (r) => <span className="font-mono text-xs">{r.call_no}</span> },
          { key: 'vessel_name', header: t('vessel'), render: (r) => <><div className="font-medium">{r.vessel_name}</div><div className="text-xs text-slate-500">IMO {r.imo} · {label(r.vessel_type)} · {r.flag}</div></> },
          { key: 'voyage', header: 'Voyage', render: (r) => `${r.voyage_in ?? '—'} / ${r.voyage_out ?? '—'}` },
          { key: 'agent_name', header: t('agent') },
          { key: 'berth', header: t('berth'), render: (r) => r.berth_code ?? (r.requested_berth_code ? <span className="text-slate-400">req. {r.requested_berth_code}</span> : '—') },
          { key: 'eta', header: t('eta'), render: (r) => fmtDateTime(r.eta) },
          { key: 'etd', header: t('etd'), render: (r) => fmtDateTime(r.etd) },
          { key: 'status', header: t('status'), render: (r) => <Badge s={r.status} /> },
        ]} />
      </Card>
      <NewCall open={open} onClose={() => setOpen(false)} onCreated={(id) => nav(`/vessel-calls/${id}`)} />
    </div>
  );
}

export function NewCall({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [vs, setVs] = useState('');
  const vessels = useQuery({ queryKey: ['vessels', vs], queryFn: () => api<any[]>(`/ref/vessels?search=${encodeURIComponent(vs)}`), enabled: open });
  const berths = useQuery({ queryKey: ['berths'], queryFn: () => api<any[]>('/ref/berths'), enabled: open });
  const lines = useQuery({ queryKey: ['dir', 'SHIPPING_LINE'], queryFn: () => api<any[]>('/directory/organisations?type=SHIPPING_LINE'), enabled: open });
  const now = Date.now();
  const [f, setF] = useState<any>({ eta: toLocalInput(new Date(now + 2 * 864e5)), etd: toLocalInput(new Date(now + 4 * 864e5)), purpose: 'CARGO_OPERATIONS' });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const create = useAction(() => post('/vessel-calls', {
    vesselId: f.vesselId, voyageIn: f.voyageIn, voyageOut: f.voyageOut, purpose: f.purpose, lastPort: f.lastPort?.toUpperCase() || undefined,
    nextPort: f.nextPort?.toUpperCase() || undefined, eta: new Date(f.eta), etd: new Date(f.etd), requestedBerthId: f.requestedBerthId || null,
    arrivalDraft: f.arrivalDraft ? Number(f.arrivalDraft) : undefined, lineOrgId: f.lineOrgId || null, dangerousGoods: !!f.dangerousGoods, cargoSummary: f.cargoSummary,
  }), { success: 'Vessel call created', invalidate: [['vessel-calls']], onDone: (r) => { onClose(); onCreated(r.id); } });

  return (
    <Modal open={open} onClose={onClose} title="New vessel call" wide footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button loading={create.isPending} onClick={() => create.mutate()} disabled={!f.vesselId}>Create draft</Button></>}>
      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="Find vessel (name or IMO)" className="sm:col-span-1"><Input value={vs} onChange={(e) => setVs(e.target.value)} placeholder="e.g. EUXIN" /></Field>
        <Field label="Vessel" className="sm:col-span-2"><Select value={f.vesselId ?? ''} onChange={set('vesselId')} placeholder="Select vessel…" options={(vessels.data ?? []).map((v) => ({ value: v.id, label: `${v.name} — IMO ${v.imo} · ${label(v.type)} · LOA ${v.loa} m` }))} /></Field>
        <Field label="Voyage in"><Input value={f.voyageIn ?? ''} onChange={set('voyageIn')} /></Field>
        <Field label="Voyage out"><Input value={f.voyageOut ?? ''} onChange={set('voyageOut')} /></Field>
        <Field label="Purpose"><Select value={f.purpose} onChange={set('purpose')} options={['CARGO_OPERATIONS', 'BUNKERING_ONLY', 'CREW_CHANGE', 'REPAIRS', 'PASSENGERS', 'SHELTER', 'OTHER'].map((x) => ({ value: x, label: label(x) }))} /></Field>
        <Field label="ETA"><Input type="datetime-local" value={f.eta} onChange={set('eta')} /></Field>
        <Field label="ETD"><Input type="datetime-local" value={f.etd} onChange={set('etd')} /></Field>
        <Field label="Arrival draft (m)"><Input type="number" step="0.1" value={f.arrivalDraft ?? ''} onChange={set('arrivalDraft')} /></Field>
        <Field label="Last port (UN/LOCODE)"><Input maxLength={5} value={f.lastPort ?? ''} onChange={set('lastPort')} placeholder="TRIST" /></Field>
        <Field label="Next port (UN/LOCODE)"><Input maxLength={5} value={f.nextPort ?? ''} onChange={set('nextPort')} /></Field>
        <Field label="Requested berth"><Select value={f.requestedBerthId ?? ''} onChange={set('requestedBerthId')} placeholder="No preference" options={(berths.data ?? []).filter((b) => !b.barge_berth).map((b) => ({ value: b.id, label: `${b.code} — ${b.terminal_name ?? ''} (${b.length_m} m / ${b.depth_m} m)` }))} /></Field>
        <Field label="Shipping line"><Select value={f.lineOrgId ?? ''} onChange={set('lineOrgId')} placeholder="—" options={(lines.data ?? []).map((o) => ({ value: o.id, label: o.name }))} /></Field>
        <Field label="Dangerous goods on board"><label className="flex items-center gap-2 pt-2 text-sm"><input type="checkbox" checked={!!f.dangerousGoods} onChange={set('dangerousGoods')} /> Yes (FAL 7 required)</label></Field>
        <Field label="Cargo summary" className="sm:col-span-3"><Textarea rows={2} value={f.cargoSummary ?? ''} onChange={set('cargoSummary')} /></Field>
      </div>
    </Modal>
  );
}
