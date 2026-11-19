// Inland facilities overview: dry ports, empty depots and CFS, plus bonded transfers between the port and them.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Warehouse, Container, PackageOpen, TrainFront, AlertTriangle, ShieldCheck, Wrench } from 'lucide-react';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { fmtDateTime, fmtNum, label } from '../lib/format';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Stat, Table, Tabs, Textarea, useAction } from '../components/ui';

const TYPE_ICON: Record<string, any> = { DRY_PORT: TrainFront, EMPTY_DEPOT: Container, CFS: PackageOpen };
const TYPE_LABEL: Record<string, string> = { DRY_PORT: 'Dry port (ICD)', EMPTY_DEPOT: 'Empty container depot', CFS: 'Container freight station' };

export default function Inland() {
  const t = useT();
  const { has } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') ?? 'facilities';
  const [open, setOpen] = useState(false);
  const facilities = useQuery({ queryKey: ['facilities'], queryFn: () => api<any[]>('/facilities') });
  const summary = useQuery({ queryKey: ['inland-summary'], queryFn: () => api<any>('/inland/summary') });
  const transfers = useQuery({ queryKey: ['inland-transfers'], queryFn: () => api<any[]>('/inland-transfers'), enabled: tab === 'transfers' });
  const s = summary.data ?? {};
  const canRequest = has('FREIGHT_FORWARDER', 'SHIPPING_LINE', 'SHIPPING_AGENT', 'FACILITY_OPERATOR');

  return (
    <div>
      <PageHeader title={t('inland')} subtitle="Bonded transit to dry ports, empty container depots and container freight stations — one view for port, customs, lines, forwarders and operators"
        actions={canRequest && <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Request transfer</Button>} />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Stat label="In transit" value={fmtNum(s.in_transit)} icon={<TrainFront className="h-4 w-4 text-slate-400" />} />
        <Stat label="Transit overdue" value={fmtNum(s.overdue)} tone={s.overdue ? 'red' : 'navy'} icon={<AlertTriangle className="h-4 w-4 text-slate-400" />} />
        <Stat label="Awaiting customs" value={fmtNum(s.awaiting_customs)} tone="amber" icon={<ShieldCheck className="h-4 w-4 text-slate-400" />} />
        <Stat label="Empties in depots" value={fmtNum(s.empties)} tone="teal" icon={<Container className="h-4 w-4 text-slate-400" />} />
        <Stat label="Repairs to approve" value={fmtNum(s.repairs_pending)} tone="amber" icon={<Wrench className="h-4 w-4 text-slate-400" />} />
        <Stat label="CFS lots in store" value={fmtNum(s.lots_in_store)} icon={<PackageOpen className="h-4 w-4 text-slate-400" />} />
      </div>
      <Tabs value={tab} onChange={(v) => setParams({ tab: v })} tabs={[{ id: 'facilities', label: 'Facilities', count: facilities.data?.length }, { id: 'transfers', label: 'Bonded transfers' }]} />
      {tab === 'facilities' ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {(facilities.data ?? []).map((f) => {
            const Icon = TYPE_ICON[f.type] ?? Warehouse;
            const pct = f.capacity_teu ? Math.min(100, Math.round((100 * f.teu) / f.capacity_teu)) : null;
            return (
              <Link key={f.id} to={`/inland/${f.id}`} className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-teal-400 hover:shadow">
                <div className="flex items-start gap-3">
                  <div className="rounded-lg bg-navy-900 p-2 text-teal-400"><Icon className="h-5 w-5" /></div>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold text-slate-800">{f.name}</div>
                    <div className="text-xs text-slate-500">{TYPE_LABEL[f.type]} · {f.code}{f.distance_km ? ` · ${fmtNum(f.distance_km)} km` : ''}</div>
                    <div className="text-xs text-slate-500">{f.operator_name}</div>
                  </div>
                  {f.bonded && <Badge s="APPROVED">Bonded</Badge>}
                </div>
                <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                  <div><div className="text-lg font-semibold text-slate-800">{fmtNum(f.containers)}</div><div className="text-[11px] text-slate-500">containers</div></div>
                  <div><div className="text-lg font-semibold text-slate-800">{fmtNum(f.teu)}</div><div className="text-[11px] text-slate-500">TEU</div></div>
                  <div><div className="text-lg font-semibold text-slate-800">{f.type === 'CFS' ? fmtNum(f.lots_in_store) : `${f.free_days} d`}</div><div className="text-[11px] text-slate-500">{f.type === 'CFS' ? 'lots in store' : 'free storage'}</div></div>
                </div>
                {pct != null && <div className="mt-3"><div className="h-1.5 rounded-full bg-slate-100"><div className="h-1.5 rounded-full bg-teal-500" style={{ width: `${pct}%` }} /></div><div className="mt-1 text-[11px] text-slate-500">{pct}% of {fmtNum(f.capacity_teu)} TEU</div></div>}
              </Link>
            );
          })}
        </div>
      ) : <Transfers rows={transfers.data} loading={transfers.isLoading} />}
      {open && <NewTransfer onClose={() => setOpen(false)} facilities={facilities.data ?? []} />}
    </div>
  );
}

function Transfers({ rows, loading }: { rows?: any[]; loading: boolean }) {
  const { me } = useAuth();
  const act = useAction((a: { id: string; action: string }) => post(`/inland-transfers/${a.id}/${a.action}`), { invalidate: [['inland-transfers'], ['inland-summary'], ['facilities']], success: 'Transfer updated' });
  const orgId = me?.user.orgId;
  return (
    <Card pad={false}>
      <Table rows={rows} loading={loading} empty="No transfers" cols={[
        { key: 'transfer_no', header: 'Transfer', render: (r) => <><div className="font-mono text-xs">{r.transfer_no}</div><div className="text-xs text-slate-500">{r.direction === 'TO_FACILITY' ? 'Import' : 'Export'} · {label(r.mode)}</div></> },
        { key: 'route', header: 'Route', render: (r) => r.direction === 'TO_FACILITY' ? `${r.terminal_code} → ${r.facility_code}` : `${r.facility_code} → ${r.terminal_code}` },
        { key: 'containers', header: 'Containers', render: (r) => <div className="max-w-56 font-mono text-[11px] leading-tight">{r.containers.join(' ')}</div> },
        { key: 'bl_no', header: 'B/L', render: (r) => r.bl_no ? <><div className="text-xs">{r.bl_no}</div><Badge s={r.customs_status} /></> : '—' },
        { key: 'requester_name', header: 'Requested by', render: (r) => <><div className="text-xs">{r.requester_name}</div><div className="text-xs text-slate-500">{r.carrier_name ?? '—'}</div></> },
        { key: 'transit', header: 'Customs transit', render: (r) => r.transit_doc_no ? <><div className="font-mono text-xs">{r.transit_doc_no}</div><div className={r.overdue ? 'text-xs font-medium text-red-600' : 'text-xs text-slate-500'}>by {fmtDateTime(r.transit_deadline)}</div></> : <span className="text-xs text-slate-500">{r.remarks ?? '—'}</span> },
        { key: 'status', header: 'Status', render: (r) => <div className="flex flex-col gap-1"><Badge s={r.status} />{r.overdue && <Badge s="OVERDUE">Overdue</Badge>}</div> },
        { key: 'x', header: '', render: (r) => (
          <div className="flex gap-1">
            {r.status === 'CUSTOMS_APPROVED' && <Button size="sm" variant="secondary" onClick={() => act.mutate({ id: r.id, action: 'dispatch' })}>Dispatch</Button>}
            {r.status === 'IN_TRANSIT' && <Button size="sm" variant="success" onClick={() => act.mutate({ id: r.id, action: 'arrive' })}>Confirm arrival</Button>}
            {['REQUESTED', 'CUSTOMS_APPROVED'].includes(r.status) && r.requester_org_id === orgId && <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: r.id, action: 'cancel' })}>Cancel</Button>}
          </div>
        ) },
      ]} />
    </Card>
  );
}

function NewTransfer({ onClose, facilities }: { onClose: () => void; facilities: any[] }) {
  const terminals = useQuery({ queryKey: ['terminals'], queryFn: () => api<any[]>('/ref/terminals') });
  const carriers = useQuery({ queryKey: ['carriers'], queryFn: () => api<any[]>('/directory/organisations?type=HAULIER,RAIL_OPERATOR,BARGE_OPERATOR') });
  const bls = useQuery({ queryKey: ['bls-import'], queryFn: () => api<any[]>('/bls') });
  const [f, setF] = useState<any>({ direction: 'TO_FACILITY', mode: 'TRUCK', containers: '' });
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const pickBl = async (id: string) => {
    if (!id) return setF({ ...f, blId: '' });
    const bl = await api<any>(`/bls/${id}`);
    setF({ ...f, blId: id, containers: bl.containers.filter((k: any) => ['DISCHARGED', 'IN_YARD'].includes(k.status)).map((k: any) => k.container_no).join(' ') });
  };
  const fac = facilities.filter((x) => x.type !== 'EMPTY_DEPOT');
  const save = useAction(() => post('/inland-transfers', {
    direction: f.direction, facilityId: f.facilityId, terminalId: f.terminalId, blId: f.blId || undefined, mode: f.mode, carrierOrgId: f.carrierOrgId || undefined, remarks: f.remarks || undefined,
    containers: f.containers.split(/[\s,;]+/).filter(Boolean),
  }), { invalidate: [['inland-transfers'], ['inland-summary']], success: 'Transfer requested — customs has been notified', onDone: onClose });
  return (
    <Modal open onClose={onClose} title="Request bonded transfer" wide footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.facilityId || !f.terminalId || !f.containers.trim()}>Submit</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Direction"><Select value={f.direction} onChange={set('direction')} options={[{ value: 'TO_FACILITY', label: 'Import: port → inland facility' }, { value: 'TO_PORT', label: 'Export: inland facility → port' }]} /></Field>
        <Field label="Mode"><Select value={f.mode} onChange={set('mode')} options={['TRUCK', 'RAIL', 'BARGE'].map((m) => ({ value: m, label: label(m) }))} /></Field>
        <Field label="Inland facility"><Select value={f.facilityId ?? ''} onChange={set('facilityId')} placeholder="Select…" options={fac.map((x) => ({ value: x.id, label: `${x.name}${x.bonded ? ' (bonded)' : ''}` }))} /></Field>
        <Field label="Port terminal"><Select value={f.terminalId ?? ''} onChange={set('terminalId')} placeholder="Select…" options={(terminals.data ?? []).filter((x) => x.type === 'CONTAINER').map((x) => ({ value: x.id, label: x.name }))} /></Field>
        {f.direction === 'TO_FACILITY' && <Field label="Import B/L (fills the containers)" className="sm:col-span-2"><Select value={f.blId ?? ''} onChange={(e) => pickBl(e.target.value)} placeholder="—" options={(bls.data ?? []).filter((b) => b.direction === 'IMPORT').map((b) => ({ value: b.id, label: `${b.bl_no} · ${b.vessel_name} · ${label(b.customs_status)}` }))} /></Field>}
        <Field label="Containers" className="sm:col-span-2" hint="Separated by spaces or new lines"><Textarea rows={2} className="font-mono text-xs" value={f.containers} onChange={set('containers')} /></Field>
        <Field label="Carrier"><Select value={f.carrierOrgId ?? ''} onChange={set('carrierOrgId')} placeholder="—" options={(carriers.data ?? []).map((x) => ({ value: x.id, label: `${x.name} (${label(x.type)})` }))} /></Field>
        <Field label="Remarks"><Input value={f.remarks ?? ''} onChange={set('remarks')} /></Field>
      </div>
      <p className="mt-3 text-xs text-slate-500">Uncleared cargo can only move to a customs-bonded facility, under a transit document issued when customs approves. Cargo already released by customs moves without a bond.</p>
    </Modal>
  );
}
