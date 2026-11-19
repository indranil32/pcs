// Inland facility workspace: inventory, gate (EIR), and the type-specific work — depot repairs and empty releases, CFS jobs and lots.
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, DoorOpen, Plus, Trash2 } from 'lucide-react';
import { CONTAINER_COMPONENTS, DAMAGE_CODES } from '@pcs/shared';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, label, toLocalInput } from '../lib/format';
import { Badge, Button, Card, Field, Input, KV, Modal, PageHeader, Select, Table, Tabs, useAction, useToast } from '../components/ui';

const TYPE_LABEL: Record<string, string> = { DRY_PORT: 'Dry port (inland container depot)', EMPTY_DEPOT: 'Empty container depot', CFS: 'Container freight station' };
const PURPOSES: Record<string, [string, string, string][]> = {
  DRY_PORT: [['IMPORT_DELIVERY', 'OUT', 'Import delivery (DO + customs release)'], ['EXPORT_RECEIPT', 'IN', 'Export container received'], ['EMPTY_EVACUATION', 'OUT', 'Empty evacuation']],
  EMPTY_DEPOT: [['EMPTY_RETURN', 'IN', 'Empty return (survey)'], ['EMPTY_RELEASE', 'OUT', 'Empty release (release order)']],
  CFS: [['EXPORT_RECEIPT', 'IN', 'Export container received'], ['IMPORT_DELIVERY', 'OUT', 'FCL import delivery'], ['EMPTY_EVACUATION', 'OUT', 'Empty after destuffing']],
};

export default function Facility() {
  const { id } = useParams();
  const { has } = useAuth();
  const q = useQuery({ queryKey: ['facility', id], queryFn: () => api<any>(`/facilities/${id}`) });
  const f = q.data;
  const [tab, setTab] = useState('inventory');
  if (!f) return null;
  const tabs = [
    { id: 'inventory', label: 'Inventory', count: f.inventory.length },
    { id: 'gate', label: 'Gate & EIR', count: f.moves.length },
    ...(f.type === 'EMPTY_DEPOT' ? [{ id: 'repairs', label: 'Repairs (M&R)' }, { id: 'releases', label: 'Release orders' }] : []),
    ...(f.type === 'CFS' ? [{ id: 'jobs', label: 'Stuffing / destuffing' }, { id: 'lots', label: 'Cargo lots' }] : []),
  ];
  return (
    <div>
      <Link to="/inland" className="mb-2 inline-flex items-center gap-1 text-sm text-teal-700 hover:underline"><ArrowLeft className="h-4 w-4" />Inland facilities</Link>
      <PageHeader title={f.name} subtitle={`${TYPE_LABEL[f.type]} · ${f.code} · ${f.operator_name ?? 'no operator'}`} />
      <Card className="mb-5"><KV cols={4} items={[
        ['Customs bonded', f.bonded ? 'Yes' : 'No'], ['Distance from port', f.distance_km ? `${fmtNum(f.distance_km)} km` : '—'], ['Capacity', f.capacity_teu ? `${fmtNum(f.capacity_teu)} TEU` : '—'],
        ['Free storage', `${f.free_days} days`], ['Transit time allowed', `${f.transit_hours} h`], ['Location', f.location ?? '—'],
        ['Stock', f.stock.map((s: any) => `${s.n} × ${s.iso_type ?? '?'} ${s.full_empty === 'E' ? 'empty' : 'full'}${s.condition && s.condition !== 'SOUND' ? ` (${label(s.condition)})` : ''} ${s.line_name ?? ''}`).join(' · ') || '—'],
      ]} /></Card>
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'inventory' && <Inventory f={f} />}
      {tab === 'gate' && <Gate f={f} />}
      {tab === 'repairs' && <Repairs f={f} />}
      {tab === 'releases' && <Releases f={f} canIssue={has('SHIPPING_LINE', 'SHIPPING_AGENT')} />}
      {tab === 'jobs' && <Jobs f={f} />}
      {tab === 'lots' && <Lots f={f} />}
    </div>
  );
}

function Inventory({ f }: { f: any }) {
  return (
    <Card pad={false}>
      <Table rows={f.inventory} empty="No containers in the facility" cols={[
        { key: 'container_no', header: 'Container', render: (r) => <span className="font-mono text-xs">{r.container_no}</span> },
        { key: 'iso_type', header: 'Type' },
        { key: 'full_empty', header: 'F/E', render: (r) => r.full_empty === 'E' ? 'Empty' : 'Full' },
        { key: 'line_name', header: 'Line', render: (r) => r.line_name ?? '—' },
        { key: 'bl_no', header: 'B/L · customs', render: (r) => r.bl_no ? <><div className="text-xs">{r.bl_no}</div><Badge s={r.customs_status} /></> : '—' },
        { key: 'condition', header: 'Condition', render: (r) => <Badge s={r.condition ?? 'SOUND'} /> },
        { key: 'holds', header: 'Holds', render: (r) => r.holds?.length ? r.holds.join(', ') : '—' },
        { key: 'facility_in_at', header: 'In since', render: (r) => fmtDateTime(r.facility_in_at) },
        { key: 'dwell_days', header: 'Dwell', render: (r) => <span className={r.dwell_days > f.free_days ? 'font-medium text-amber-700' : ''}>{r.dwell_days} d</span> },
      ]} />
    </Card>
  );
}

function Gate({ f }: { f: any }) {
  const toast = useToast();
  const lines = useQuery({ queryKey: ['lines'], queryFn: () => api<any[]>('/directory/organisations?type=SHIPPING_LINE'), enabled: f.canOperate });
  const hauliers = useQuery({ queryKey: ['hauliers'], queryFn: () => api<any[]>('/directory/organisations?type=HAULIER'), enabled: f.canOperate });
  const options = PURPOSES[f.type];
  const [g, setG] = useState<any>({ purpose: options[0][0], condition: 'SOUND', damages: [] as any[] });
  const [result, setResult] = useState<any>(null);
  const set = (k: string) => (e: any) => setG({ ...g, [k]: e.target.value });
  const purpose = options.find((o) => o.at(0) === g.purpose)!;
  const save = useAction(() => post(`/facilities/${f.id}/gate`, {
    direction: purpose[1], purpose: g.purpose, containerNo: g.containerNo || undefined, truckPlate: g.truckPlate, haulierOrgId: g.haulierOrgId || undefined, lineOrgId: g.lineOrgId || undefined,
    reference: g.reference || undefined, isoType: g.isoType || undefined, sealNo: g.sealNo || undefined,
    ...(g.purpose === 'EMPTY_RETURN' ? { condition: g.damages.length ? 'DAMAGED' : g.condition, damages: g.damages } : {}),
  }), { invalidate: [['facility', f.id], ['facilities']], onDone: (r) => { setResult(r); toast(r.result === 'ACCEPTED' ? 'ok' : 'err', r.result === 'ACCEPTED' ? `EIR ${r.eir_no} issued` : r.reason); } });
  return (
    <div className="grid gap-5 lg:grid-cols-5">
      {f.canOperate && (
        <Card title={<span className="flex items-center gap-2"><DoorOpen className="h-4 w-4" />Gate transaction</span>} className="lg:col-span-2">
          <div className="space-y-3">
            <Field label="Movement"><Select value={g.purpose} onChange={set('purpose')} options={options.map(([v, d, l]) => ({ value: v, label: `${d} — ${l}` }))} /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={g.purpose === 'EMPTY_RELEASE' ? 'Container (optional — auto-allocate)' : 'Container'}><Input className="font-mono" value={g.containerNo ?? ''} onChange={set('containerNo')} /></Field>
              <Field label="Truck plate"><Input value={g.truckPlate ?? ''} onChange={set('truckPlate')} /></Field>
              <Field label="Haulier"><Select value={g.haulierOrgId ?? ''} onChange={set('haulierOrgId')} placeholder="—" options={(hauliers.data ?? []).map((x) => ({ value: x.id, label: x.name }))} /></Field>
              {['EMPTY_RELEASE', 'IMPORT_DELIVERY'].includes(g.purpose)
                ? <Field label={g.purpose === 'EMPTY_RELEASE' ? 'Release order no.' : 'Delivery order no. or PIN'}><Input value={g.reference ?? ''} onChange={set('reference')} /></Field>
                : <Field label="Shipping line"><Select value={g.lineOrgId ?? ''} onChange={set('lineOrgId')} placeholder="— from records —" options={(lines.data ?? []).map((x) => ({ value: x.id, label: x.name }))} /></Field>}
              {['EMPTY_RETURN', 'EXPORT_RECEIPT'].includes(g.purpose) && <Field label="ISO type"><Input value={g.isoType ?? ''} onChange={set('isoType')} placeholder="22G1" /></Field>}
              {g.purpose === 'EXPORT_RECEIPT' && <Field label="Seal"><Input value={g.sealNo ?? ''} onChange={set('sealNo')} /></Field>}
            </div>
            {g.purpose === 'EMPTY_RETURN' && <Survey damages={g.damages} onChange={(d) => setG({ ...g, damages: d })} />}
            <Button className="w-full" onClick={() => save.mutate()} loading={save.isPending} disabled={!g.truckPlate}>Record {purpose[1] === 'IN' ? 'gate-in' : 'gate-out'}</Button>
            {result && (
              <div className={`rounded-lg p-3 text-sm ${result.result === 'ACCEPTED' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>
                {result.result === 'ACCEPTED' ? <>EIR <b className="font-mono">{result.eir_no}</b> — {result.container_no}{result.dwell_days ? ` · dwell ${result.dwell_days} d` : ''}{result.invoice ? ` · invoice ${result.invoice.invoiceNo}` : ''}</> : <>Rejected: {result.reason}</>}
              </div>
            )}
          </div>
        </Card>
      )}
      <Card pad={false} className={f.canOperate ? 'lg:col-span-3' : 'lg:col-span-5'}>
        <Table rows={f.moves} empty="No gate movements" cols={[
          { key: 'at', header: 'Time', render: (r) => fmtDateTime(r.at) },
          { key: 'eir_no', header: 'EIR', render: (r) => <span className="font-mono text-xs">{r.eir_no ?? '—'}</span> },
          { key: 'direction', header: 'Move', render: (r) => <><div className="text-xs font-medium">{r.direction}</div><div className="text-xs text-slate-500">{label(r.purpose)}</div></> },
          { key: 'container_no', header: 'Container', render: (r) => <><div className="font-mono text-xs">{r.container_no ?? r.reference ?? '—'}</div><div className="text-xs text-slate-500">{r.truck_plate}</div></> },
          { key: 'condition', header: 'Survey', render: (r) => r.condition ? <><Badge s={r.condition} />{r.damages?.length > 0 && <div className="mt-0.5 text-[11px] text-slate-500">{r.damages.map((d: any) => `${d.component}: ${DAMAGE_CODES[d.code] ?? d.code}`).join('; ')}</div>}</> : '—' },
          { key: 'result', header: 'Result', render: (r) => <><Badge s={r.result} />{r.reason && <div className="max-w-48 text-[11px] text-red-600">{r.reason}</div>}</> },
        ]} />
      </Card>
    </div>
  );
}

function Survey({ damages, onChange }: { damages: any[]; onChange: (d: any[]) => void }) {
  const [d, setD] = useState({ component: CONTAINER_COMPONENTS[0], code: 'DT', remarks: '' });
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Condition survey {damages.length ? <Badge s="DAMAGED" /> : <Badge s="SOUND" />}</div>
      {damages.map((x, i) => <div key={i} className="flex items-center justify-between py-0.5 text-xs"><span>{x.component}: {DAMAGE_CODES[x.code]}{x.remarks ? ` — ${x.remarks}` : ''}</span><button onClick={() => onChange(damages.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5 text-slate-400" /></button></div>)}
      <div className="mt-2 grid grid-cols-[1fr_1fr_1fr_auto] gap-1.5">
        <Select value={d.component} onChange={(e) => setD({ ...d, component: e.target.value })} options={CONTAINER_COMPONENTS.map((c) => ({ value: c, label: c }))} />
        <Select value={d.code} onChange={(e) => setD({ ...d, code: e.target.value })} options={Object.entries(DAMAGE_CODES).map(([k, v]) => ({ value: k, label: `${k} ${v}` }))} />
        <Input placeholder="Remarks" value={d.remarks} onChange={(e) => setD({ ...d, remarks: e.target.value })} />
        <Button size="sm" variant="secondary" onClick={() => onChange([...damages, d])}><Plus className="h-3.5 w-3.5" /></Button>
      </div>
    </div>
  );
}

function Repairs({ f }: { f: any }) {
  const { has, me } = useAuth();
  const q = useQuery({ queryKey: ['repairs'], queryFn: () => api<any[]>('/depot/repairs') });
  const act = useAction((a: { id: string; action: string }) => post(`/depot/repairs/${a.id}/${a.action}`), { invalidate: [['repairs'], ['facility', f.id]], success: 'Estimate updated' });
  const [open, setOpen] = useState(false);
  const rows = (q.data ?? []).filter((r) => r.facility_id === f.id);
  return (
    <>
      {f.canOperate && <div className="mb-3 flex justify-end"><Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />New repair estimate</Button></div>}
      <Card pad={false}>
        <Table rows={rows} empty="No repair estimates" cols={[
          { key: 'estimate_no', header: 'Estimate', render: (r) => <><div className="font-mono text-xs">{r.estimate_no}</div><div className="text-xs text-slate-500">{fmtDate(r.created_at)}</div></> },
          { key: 'container_no', header: 'Container', render: (r) => <span className="font-mono text-xs">{r.container_no}</span> },
          { key: 'line_name', header: 'Line' },
          { key: 'items', header: 'Work', render: (r) => <div className="text-xs">{r.items.map((i: any) => `${i.component}: ${i.repair}`).join('; ')}</div> },
          { key: 'total', header: 'Total', render: (r) => fmtMoney(r.total, r.currency) },
          { key: 'status', header: 'Status', render: (r) => <Badge s={r.status} /> },
          { key: 'x', header: '', render: (r) => <div className="flex gap-1">
            {r.status === 'ESTIMATED' && has('SHIPPING_LINE') && r.line_org_id === me?.user.orgId && <><Button size="sm" variant="success" onClick={() => act.mutate({ id: r.id, action: 'approve' })}>Approve</Button><Button size="sm" variant="ghost" onClick={() => act.mutate({ id: r.id, action: 'reject' })}>Reject</Button></>}
            {r.status === 'APPROVED' && f.canOperate && <Button size="sm" variant="secondary" onClick={() => act.mutate({ id: r.id, action: 'complete' })}>Repair done</Button>}
          </div> },
        ]} />
      </Card>
      {open && <NewEstimate f={f} onClose={() => setOpen(false)} />}
    </>
  );
}

function NewEstimate({ f, onClose }: { f: any; onClose: () => void }) {
  const damaged = f.inventory.filter((k: any) => k.full_empty === 'E');
  const [no, setNo] = useState(damaged.find((k: any) => k.condition === 'DAMAGED')?.container_no ?? '');
  const [items, setItems] = useState([{ component: CONTAINER_COMPONENTS[0], damage: 'DT', repair: 'Straighten', hours: 1, material: 0 }]);
  const upd = (i: number, k: string, v: any) => setItems(items.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const save = useAction(() => post('/depot/repairs', { facilityId: f.id, containerNo: no, items }), { invalidate: [['repairs'], ['facility', f.id]], success: 'Estimate sent to the line', onDone: onClose });
  return (
    <Modal open wide onClose={onClose} title="Repair estimate (M&R)" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!no}>Send to line</Button></>}>
      <Field label="Container"><Select value={no} onChange={(e) => setNo(e.target.value)} placeholder="Select…" options={damaged.map((k: any) => ({ value: k.container_no, label: `${k.container_no} · ${k.line_name ?? ''} · ${label(k.condition)}` }))} /></Field>
      <div className="mt-3 space-y-2">
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-[1.3fr_0.8fr_1.3fr_0.6fr_0.7fr] gap-1.5">
            <Select value={it.component} onChange={(e) => upd(i, 'component', e.target.value)} options={CONTAINER_COMPONENTS.map((c) => ({ value: c, label: c }))} />
            <Select value={it.damage} onChange={(e) => upd(i, 'damage', e.target.value)} options={Object.keys(DAMAGE_CODES).map((k) => ({ value: k, label: `${k} ${DAMAGE_CODES[k]}` }))} />
            <Input value={it.repair} onChange={(e) => upd(i, 'repair', e.target.value)} placeholder="Repair" />
            <Input type="number" step="0.5" value={it.hours} onChange={(e) => upd(i, 'hours', Number(e.target.value))} title="Labour hours" />
            <Input type="number" value={it.material} onChange={(e) => upd(i, 'material', Number(e.target.value))} title="Material cost" />
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setItems([...items, { component: CONTAINER_COMPONENTS[0], damage: 'DT', repair: '', hours: 1, material: 0 }])}><Plus className="h-3.5 w-3.5" />Add line</Button>
      </div>
      <p className="mt-2 text-xs text-slate-500">Columns: component, damage code, repair, labour hours, material cost. Labour is priced at the port's depot labour rate.</p>
    </Modal>
  );
}

function Releases({ f, canIssue }: { f: any; canIssue: boolean }) {
  const q = useQuery({ queryKey: ['releases'], queryFn: () => api<any[]>('/depot/releases') });
  const act = useAction((id: string) => post(`/depot/releases/${id}/cancel`), { invalidate: [['releases']], success: 'Release cancelled' });
  const [open, setOpen] = useState(false);
  const rows = (q.data ?? []).filter((r) => r.facility_id === f.id);
  return (
    <>
      {canIssue && <div className="mb-3 flex justify-end"><Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Issue empty release</Button></div>}
      <Card pad={false}>
        <Table rows={rows} empty="No release orders" cols={[
          { key: 'release_no', header: 'Release', render: (r) => <span className="font-mono text-xs">{r.release_no}</span> },
          { key: 'booking_no', header: 'Booking' }, { key: 'line_name', header: 'Line' },
          { key: 'iso_type', header: 'Type' },
          { key: 'qty', header: 'Released', render: (r) => `${r.released} / ${r.quantity}` },
          { key: 'available', header: 'Sound in stock', render: (r) => <span className={r.available < r.quantity - r.released ? 'text-amber-700' : ''}>{r.available}</span> },
          { key: 'haulier_name', header: 'Haulier', render: (r) => r.haulier_name ?? 'any' },
          { key: 'valid_until', header: 'Valid until', render: (r) => fmtDate(r.valid_until) },
          { key: 'status', header: 'Status', render: (r) => <Badge s={r.status} /> },
          { key: 'x', header: '', render: (r) => r.status === 'OPEN' && canIssue ? <Button size="sm" variant="ghost" onClick={() => act.mutate(r.id)}>Cancel</Button> : null },
        ]} />
      </Card>
      {open && <NewRelease f={f} onClose={() => setOpen(false)} />}
    </>
  );
}

function NewRelease({ f, onClose }: { f: any; onClose: () => void }) {
  const hauliers = useQuery({ queryKey: ['hauliers'], queryFn: () => api<any[]>('/directory/organisations?type=HAULIER') });
  const [r, setR] = useState<any>({ isoType: '22G1', quantity: 1, validUntil: toLocalInput(new Date(Date.now() + 5 * 864e5)).slice(0, 10) });
  const set = (k: string) => (e: any) => setR({ ...r, [k]: e.target.value });
  const toast = useToast();
  const save = useAction(() => post('/depot/releases', { facilityId: f.id, bookingNo: r.bookingNo, isoType: r.isoType, quantity: Number(r.quantity), haulierOrgId: r.haulierOrgId || undefined, validUntil: r.validUntil }),
    { invalidate: [['releases']], onDone: (x) => { toast(x.warning ? 'err' : 'ok', x.warning ?? `Release ${x.release_no} issued`); onClose(); } });
  return (
    <Modal open onClose={onClose} title={`Empty release — ${f.name}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!r.bookingNo}>Issue</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Booking no."><Input value={r.bookingNo ?? ''} onChange={set('bookingNo')} /></Field>
        <Field label="ISO type"><Select value={r.isoType} onChange={set('isoType')} options={['22G1', '45G1', '42G1', '22R1', '45R1'].map((x) => ({ value: x, label: x }))} /></Field>
        <Field label="Quantity"><Input type="number" min={1} value={r.quantity} onChange={set('quantity')} /></Field>
        <Field label="Valid until"><Input type="date" value={r.validUntil} onChange={set('validUntil')} /></Field>
        <Field label="Haulier (optional)" className="sm:col-span-2"><Select value={r.haulierOrgId ?? ''} onChange={set('haulierOrgId')} placeholder="Any haulier" options={(hauliers.data ?? []).map((x) => ({ value: x.id, label: x.name }))} /></Field>
      </div>
    </Modal>
  );
}

function Jobs({ f }: { f: any }) {
  const { has } = useAuth();
  const q = useQuery({ queryKey: ['cfs-jobs'], queryFn: () => api<any[]>('/cfs/jobs') });
  const act = useAction((a: { id: string; action: string }) => post(`/cfs/jobs/${a.id}/${a.action}`), { invalidate: [['cfs-jobs'], ['facility', f.id]], success: 'Job updated' });
  const [complete, setComplete] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const rows = (q.data ?? []).filter((j) => j.facility_id === f.id);
  return (
    <>
      {has('FREIGHT_FORWARDER') && <div className="mb-3 flex justify-end"><Button onClick={() => setOpen(true)}><Plus className="h-4 w-4" />Request destuffing</Button></div>}
      <Card pad={false}>
        <Table rows={rows} empty="No CFS jobs" cols={[
          { key: 'job_no', header: 'Job', render: (r) => <><div className="font-mono text-xs">{r.job_no}</div><div className="text-xs text-slate-500">{label(r.type)}</div></> },
          { key: 'container_no', header: 'Container', render: (r) => <><div className="font-mono text-xs">{r.container_no}</div>{r.seal_no && <div className="text-xs text-slate-500">seal {r.seal_no}</div>}</> },
          { key: 'requester_name', header: 'Requested by' },
          { key: 'lots', header: 'House B/Ls', render: (r) => <div className="text-xs">{r.lots.map((l: any) => `${l.house_bl} (${l.packages_received ?? l.packages}/${l.packages})`).join(', ')}</div> },
          { key: 'remarks', header: 'Remarks', render: (r) => <span className="text-xs text-slate-500">{r.remarks ?? '—'}</span> },
          { key: 'status', header: 'Status', render: (r) => <Badge s={r.status} /> },
          { key: 'x', header: '', render: (r) => f.canOperate && <div className="flex gap-1">
            {['REQUESTED', 'SCHEDULED'].includes(r.status) && <Button size="sm" variant="secondary" onClick={() => act.mutate({ id: r.id, action: 'start' })}>Start</Button>}
            {r.status === 'IN_PROGRESS' && <Button size="sm" variant="success" onClick={() => setComplete(r)}>Complete</Button>}
          </div> },
        ]} />
      </Card>
      {complete && <CompleteJob job={complete} f={f} onClose={() => setComplete(null)} />}
      {open && <NewDestuff f={f} onClose={() => setOpen(false)} />}
    </>
  );
}

function CompleteJob({ job, f, onClose }: { job: any; f: any; onClose: () => void }) {
  const [tally, setTally] = useState<Record<string, any>>(Object.fromEntries(job.lots.map((l: any, i: number) => [l.id, { packagesReceived: l.packages, packagesDamaged: 0, location: `SHED/${i + 1}` }])));
  const [seal, setSeal] = useState('');
  const save = useAction(() => post(`/cfs/jobs/${job.id}/complete`, { sealNo: seal || undefined, tally: Object.entries(tally).map(([lotId, t]) => ({ lotId, ...t, packagesReceived: Number(t.packagesReceived), packagesDamaged: Number(t.packagesDamaged) })) }),
    { invalidate: [['cfs-jobs'], ['cfs-lots'], ['facility', f.id]], success: 'Job completed', onDone: onClose });
  return (
    <Modal open wide onClose={onClose} title={`${label(job.type)} ${job.container_no} — tally`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Complete</Button></>}>
      {job.type === 'DESTUFF' ? (
        <div className="space-y-2">
          <div className="grid grid-cols-[1.5fr_0.8fr_0.8fr_1fr] gap-2 text-xs font-medium text-slate-500"><span>House B/L (declared)</span><span>Received</span><span>Damaged</span><span>Location</span></div>
          {job.lots.map((l: any) => (
            <div key={l.id} className="grid grid-cols-[1.5fr_0.8fr_0.8fr_1fr] items-center gap-2">
              <span className="text-sm">{l.house_bl} <span className="text-xs text-slate-500">({l.packages} pkgs)</span></span>
              <Input type="number" value={tally[l.id].packagesReceived} onChange={(e) => setTally({ ...tally, [l.id]: { ...tally[l.id], packagesReceived: e.target.value } })} />
              <Input type="number" value={tally[l.id].packagesDamaged} onChange={(e) => setTally({ ...tally, [l.id]: { ...tally[l.id], packagesDamaged: e.target.value } })} />
              <Input value={tally[l.id].location} onChange={(e) => setTally({ ...tally, [l.id]: { ...tally[l.id], location: e.target.value } })} />
            </div>
          ))}
        </div>
      ) : <Field label="Seal number"><Input value={seal} onChange={(e) => setSeal(e.target.value)} /></Field>}
    </Modal>
  );
}

function NewDestuff({ f, onClose }: { f: any; onClose: () => void }) {
  const full = f.inventory.filter((k: any) => k.full_empty === 'F');
  const [no, setNo] = useState(full[0]?.container_no ?? '');
  const [lots, setLots] = useState('HB-0001; Consignee A; General cargo; 20; 1500; 6\nHB-0002; Consignee B; Spare parts; 12; 900; 3.5');
  const save = useAction(() => post('/cfs/jobs', { facilityId: f.id, type: 'DESTUFF', containerNo: no, lots: lots.split('\n').filter((l) => l.trim()).map((l) => {
    const [houseBl, consignee, description, packages, weightKg, volumeM3] = l.split(';').map((x) => x.trim());
    return { houseBl, consignee, description, packages: Number(packages), weightKg: Number(weightKg) || undefined, volumeM3: Number(volumeM3) || undefined };
  }) }), { invalidate: [['cfs-jobs']], success: 'Destuffing requested', onDone: onClose });
  return (
    <Modal open wide onClose={onClose} title="Request destuffing (LCL import)" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!no}>Request</Button></>}>
      <Field label="Container at the CFS"><Select value={no} onChange={(e) => setNo(e.target.value)} placeholder="Select…" options={full.map((k: any) => ({ value: k.container_no, label: `${k.container_no} · ${k.bl_no ?? ''}` }))} /></Field>
      <Field label="House B/Ls — one per line: house B/L; consignee; description; packages; kg; m³" className="mt-3"><textarea rows={5} className="w-full rounded-md border border-slate-300 p-2 font-mono text-xs" value={lots} onChange={(e) => setLots(e.target.value)} /></Field>
    </Modal>
  );
}

function Lots({ f }: { f: any }) {
  const { has } = useAuth();
  const q = useQuery({ queryKey: ['cfs-lots', f.id], queryFn: () => api<any[]>(`/cfs/lots?facilityId=${f.id}`) });
  const act = useAction((a: { id: string; action: string; body?: any }) => post(`/cfs/lots/${a.id}/${a.action}`, a.body), { invalidate: [['cfs-lots', f.id], ['facility', f.id]], success: 'Lot updated' });
  const [sel, setSel] = useState<string[]>([]);
  const [stuff, setStuff] = useState(false);
  const [advise, setAdvise] = useState(false);
  const ask = (msg: string, dflt = '') => window.prompt(msg, dflt); // eslint-disable-line no-alert
  return (
    <>
      <div className="mb-3 flex justify-end gap-2">
        {has('FREIGHT_FORWARDER') && <Button variant="secondary" onClick={() => setAdvise(true)}><Plus className="h-4 w-4" />Pre-advise export cargo</Button>}
        {has('FREIGHT_FORWARDER') && <Button disabled={!sel.length} onClick={() => setStuff(true)}>Stuff selected ({sel.length})</Button>}
      </div>
      <Card pad={false}>
        <Table rows={q.data} loading={q.isLoading} empty="No cargo lots" cols={[
          { key: 'sel', header: '', render: (r) => r.direction === 'EXPORT' && r.status === 'IN_STORE' && !r.job_no && has('FREIGHT_FORWARDER') ? <input type="checkbox" checked={sel.includes(r.id)} onChange={(e) => setSel(e.target.checked ? [...sel, r.id] : sel.filter((x) => x !== r.id))} /> : null },
          { key: 'house_bl', header: 'House B/L', render: (r) => <><div className="font-medium">{r.house_bl}</div><div className="font-mono text-[11px] text-slate-500">{r.lot_no}</div></> },
          { key: 'direction', header: 'Dir.', render: (r) => label(r.direction) },
          { key: 'consignee', header: 'Consignee / cargo', render: (r) => <><div className="text-xs">{r.consignee ?? '—'}</div><div className="text-xs text-slate-500">{r.description}</div></> },
          { key: 'pkgs', header: 'Packages', render: (r) => <div className="text-xs">{r.packages_received ?? '—'} / {r.packages} {r.packages_damaged > 0 && <span className="text-red-600">· {r.packages_damaged} dmg</span>}{r.packages_delivered > 0 && <div className="text-slate-500">{r.packages_delivered} delivered</div>}</div> },
          { key: 'volume_m3', header: 'm³ / kg', render: (r) => <span className="text-xs">{fmtNum(r.volume_m3, 1)} / {fmtNum(r.weight_kg)}</span> },
          { key: 'location', header: 'Location', render: (r) => r.location ?? '—' },
          { key: 'customs_status', header: 'Customs', render: (r) => <><Badge s={r.customs_status} />{r.declaration_no && <div className="text-[11px] text-slate-500">{r.declaration_no}</div>}</> },
          { key: 'status', header: 'Status', render: (r) => <Badge s={r.status} /> },
          { key: 'x', header: '', render: (r) => <div className="flex flex-wrap gap-1">
            {has('FREIGHT_FORWARDER') && ['NOT_DECLARED', 'HELD'].includes(r.customs_status) && r.status !== 'EXPECTED' && <Button size="sm" variant="secondary" onClick={() => { const n = ask('Customs declaration number'); if (n) act.mutate({ id: r.id, action: 'declaration', body: { declarationNo: n } }); }}>Declare</Button>}
            {has('CUSTOMS') && ['DECLARED', 'UNDER_INSPECTION'].includes(r.customs_status) && <><Button size="sm" variant="success" onClick={() => act.mutate({ id: r.id, action: 'customs-status', body: { status: 'RELEASED' } })}>Release</Button><Button size="sm" variant="ghost" onClick={() => act.mutate({ id: r.id, action: 'customs-status', body: { status: 'UNDER_INSPECTION', remarks: 'Selected for examination at the CFS' } })}>Inspect</Button></>}
            {f.canOperate && r.direction === 'EXPORT' && r.status === 'EXPECTED' && <Button size="sm" variant="secondary" onClick={() => { const t = ask('Truck plate'); if (t) act.mutate({ id: r.id, action: 'receive', body: { packagesReceived: r.packages, truckPlate: t, location: 'SHED-B' } }); }}>Receive</Button>}
            {f.canOperate && r.direction === 'IMPORT' && ['IN_STORE', 'PARTLY_DELIVERED'].includes(r.status) && <Button size="sm" variant="secondary" disabled={r.customs_status !== 'RELEASED'} title={r.customs_status !== 'RELEASED' ? 'Awaiting customs release' : ''} onClick={() => {
              const left = (r.packages_received ?? r.packages) - r.packages_delivered;
              const p = ask(`Packages to deliver (max ${left})`, String(left)); const t = p && ask('Truck plate');
              if (p && t) act.mutate({ id: r.id, action: 'deliver', body: { packages: Number(p), truckPlate: t } });
            }}>Deliver</Button>}
          </div> },
        ]} />
      </Card>
      {stuff && <StuffModal f={f} lotIds={sel} onClose={() => { setStuff(false); setSel([]); }} />}
      {advise && <AdviseModal f={f} onClose={() => setAdvise(false)} />}
    </>
  );
}

function StuffModal({ f, lotIds, onClose }: { f: any; lotIds: string[]; onClose: () => void }) {
  const lines = useQuery({ queryKey: ['lines'], queryFn: () => api<any[]>('/directory/organisations?type=SHIPPING_LINE') });
  const [no, setNo] = useState('');
  const [line, setLine] = useState('');
  const save = useAction(() => post('/cfs/jobs', { facilityId: f.id, type: 'STUFF', containerNo: no, lineOrgId: line || undefined, lotIds }), { invalidate: [['cfs-jobs'], ['cfs-lots', f.id]], success: 'Stuffing requested', onDone: onClose });
  return (
    <Modal open onClose={onClose} title={`Stuff ${lotIds.length} lot(s) into a container`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!no}>Request</Button></>}>
      <Field label="Empty container"><Input className="font-mono" value={no} onChange={(e) => setNo(e.target.value)} /></Field>
      <Field label="Shipping line (if the empty is not yet at the CFS)" className="mt-3"><Select value={line} onChange={(e) => setLine(e.target.value)} placeholder="—" options={(lines.data ?? []).map((x) => ({ value: x.id, label: x.name }))} /></Field>
      <p className="mt-2 text-xs text-slate-500">Only export lots released by customs can be stuffed. After stuffing, request an export transfer to the port terminal.</p>
    </Modal>
  );
}

function AdviseModal({ f, onClose }: { f: any; onClose: () => void }) {
  const [l, setL] = useState<any>({ packages: 10 });
  const set = (k: string) => (e: any) => setL({ ...l, [k]: e.target.value });
  const save = useAction(() => post('/cfs/lots', { facilityId: f.id, houseBl: l.houseBl, consignee: l.consignee, description: l.description, packages: Number(l.packages), weightKg: Number(l.weightKg) || undefined, volumeM3: Number(l.volumeM3) || undefined }),
    { invalidate: [['cfs-lots', f.id]], success: 'Export cargo pre-advised', onDone: onClose });
  return (
    <Modal open onClose={onClose} title="Pre-advise export cargo" footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!l.houseBl}>Save</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="House B/L"><Input value={l.houseBl ?? ''} onChange={set('houseBl')} /></Field>
        <Field label="Consignee"><Input value={l.consignee ?? ''} onChange={set('consignee')} /></Field>
        <Field label="Description" className="sm:col-span-2"><Input value={l.description ?? ''} onChange={set('description')} /></Field>
        <Field label="Packages"><Input type="number" value={l.packages} onChange={set('packages')} /></Field>
        <Field label="Weight (kg)"><Input type="number" value={l.weightKg ?? ''} onChange={set('weightKg')} /></Field>
        <Field label="Volume (m³)"><Input type="number" value={l.volumeM3 ?? ''} onChange={set('volumeM3')} /></Field>
      </div>
    </Modal>
  );
}
