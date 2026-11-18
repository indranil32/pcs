import { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Check, FileText, Upload, Download, Send, Printer, AlertTriangle } from 'lucide-react';
import { FAL_FORMS, AGENCIES, type Agency } from '@pcs/shared';
import { api, post, put, download } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { fmtDateTime, fmtMoney, label, toLocalInput } from '../lib/format';
import { Badge, Button, Card, Field, Input, KV, Modal, PageHeader, Select, Table, Tabs, Textarea, Timeline, useAction, Empty } from '../components/ui';

const STEPS = [
  ['BERTH_REQUESTED', 'Berth request'], ['BERTH_ALLOCATED', 'Berth allocated'], ['PRE_ARRIVAL_SUBMITTED', 'Pre-arrival'], ['ARRIVAL_CLEARED', 'Arrival clearance'],
  ['ARRIVED', 'Arrived'], ['BERTHED', 'All fast'], ['DEPARTURE_REQUESTED', 'Departure request'], ['DEPARTURE_CLEARED', 'Departure clearance'], ['DEPARTED', 'Departed'],
];
const ORDER = ['DRAFT', ...STEPS.map((s) => s[0])];

export default function VesselCallDetail() {
  const { id } = useParams();
  const t = useT();
  const { me, has } = useAuth();
  const [tab, setTab] = useState('overview');
  const [modal, setModal] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['vessel-call', id], queryFn: () => api(`/vessel-calls/${id}`) });
  const c: any = q.data;
  const inv = [['vessel-call', id!], ['vessel-calls'], ['approvals'], ['notifications'], ['history', id!]];
  const act = (path: string, body?: any, success = 'Done') => ({ path, body, success });
  const run = useAction((a: { path: string; body?: any; success: string }) => post(`/vessel-calls/${id}/${a.path}`, a.body), { invalidate: inv, success: 'Updated' });
  if (!c) return <Empty text={q.isLoading ? 'Loading…' : 'Not found'} />;

  const owner = me?.user.orgId === c.agent_org_id || me?.user.orgId === c.line_org_id;
  const idx = ORDER.indexOf(c.status);
  const queries = c.approvals.filter((a: any) => a.status === 'QUERY');
  const myApprovals = c.approvals.filter((a: any) => a.status !== 'APPROVED' && has(a.agency as Agency) && (a.stage === 'ARRIVAL' ? c.status === 'PRE_ARRIVAL_SUBMITTED' : c.status === 'DEPARTURE_REQUESTED'));

  return (
    <div className="space-y-5">
      <PageHeader
        title={<span className="flex items-center gap-3">{c.vessel_name} <Badge s={c.status} /></span>}
        subtitle={<>IMO {c.imo} · {label(c.vessel_type)} · {c.flag} · GT {c.gt?.toLocaleString()} · LOA {c.loa} m · <span className="font-mono">{c.call_no}</span></>}
        actions={<>
          {owner && c.status === 'DRAFT' && <Button onClick={() => run.mutate(act('berth-request'))} loading={run.isPending}><Send className="h-4 w-4" />Submit berthing request</Button>}
          {owner && c.status === 'BERTH_ALLOCATED' && <Button onClick={() => run.mutate(act('pre-arrival'))} loading={run.isPending}><Send className="h-4 w-4" />Submit pre-arrival notification</Button>}
          {owner && queries.length > 0 && <Button variant="secondary" onClick={() => setModal('query')}><AlertTriangle className="h-4 w-4 text-amber-500" />Answer {queries.length} query</Button>}
          {owner && c.status === 'BERTHED' && <Button onClick={() => run.mutate(act('departure-request'))} loading={run.isPending}>Request departure clearance</Button>}
          {has('HARBOUR_MASTER') && c.status === 'BERTH_REQUESTED' && <><Button onClick={() => setModal('allocate')}>Allocate berth</Button><Button variant="secondary" onClick={() => setModal('return')}>Return to agent</Button></>}
          {has('HARBOUR_MASTER', 'SHIPPING_AGENT') && c.status === 'ARRIVAL_CLEARED' && (has('HARBOUR_MASTER') || owner) && <Button onClick={() => setModal('arrived')}>Record arrival (ATA)</Button>}
          {has('HARBOUR_MASTER', 'TERMINAL_OPERATOR') && c.status === 'ARRIVED' && <Button onClick={() => setModal('berthed')}>Record all fast</Button>}
          {has('HARBOUR_MASTER') && c.status === 'DEPARTURE_CLEARED' && <Button onClick={() => setModal('departed')}>Record departure (ATD)</Button>}
          {c.entry_permit_no && <Link to={`/vessel-calls/${id}/permit`} target="_blank"><Button variant="secondary"><Printer className="h-4 w-4" />Port entry permit</Button></Link>}
          {(owner || has('HARBOUR_MASTER')) && !['DEPARTED', 'CANCELLED', 'ARRIVED', 'BERTHED', 'DEPARTURE_REQUESTED', 'DEPARTURE_CLEARED'].includes(c.status) && <Button variant="ghost" onClick={() => setModal('cancel')}>Cancel call</Button>}
        </>}
      />

      {/* Lifecycle stepper */}
      <Card pad={false}>
        <div className="flex overflow-x-auto px-2 py-3">
          {STEPS.map(([s, name], i) => {
            const done = c.status !== 'CANCELLED' && idx > i + 1 - 1 && idx >= i + 1 && ORDER.indexOf(s) < idx;
            const curr = c.status === s;
            return (
              <div key={s} className="flex min-w-28 flex-1 flex-col items-center text-center">
                <div className="flex w-full items-center">
                  <div className={clsx('h-0.5 flex-1', i === 0 ? 'bg-transparent' : done || curr ? 'bg-teal-500' : 'bg-slate-200')} />
                  <div className={clsx('flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold', done ? 'bg-teal-600 text-white' : curr ? 'bg-navy-900 text-white ring-4 ring-teal-100' : 'bg-slate-100 text-slate-400')}>{done ? <Check className="h-4 w-4" /> : i + 1}</div>
                  <div className={clsx('h-0.5 flex-1', i === STEPS.length - 1 ? 'bg-transparent' : done ? 'bg-teal-500' : 'bg-slate-200')} />
                </div>
                <div className={clsx('mt-1.5 text-xs', curr ? 'font-semibold text-navy-900' : 'text-slate-500')}>{name}</div>
              </div>
            );
          })}
        </div>
      </Card>

      {myApprovals.map((a: any) => <DecisionBar key={a.id} a={a} inv={inv} />)}

      <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'overview', label: 'Overview' }, { id: 'fal', label: 'FAL forms', count: c.fal.length }, { id: 'clearance', label: 'Clearance', count: c.approvals.length },
        { id: 'cargo', label: 'Cargo', count: c.manifests.length }, { id: 'services', label: 'Services', count: c.services.length },
        { id: 'docs', label: t('documents') }, { id: 'messages', label: t('messages') }, { id: 'history', label: t('history') },
      ]} />

      {tab === 'overview' && (
        <div className="grid gap-5 lg:grid-cols-3">
          <Card title="Call details" className="lg:col-span-2">
            <KV items={[
              ['Agent', c.agent_name], ['Shipping line', c.line_name], ['Purpose', label(c.purpose)],
              ['Voyage in / out', `${c.voyage_in ?? '—'} / ${c.voyage_out ?? '—'}`], ['Last port', c.last_port], ['Next port', c.next_port],
              ['ETA', fmtDateTime(c.eta)], ['ETD', fmtDateTime(c.etd)], ['Arrival draft', c.arrival_draft ? `${c.arrival_draft} m` : '—'],
              ['ATA', fmtDateTime(c.ata)], ['All fast', fmtDateTime(c.berthed_at)], ['ATD', fmtDateTime(c.atd)],
              ['Requested berth', c.requested_berth_code], ['Allocated berth', c.berth_code ? `${c.berth_code} — ${c.berth_name}` : '—'], ['Terminal', c.terminal_name],
              ['Crew', c.crew_count], ['Passengers', c.passenger_count], ['Dangerous goods', c.dangerous_goods ? 'Yes' : 'No'],
              ['Port entry permit', c.entry_permit_no ? <span className="font-mono text-xs">{c.entry_permit_no}</span> : '—'], ['Departure clearance', c.departure_clearance_no ? <span className="font-mono text-xs">{c.departure_clearance_no}</span> : '—'], ['Call no.', <span className="font-mono text-xs">{c.call_no}</span>],
            ]} />
            {c.cargo_summary && <p className="mt-4 rounded-md bg-slate-50 p-3 text-sm text-slate-600">{c.cargo_summary}</p>}
          </Card>
          <Card title="Clearance status">
            {(['ARRIVAL', 'DEPARTURE'] as const).map((stage) => {
              const rows = c.approvals.filter((a: any) => a.stage === stage);
              if (!rows.length) return null;
              return (
                <div key={stage} className="mb-4">
                  <div className="mb-2 text-xs font-semibold uppercase text-slate-500">{label(stage)}</div>
                  {rows.map((a: any) => (
                    <div key={a.id} className="flex items-center justify-between py-1 text-sm"><span>{label(a.agency)}</span><Badge s={a.status} /></div>
                  ))}
                </div>
              );
            })}
            {!c.approvals.length && <p className="text-sm text-slate-500">Clearance starts when the pre-arrival notification is submitted.</p>}
            {c.invoices.length > 0 && (
              <div className="mt-2 border-t border-slate-100 pt-3">
                <div className="mb-2 text-xs font-semibold uppercase text-slate-500">Invoices</div>
                {c.invoices.map((i: any) => <Link key={i.id} to={`/finance/invoices/${i.id}`} className="flex justify-between py-1 text-sm hover:text-teal-600"><span className="font-mono text-xs">{i.invoice_no}</span><span>{fmtMoney(i.total, i.currency)} <Badge s={i.status} /></span></Link>)}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'fal' && <FalTab c={c} owner={!!owner} inv={inv} />}
      {tab === 'clearance' && (
        <Card pad={false}>
          <Table rows={c.approvals} empty="No clearance requests yet" cols={[
            { key: 'stage', header: 'Stage', render: (a: any) => label(a.stage) },
            { key: 'agency', header: 'Agency', render: (a: any) => label(a.agency) },
            { key: 'status', header: t('status'), render: (a: any) => <Badge s={a.status} /> },
            { key: 'remarks', header: 'Remarks' },
            { key: 'decided_by_name', header: 'Decided by' },
            { key: 'decided_at', header: 'Decided', render: (a: any) => fmtDateTime(a.decided_at) },
          ]} />
        </Card>
      )}
      {tab === 'cargo' && <CargoTab c={c} owner={!!owner} inv={inv} />}
      {tab === 'services' && <ServicesTab c={c} inv={inv} canRequest={!!owner} />}
      {tab === 'docs' && <Attachments entityType="vessel_call" entityId={id!} />}
      {tab === 'messages' && <Comments entityType="vessel_call" entityId={id!} />}
      {tab === 'history' && <History entityType="vessel_call" entityId={id!} />}

      <AllocateModal open={modal === 'allocate'} onClose={() => setModal(null)} c={c} inv={inv} />
      <TimeModal open={['arrived', 'berthed', 'departed'].includes(modal ?? '')} kind={modal!} onClose={() => setModal(null)} onSave={(at) => run.mutate(act(modal!, { at }), { onSuccess: () => setModal(null) })} />
      <ReasonModal open={modal === 'return'} title="Return berthing request to agent" onClose={() => setModal(null)} onSave={(reason) => run.mutate(act('reject-berth-request', { reason }), { onSuccess: () => setModal(null) })} />
      <ReasonModal open={modal === 'cancel'} title="Cancel vessel call" onClose={() => setModal(null)} onSave={(reason) => run.mutate(act('cancel', { reason }), { onSuccess: () => setModal(null) })} />
      <ReasonModal open={modal === 'query'} title="Answer agency query" label="Response" onClose={() => setModal(null)} onSave={(response) => run.mutate(act('respond-query', { response }), { onSuccess: () => setModal(null) })}>
        {queries.map((q: any) => <div key={q.id} className="mb-2 rounded-md bg-amber-50 p-3 text-sm"><b>{label(q.agency)}:</b> {q.remarks}</div>)}
      </ReasonModal>
    </div>
  );
}

function DecisionBar({ a, inv }: { a: any; inv: any[] }) {
  const [remarks, setRemarks] = useState('');
  const decide = useAction((status: string) => post(`/approvals/${a.id}/decision`, { status, remarks: remarks || undefined }), { invalidate: inv, success: 'Decision recorded' });
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
      <AlertTriangle className="h-5 w-5 text-amber-500" />
      <div className="text-sm"><b>{label(a.agency)}</b> — {label(a.stage)} clearance awaits your decision{a.status === 'QUERY' ? ' (query open)' : ''}.</div>
      <Input placeholder="Remarks (required to reject or query)" value={remarks} onChange={(e) => setRemarks(e.target.value)} className="min-w-64 flex-1" />
      <Button variant="success" onClick={() => decide.mutate('APPROVED')} loading={decide.isPending}>Approve</Button>
      <Button variant="secondary" onClick={() => decide.mutate('QUERY')} disabled={!remarks}>Query</Button>
      <Button variant="danger" onClick={() => decide.mutate('REJECTED')} disabled={!remarks}>Reject</Button>
    </div>
  );
}

function AllocateModal({ open, onClose, c, inv }: { open: boolean; onClose: () => void; c: any; inv: any[] }) {
  const berths = useQuery({ queryKey: ['berths'], queryFn: () => api<any[]>('/ref/berths'), enabled: open });
  const [b, setB] = useState<any>({});
  const [check, setCheck] = useState<any>(null);
  const berthId = b.berthId ?? c.requested_berth_id ?? '';
  const doCheck = async (id: string) => { setB({ ...b, berthId: id }); setCheck(id ? await post(`/vessel-calls/${c.id}/berth-check`, { berthId: id, eta: b.eta ? new Date(b.eta) : undefined, etd: b.etd ? new Date(b.etd) : undefined }) : null); };
  const save = useAction(() => post(`/vessel-calls/${c.id}/allocate-berth`, { berthId, eta: b.eta ? new Date(b.eta) : undefined, etd: b.etd ? new Date(b.etd) : undefined, override: !!b.override, remarks: b.remarks }), { invalidate: inv, success: 'Berth allocated', onDone: onClose });
  return (
    <Modal open={open} onClose={onClose} title={`Allocate berth — ${c.vessel_name}`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending} disabled={!berthId || (check && !check.ok && !b.override)}>Allocate</Button></>}>
      <div className="space-y-4">
        <p className="text-sm text-slate-500">LOA {c.loa} m · draft {c.arrival_draft ?? c.max_draft} m · requested {c.requested_berth_code ?? 'no preference'}</p>
        <Field label="Berth"><Select value={berthId} onChange={(e) => doCheck(e.target.value)} placeholder="Select…" options={(berths.data ?? []).filter((x) => !x.barge_berth).map((x) => ({ value: x.id, label: `${x.code} — ${x.terminal_name ?? ''} (${x.length_m} m, ${x.depth_m} m)` }))} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="ETA"><Input type="datetime-local" defaultValue={toLocalInput(c.eta)} onChange={(e) => setB({ ...b, eta: e.target.value })} /></Field>
          <Field label="ETD"><Input type="datetime-local" defaultValue={toLocalInput(c.etd)} onChange={(e) => setB({ ...b, etd: e.target.value })} /></Field>
        </div>
        {check && (check.ok
          ? <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-700">Berth fits: length, depth (≥0.5 m UKC) and window are clear.</div>
          : <div className="rounded-md bg-red-50 p-3 text-sm text-red-700"><ul className="list-disc pl-4">{check.problems.map((p: string) => <li key={p}>{p}</li>)}</ul>
              <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={!!b.override} onChange={(e) => setB({ ...b, override: e.target.checked })} />Override (recorded in audit trail)</label></div>)}
        <Field label="Remarks"><Input value={b.remarks ?? ''} onChange={(e) => setB({ ...b, remarks: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function TimeModal({ open, kind, onClose, onSave }: { open: boolean; kind: string; onClose: () => void; onSave: (at: Date) => void }) {
  const [v, setV] = useState(toLocalInput(new Date()));
  return (
    <Modal open={open} onClose={onClose} title={{ arrived: 'Record actual time of arrival', berthed: 'Record all fast (berthed)', departed: 'Record actual time of departure' }[kind] ?? ''} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button onClick={() => onSave(new Date(v))}>Save</Button></>}>
      <Field label="Time"><Input type="datetime-local" value={v} onChange={(e) => setV(e.target.value)} /></Field>
      {kind === 'departed' && <p className="mt-3 text-sm text-slate-500">Recording departure closes the call and issues the port dues invoice from the tariff book.</p>}
    </Modal>
  );
}

export function ReasonModal({ open, title, onClose, onSave, label: l = 'Reason', children }: { open: boolean; title: string; onClose: () => void; onSave: (r: string) => void; label?: string; children?: React.ReactNode }) {
  const [v, setV] = useState('');
  return (
    <Modal open={open} onClose={onClose} title={title} footer={<><Button variant="secondary" onClick={onClose}>Close</Button><Button onClick={() => onSave(v)} disabled={v.length < 3}>Submit</Button></>}>
      {children}
      <Field label={l}><Textarea rows={3} value={v} onChange={(e) => setV(e.target.value)} /></Field>
    </Modal>
  );
}

// ---------------- FAL forms ----------------
const FAL_COLS: Record<number, { key: string; cols: [string, string][] }> = {
  2: { key: 'items', cols: [['blNo', 'B/L no.'], ['description', 'Description'], ['packages', 'Packages'], ['grossKg', 'Gross kg']] },
  3: { key: 'stores', cols: [['article', 'Article'], ['quantity', 'Quantity'], ['location', 'Location on board']] },
  4: { key: 'effects', cols: [['crewName', 'Crew member'], ['description', 'Effects']] },
  5: { key: 'crew', cols: [['familyName', 'Family name'], ['givenNames', 'Given names'], ['rank', 'Rank'], ['nationality', 'Nationality'], ['idDocNo', 'ID document no.']] },
  6: { key: 'passengers', cols: [['familyName', 'Family name'], ['givenNames', 'Given names'], ['nationality', 'Nationality'], ['idDocNo', 'ID document no.'], ['embarkation', 'Port of embarkation']] },
  7: { key: 'items', cols: [['unNumber', 'UN no.'], ['properShippingName', 'Proper shipping name'], ['class', 'IMO class'], ['quantity', 'Quantity'], ['containerNo', 'Container']] },
};

function FalTab({ c, owner, inv }: { c: any; owner: boolean; inv: any[] }) {
  const [edit, setEdit] = useState<number | null>(null);
  const byNo = Object.fromEntries(c.fal.map((f: any) => [f.form_no, f]));
  const required: number[] = c.falRequired;
  return (
    <>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        {FAL_FORMS.map((f) => {
          const have = byNo[f.no];
          const req = required.includes(f.no) && !(f.no === 6 && !c.passenger_count) && !(f.no === 7 && !c.dangerous_goods);
          const rows = have ? (FAL_COLS[f.no] ? have.data[FAL_COLS[f.no].key]?.length : null) : null;
          return (
            <div key={f.no} className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="flex items-start justify-between">
                <div><div className="text-xs font-semibold text-teal-600">{f.code}</div><div className="text-sm font-medium">{f.name}</div></div>
                <FileText className="h-5 w-5 text-slate-300" />
              </div>
              <div className="mt-3 flex items-center justify-between">
                {have ? <Badge s="SUBMITTED">v{have.version}{rows != null ? ` · ${rows} rows` : ''}</Badge> : req ? <Badge s="PENDING">Required</Badge> : <Badge>{f.no === 4 ? 'Excluded (GDPR)' : 'Not required'}</Badge>}
                {(owner || have) && <Button size="sm" variant="secondary" onClick={() => setEdit(f.no)}>{owner && !['DEPARTED', 'CANCELLED'].includes(c.status) ? (have ? 'Edit' : 'Fill in') : 'View'}</Button>}
              </div>
            </div>
          );
        })}
      </div>
      {edit && <FalEditor no={edit} c={c} existing={byNo[edit]?.data} readOnly={!owner} onClose={() => setEdit(null)} inv={inv} />}
    </>
  );
}

function FalEditor({ no, c, existing, readOnly, onClose, inv }: { no: number; c: any; existing?: any; readOnly: boolean; onClose: () => void; inv: any[] }) {
  const spec = FAL_COLS[no];
  const [d, setD] = useState<any>(existing ?? (spec ? { [spec.key]: [{}] } : { portOfArrival: '', lastPortOfCall: c.last_port ?? '' }));
  const save = useAction(() => put(`/vessel-calls/${c.id}/fal/${no}`, spec ? { ...d, [spec.key]: d[spec.key].filter((r: any) => Object.values(r).some(Boolean)) } : d), { invalidate: inv, success: `FAL ${no} saved`, onDone: onClose });
  const rows: any[] = spec ? d[spec.key] ?? [] : [];
  const setRow = (i: number, k: string, v: string) => { const n = [...rows]; n[i] = { ...n[i], [k]: v }; setD({ ...d, [spec!.key]: n }); };
  const name = FAL_FORMS.find((f) => f.no === no)!.name;
  return (
    <Modal open onClose={onClose} wide title={`FAL ${no} — ${name}`} footer={<><Button variant="secondary" onClick={onClose}>Close</Button>{!readOnly && <Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button>}</>}>
      {!spec ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {[['masterName', 'Name of master'], ['portOfArrival', 'Port of arrival'], ['lastPortOfCall', 'Last port of call'], ['nextPortOfCall', 'Next port of call'], ['nationalityOfShip', 'Flag'], ['grossTonnage', 'Gross tonnage'], ['briefCargoDescription', 'Brief description of cargo'], ['shipRequirements', 'Ship’s requirements (waste, reception facilities)']].map(([k, l]) => (
            <Field key={k} label={l} className={k === 'briefCargoDescription' || k === 'shipRequirements' ? 'sm:col-span-2' : ''}><Input disabled={readOnly} value={d[k] ?? ''} onChange={(e) => setD({ ...d, [k]: e.target.value })} /></Field>
          ))}
        </div>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead><tr>{spec.cols.map(([, l]) => <th key={l} className="px-1 pb-2 text-left text-xs font-medium text-slate-500">{l}</th>)}</tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>{spec.cols.map(([k]) => <td key={k} className="p-1"><Input disabled={readOnly} value={r[k] ?? ''} onChange={(e) => setRow(i, k, e.target.value)} className="py-1" /></td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
          {!readOnly && <Button size="sm" variant="ghost" className="mt-2" onClick={() => setD({ ...d, [spec.key]: [...rows, {}] })}>+ Add row</Button>}
          {no === 5 && <p className="mt-3 text-xs text-slate-400">Personal data is visible only to the agent, immigration/border police and port health (GDPR / NDPA).</p>}
        </>
      )}
    </Modal>
  );
}

// ---------------- Cargo ----------------
function CargoTab({ c, owner, inv }: { c: any; owner: boolean; inv: any[] }) {
  const [open, setOpen] = useState(false);
  const [csv, setCsv] = useState('BL no,Consignee,Description,HS code,Packages,Gross kg,Container,ISO type,Seal\nEUXBL900001,Danubius Retail SRL (demo),Furniture,940360,120,15400,EUXU9000012,45G1,SL1001\n');
  const [direction, setDirection] = useState('IMPORT');
  const forwarders = useQuery({ queryKey: ['dir', 'FREIGHT_FORWARDER'], queryFn: () => api<any[]>('/directory/organisations?type=FREIGHT_FORWARDER'), enabled: open });
  const [fwd, setFwd] = useState('');
  const submit = useAction(() => {
    const lines = csv.trim().split('\n').slice(1).map((l) => l.split(',').map((x) => x.trim()));
    const bls = new Map<string, any>();
    for (const [blNo, consignee, description, hsCode, packages, grossKg, containerNo, isoType, sealNo] of lines) {
      if (!blNo) continue;
      if (!bls.has(blNo)) bls.set(blNo, { blNo, consignee, description, hsCode: hsCode || undefined, packages: Number(packages) || undefined, grossKg: Number(grossKg) || undefined, forwarderOrgId: fwd || undefined, pod: direction === 'IMPORT' ? undefined : undefined, containers: [] });
      if (containerNo) bls.get(blNo).containers.push({ containerNo, isoType, sealNo });
    }
    return post(`/vessel-calls/${c.id}/manifests`, { direction, bls: [...bls.values()] });
  }, { invalidate: inv, success: 'Manifest submitted', onDone: () => setOpen(false) });
  const bls = useQuery({ queryKey: ['bls', c.id], queryFn: () => api<any[]>(`/bls?callId=${c.id}`) });
  return (
    <div className="space-y-4">
      <Card title="Manifests" actions={owner && !['DRAFT', 'CANCELLED', 'DEPARTED'].includes(c.status) && <Button size="sm" onClick={() => setOpen(true)}><Upload className="h-3.5 w-3.5" />Submit / amend manifest</Button>} pad={false}>
        <Table rows={c.manifests} empty="No manifest yet — submit via portal, API or EDI CUSCAR" cols={[
          { key: 'direction', header: 'Direction', render: (m: any) => label(m.direction) },
          { key: 'version', header: 'Version' }, { key: 'source', header: 'Channel' },
          { key: 'bl_count', header: 'B/Ls' }, { key: 'container_count', header: 'Containers' },
          { key: 'status', header: 'Status', render: (m: any) => <Badge s={m.status} /> },
          { key: 'created_at', header: 'Received', render: (m: any) => fmtDateTime(m.created_at) },
          { key: 'x', header: '', render: (m: any) => <Button size="sm" variant="ghost" onClick={() => download(`/edi/outbound/cuscar/${m.id}`, `CUSCAR_${c.call_no}_${m.direction}.edi`)}><Download className="h-3.5 w-3.5" />CUSCAR</Button> },
        ]} />
      </Card>
      <Card title="Bills of lading" pad={false}>
        <Table rows={bls.data} cols={[
          { key: 'bl_no', header: 'B/L', render: (b: any) => <span className="font-mono text-xs">{b.bl_no}</span> },
          { key: 'consignee', header: 'Consignee' }, { key: 'description', header: 'Goods' },
          { key: 'container_count', header: 'Cntrs' }, { key: 'forwarder_name', header: 'Forwarder' },
          { key: 'customs_status', header: 'Customs', render: (b: any) => <Badge s={b.customs_status} /> },
          { key: 'do_status', header: 'eDO', render: (b: any) => b.do_status ? <Badge s={b.do_status} /> : '—' },
        ]} />
      </Card>
      <Modal open={open} onClose={() => setOpen(false)} wide title="Submit manifest" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => submit.mutate()} loading={submit.isPending}>Submit to PCS & customs</Button></>}>
        <div className="mb-3 grid gap-3 sm:grid-cols-2">
          <Field label="Direction"><Select value={direction} onChange={(e) => setDirection(e.target.value)} options={[{ value: 'IMPORT', label: 'Import (discharge)' }, { value: 'EXPORT', label: 'Export (load)' }]} /></Field>
          <Field label="Nominated forwarder (all B/Ls)"><Select value={fwd} onChange={(e) => setFwd(e.target.value)} placeholder="—" options={(forwarders.data ?? []).map((o) => ({ value: o.id, label: o.name }))} /></Field>
        </div>
        <Field label="Lines (CSV — one row per container; repeat the B/L for multiple containers)" hint="Container numbers are validated against ISO 6346; HS codes 4–10 digits. Large manifests normally arrive as EDI CUSCAR or via the REST API."><Textarea rows={10} className="font-mono text-xs" value={csv} onChange={(e) => setCsv(e.target.value)} /></Field>
      </Modal>
    </div>
  );
}

// ---------------- Services ----------------
function ServicesTab({ c, inv, canRequest }: { c: any; inv: any[]; canRequest: boolean }) {
  const [open, setOpen] = useState(false);
  const offers = useQuery({ queryKey: ['offerings'], queryFn: () => api<any[]>('/service-offerings'), enabled: open });
  const [f, setF] = useState<any>({ quantity: 1, requestedFor: toLocalInput(c.eta) });
  const req = useAction(() => post('/service-requests', { offeringId: f.offeringId, callId: c.id, quantity: Number(f.quantity), requestedFor: new Date(f.requestedFor), notes: f.notes }), { invalidate: inv, success: 'Service requested', onDone: () => setOpen(false) });
  return (
    <Card title="Marine services" actions={canRequest && !['DEPARTED', 'CANCELLED'].includes(c.status) && <Button size="sm" onClick={() => setOpen(true)}>Request service</Button>} pad={false}>
      <Table rows={c.services} empty="No services requested" cols={[
        { key: 'request_no', header: 'Request', render: (s: any) => <span className="font-mono text-xs">{s.request_no}</span> },
        { key: 'service_type', header: 'Service', render: (s: any) => label(s.service_type) }, { key: 'provider_name', header: 'Provider' },
        { key: 'quantity', header: 'Qty' }, { key: 'requested_for', header: 'Requested for', render: (s: any) => fmtDateTime(s.requested_for) },
        { key: 'status', header: 'Status', render: (s: any) => <Badge s={s.status} /> },
      ]} />
      <Modal open={open} onClose={() => setOpen(false)} title="Request marine service" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => req.mutate()} loading={req.isPending} disabled={!f.offeringId}>Request</Button></>}>
        <div className="space-y-3">
          <Field label="Service & provider"><Select value={f.offeringId ?? ''} onChange={(e) => setF({ ...f, offeringId: e.target.value })} placeholder="Select…" options={(offers.data ?? []).map((o) => ({ value: o.id, label: `${label(o.service_type)} — ${o.provider_name} (${fmtMoney(o.unit_price, o.currency)} / ${o.unit.toLowerCase()})` }))} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Quantity"><Input type="number" min="0.1" step="0.1" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} /></Field>
            <Field label="Required at"><Input type="datetime-local" value={f.requestedFor} onChange={(e) => setF({ ...f, requestedFor: e.target.value })} /></Field>
          </div>
          <Field label="Notes"><Textarea rows={2} value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </div>
      </Modal>
    </Card>
  );
}

// ---------------- Shared document panels ----------------
export function Attachments({ entityType, entityId }: { entityType: string; entityId: string }) {
  const q = useQuery({ queryKey: ['attachments', entityId], queryFn: () => api<any[]>(`/attachments?entityType=${entityType}&entityId=${entityId}`) });
  const [docType, setDocType] = useState('SHIP_CERTIFICATE');
  const up = useAction(async (file: File) => {
    const fd = new FormData();
    fd.append('entityType', entityType); fd.append('entityId', entityId); fd.append('docType', docType); fd.append('file', file);
    return api('/attachments', { method: 'POST', form: fd });
  }, { invalidate: [['attachments', entityId]], success: 'Document uploaded' });
  return (
    <Card title="Documents" actions={<div className="flex items-center gap-2">
      <Select value={docType} onChange={(e) => setDocType(e.target.value)} className="py-1 text-xs" options={['SHIP_CERTIFICATE', 'ISPS_DECLARATION', 'MARITIME_HEALTH_DECLARATION', 'WASTE_NOTIFICATION', 'CARGO_DOCUMENT', 'INSPECTION_REPORT', 'OTHER'].map((x) => ({ value: x, label: label(x) }))} />
      <label className="cursor-pointer"><span className="inline-flex items-center gap-1.5 rounded-md bg-navy-900 px-2.5 py-1 text-xs font-medium text-white"><Upload className="h-3.5 w-3.5" />Upload</span><input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && up.mutate(e.target.files[0])} /></label>
    </div>} pad={false}>
      <Table rows={q.data} empty="No documents" cols={[
        { key: 'filename', header: 'File', render: (a: any) => <button className="text-teal-700 hover:underline" onClick={() => download(`/attachments/${a.id}/download`, a.filename)}>{a.filename}</button> },
        { key: 'doc_type', header: 'Type', render: (a: any) => label(a.doc_type) },
        { key: 'size', header: 'Size', render: (a: any) => `${Math.ceil(a.size / 1024)} KB` },
        { key: 'sha256', header: 'SHA-256', render: (a: any) => <span className="font-mono text-[11px] text-slate-400">{a.sha256.slice(0, 16)}…</span> },
        { key: 'uploaded_by_name', header: 'By' }, { key: 'created_at', header: 'Uploaded', render: (a: any) => fmtDateTime(a.created_at) },
      ]} />
    </Card>
  );
}

export function Comments({ entityType, entityId }: { entityType: string; entityId: string }) {
  const q = useQuery({ queryKey: ['comments', entityId], queryFn: () => api<any[]>(`/comments?entityType=${entityType}&entityId=${entityId}`), refetchInterval: 15_000 });
  const [v, setV] = useState('');
  const send = useAction(() => post('/comments', { entityType, entityId, body: v }), { invalidate: [['comments', entityId]], onDone: () => setV('') });
  return (
    <Card title="Stakeholder messages">
      <div className="mb-4 space-y-3">
        {(q.data ?? []).map((m) => (
          <div key={m.id} className="rounded-lg bg-slate-50 p-3"><div className="text-xs text-slate-500"><b className="text-slate-700">{m.author}</b> · {fmtDateTime(m.created_at)}</div><div className="mt-1 text-sm">{m.body}</div></div>
        ))}
        {!q.data?.length && <p className="text-sm text-slate-400">No messages yet. Messages are visible to every party on this document.</p>}
      </div>
      <div className="flex gap-2"><Input value={v} onChange={(e) => setV(e.target.value)} placeholder="Write a message…" onKeyDown={(e) => e.key === 'Enter' && v && send.mutate()} /><Button onClick={() => send.mutate()} disabled={!v}>Send</Button></div>
    </Card>
  );
}

export function History({ entityType, entityId }: { entityType: string; entityId: string }) {
  const q = useQuery({ queryKey: ['history', entityId], queryFn: () => api<any[]>(`/history?entityType=${entityType}&entityId=${entityId}`) });
  return (
    <Card title="Audit trail">
      <Timeline items={(q.data ?? []).map((h) => ({
        title: label(h.action), at: h.at, who: h.actor,
        tone: /REJECT|CANCEL|HELD/.test(h.action) ? 'bad' : /QUERY|REQUEST/.test(h.action) ? 'warn' : /APPROVED|CLEARED|RELEASED|PAID/.test(h.action) ? 'ok' : 'info',
        body: h.data?.note || h.data?.remarks || h.data?.reason || (h.data?.agency ? `${label(h.data.agency)} · ${label(h.data.stage)}` : undefined),
      }))} />
    </Card>
  );
}

void AGENCIES;
