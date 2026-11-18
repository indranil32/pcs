import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Search } from 'lucide-react';
import { CUSTOMS_STATUS } from '@pcs/shared';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { fmtDateTime, label } from '../lib/format';
import { Badge, Button, Card, Field, Input, KV, Modal, PageHeader, Select, Table, Tabs, Timeline, useAction } from '../components/ui';

export default function Cargo() {
  const t = useT();
  const [tab, setTab] = useState('bls');
  const [search, setSearch] = useState('');
  const [cs, setCs] = useState('');
  const [bl, setBl] = useState<string | null>(null);
  const [track, setTrack] = useState('');
  const bls = useQuery({ queryKey: ['bls', search, cs], queryFn: () => api<any[]>(`/bls?${new URLSearchParams({ ...(search && { search }), ...(cs && { customsStatus: cs }) })}`), enabled: tab === 'bls' });
  const boxes = useQuery({ queryKey: ['containers', search], queryFn: () => api<any[]>(`/containers?${new URLSearchParams({ ...(search && { search }) })}`), enabled: tab === 'containers' });

  return (
    <div>
      <PageHeader title={t('cargo')} subtitle="Manifested B/Ls, customs status from the customs system, holds and container tracking" />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'bls', label: 'Bills of lading' }, { id: 'containers', label: 'Containers' }, { id: 'track', label: 'Track & trace' }]} />
      {tab !== 'track' && (
        <div className="mb-3 flex flex-wrap gap-2">
          <Input placeholder={`${t('search')}: B/L, container, consignee, declaration`} value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" />
          {tab === 'bls' && <Select value={cs} onChange={(e) => setCs(e.target.value)} placeholder="Customs: all" options={CUSTOMS_STATUS.map((s) => ({ value: s, label: label(s) }))} className="max-w-xs" />}
        </div>
      )}
      {tab === 'bls' && (
        <Card pad={false}>
          <Table rows={bls.data} loading={bls.isLoading} onRow={(r) => setBl(r.id)} cols={[
            { key: 'bl_no', header: 'B/L', render: (r) => <span className="font-mono text-xs">{r.bl_no}</span> },
            { key: 'vessel_name', header: 'Vessel / call', render: (r) => <><div>{r.vessel_name}</div><div className="text-xs text-slate-500">{r.call_no}</div></> },
            { key: 'direction', header: 'Dir.', render: (r) => label(r.direction) },
            { key: 'consignee', header: 'Consignee' }, { key: 'description', header: 'Goods' },
            { key: 'container_count', header: 'Cntrs', className: 'text-right' },
            { key: 'declaration_no', header: 'Declaration', render: (r) => r.declaration_no ? <span className="font-mono text-xs">{r.declaration_no}</span> : '—' },
            { key: 'customs_status', header: 'Customs', render: (r) => <Badge s={r.customs_status} /> },
            { key: 'do_status', header: 'eDO', render: (r) => r.do_status ? <Badge s={r.do_status} /> : '—' },
          ]} />
        </Card>
      )}
      {tab === 'containers' && (
        <Card pad={false}>
          <Table rows={boxes.data} loading={boxes.isLoading} onRow={(r) => { setTrack(r.container_no); setTab('track'); }} cols={[
            { key: 'container_no', header: 'Container', render: (r) => <span className="font-mono text-xs">{r.container_no}</span> },
            { key: 'iso_type', header: 'Type' }, { key: 'bl_no', header: 'B/L', render: (r) => <span className="font-mono text-xs">{r.bl_no}</span> },
            { key: 'vessel_name', header: 'Vessel' }, { key: 'terminal_code', header: 'Terminal' },
            { key: 'status', header: 'Status', render: (r) => <Badge s={r.status} /> },
            { key: 'holds', header: 'Holds', render: (r) => r.holds.length ? r.holds.map((h: string) => <Badge key={h} s="HELD">{h}</Badge>) : '—' },
            { key: 'customs_status', header: 'Customs', render: (r) => <Badge s={r.customs_status} /> },
            { key: 'dwell_days', header: 'Dwell (d)', className: 'num text-right' },
          ]} />
        </Card>
      )}
      {tab === 'track' && <Track initial={track} />}
      {bl && <BlModal id={bl} onClose={() => setBl(null)} />}
    </div>
  );
}

function Track({ initial }: { initial: string }) {
  const [no, setNo] = useState(initial);
  const [go, setGo] = useState(initial);
  const q = useQuery({ queryKey: ['track', go], queryFn: () => api(`/containers/track/${go}`), enabled: !!go, retry: false });
  const k: any = q.data;
  return (
    <div className="space-y-4">
      <form onSubmit={(e) => { e.preventDefault(); setGo(no.trim().toUpperCase()); }} className="flex max-w-md gap-2">
        <Input placeholder="Container number (ISO 6346)" value={no} onChange={(e) => setNo(e.target.value)} className="font-mono" />
        <Button type="submit"><Search className="h-4 w-4" />Track</Button>
      </form>
      {q.error && <p className="text-sm text-red-600">{(q.error as any).message}</p>}
      {k && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card title={<span className="font-mono">{k.container_no}</span>} className="lg:col-span-2">
            <KV items={[['Status', <Badge s={k.status} />], ['Customs', <Badge s={k.customs_status} />], ['Holds', k.holds.join(', ') || 'None'], ['B/L', k.bl_no], ['Declaration', k.declaration_no], ['Vessel', `${k.vessel_name} (${k.call_no})`], ['Terminal', k.terminal_name], ['ISO type', k.iso_type], ['Seal', k.seal_no], ['Discharged', fmtDateTime(k.discharged_at)], ['Gated out', fmtDateTime(k.gated_out_at)], ['Full / empty', k.full_empty === 'F' ? 'Full' : 'Empty']]} />
          </Card>
          <Card title="Movements">
            <Timeline items={[
              ...k.events.map((e: any) => ({ title: label(e.event), at: e.at, who: e.source, tone: 'info' as const })),
              ...k.gate.map((g: any) => ({ title: `Gate ${g.direction} — ${g.truck_plate}`, at: g.at, body: g.reason, tone: g.result === 'ACCEPTED' ? 'ok' as const : 'bad' as const })),
            ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())} />
          </Card>
        </div>
      )}
    </div>
  );
}

function BlModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { has } = useAuth();
  const q = useQuery({ queryKey: ['bl', id], queryFn: () => api(`/bls/${id}`) });
  const hauliers = useQuery({ queryKey: ['dir', 'HAULIER'], queryFn: () => api<any[]>('/directory/organisations?type=HAULIER') });
  const b: any = q.data;
  const inv = [['bl', id], ['bls'], ['containers'], ['delivery-orders']];
  const [decl, setDecl] = useState('');
  const [cstat, setCstat] = useState('RELEASED');
  const [remarks, setRemarks] = useState('');
  const [haulier, setHaulier] = useState('');
  const declare = useAction(() => post(`/bls/${id}/declaration`, { declarationNo: decl }), { invalidate: inv, success: 'Declaration linked' });
  const customs = useAction(() => post(`/bls/${id}/customs-status`, { status: cstat, remarks: remarks || undefined }), { invalidate: inv, success: 'Customs status updated' });
  const reqDo = useAction(() => post('/delivery-orders', { blId: id, haulierOrgId: haulier || undefined }), { invalidate: inv, success: 'Delivery order requested' });
  const hold = useAction((a: { cid: string; hold: string; action: string }) => post(`/containers/${a.cid}/holds`, { hold: a.hold, action: a.action }), { invalidate: inv, success: 'Hold updated' });
  if (!b) return null;
  const openDo = b.deliveryOrders.find((d: any) => ['REQUESTED', 'ISSUED'].includes(d.status));
  return (
    <Modal open onClose={onClose} wide title={<>B/L <span className="font-mono">{b.bl_no}</span> <Badge s={b.customs_status} /></>}>
      <div className="space-y-5">
        <KV items={[['Vessel / call', <Link to={`/vessel-calls/${b.call_id}`} className="text-teal-700 hover:underline">{b.vessel_name} · {b.call_no}</Link>], ['Direction', label(b.direction)], ['Shipper', b.shipper], ['Consignee', b.consignee], ['Notify', b.notify_party], ['Forwarder', b.forwarder_name], ['POL → POD', `${b.pol ?? '—'} → ${b.pod ?? '—'}`], ['Goods', b.description], ['HS code', b.hs_code], ['Packages / gross kg', `${b.packages ?? '—'} / ${b.gross_kg ?? '—'}`], ['Declaration', b.declaration_no], ['Released', fmtDateTime(b.released_at)]]} />

        <div className="grid gap-3 md:grid-cols-2">
          {has('FREIGHT_FORWARDER', 'SHIPPING_AGENT') && ['NOT_DECLARED', 'DECLARED'].includes(b.customs_status) && (
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="mb-2 text-sm font-medium">Link customs declaration</div>
              <p className="mb-2 text-xs text-slate-500">Lodge the declaration in the customs system, then record its number here.</p>
              <div className="flex gap-2"><Input placeholder="Declaration no." value={decl} onChange={(e) => setDecl(e.target.value)} /><Button onClick={() => declare.mutate()} disabled={decl.length < 3}>Link</Button></div>
            </div>
          )}
          {has('CUSTOMS') && (
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="mb-2 text-sm font-medium">Customs decision</div>
              <div className="flex gap-2">
                <Select value={cstat} onChange={(e) => setCstat(e.target.value)} options={['DECLARED', 'UNDER_INSPECTION', 'RELEASED', 'HELD'].map((s) => ({ value: s, label: label(s) }))} />
                <Button onClick={() => customs.mutate()} loading={customs.isPending}>Apply</Button>
              </div>
              <Input className="mt-2" placeholder="Remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
            </div>
          )}
          {has('FREIGHT_FORWARDER') && b.direction === 'IMPORT' && !openDo && (
            <div className="rounded-lg border border-slate-200 p-3">
              <div className="mb-2 text-sm font-medium">Request electronic delivery order</div>
              <div className="flex gap-2">
                <Select value={haulier} onChange={(e) => setHaulier(e.target.value)} placeholder="Nominate haulier (optional)" options={(hauliers.data ?? []).map((o) => ({ value: o.id, label: o.name }))} />
                <Button onClick={() => reqDo.mutate()} loading={reqDo.isPending}>Request eDO</Button>
              </div>
            </div>
          )}
        </div>

        <Card title="Containers" pad={false}>
          <Table rows={b.containers} cols={[
            { key: 'container_no', header: 'Container', render: (k: any) => <span className="font-mono text-xs">{k.container_no}</span> },
            { key: 'iso_type', header: 'Type' }, { key: 'seal_no', header: 'Seal' },
            { key: 'status', header: 'Status', render: (k: any) => <Badge s={k.status} /> },
            { key: 'holds', header: 'Holds', render: (k: any) => <div className="flex flex-wrap gap-1">{k.holds.map((h: string) => (
              <button key={h} disabled={!has('CUSTOMS', 'PORT_HEALTH', 'TERMINAL_OPERATOR')} onClick={() => hold.mutate({ cid: k.id, hold: h, action: 'REMOVE' })} title="Remove hold"><Badge s="HELD">{h} ✕</Badge></button>
            ))}{has('PORT_HEALTH') && <button onClick={() => hold.mutate({ cid: k.id, hold: 'PORT_HEALTH', action: 'ADD' })}><Badge>+ health hold</Badge></button>}</div> },
          ]} />
        </Card>
        {b.deliveryOrders.length > 0 && (
          <Card title="Delivery orders" pad={false}>
            <Table rows={b.deliveryOrders} cols={[
              { key: 'do_no', header: 'eDO', render: (d: any) => <span className="font-mono text-xs">{d.do_no}</span> },
              { key: 'haulier_name', header: 'Haulier' }, { key: 'valid_until', header: 'Valid until', render: (d: any) => d.valid_until?.slice(0, 10) ?? '—' },
              { key: 'status', header: 'Status', render: (d: any) => <Badge s={d.status} /> },
            ]} />
          </Card>
        )}
      </div>
    </Modal>
  );
}

void Field;
