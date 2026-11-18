import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { ROLES, ORG_TYPES, AGENCIES } from '@pcs/shared';
import { api, post, patch, del } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { fmtDateTime, label } from '../lib/format';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Table, Tabs, useAction } from '../components/ui';

export default function Admin() {
  const t = useT();
  const { has } = useAuth();
  const { tab = has('PORT_ADMIN') ? 'organisations' : 'users' } = useParams();
  const nav = useNavigate();
  const tabs = [
    ...(has('PORT_ADMIN') ? [{ id: 'organisations', label: 'Organisations' }] : []),
    { id: 'users', label: 'Users' }, { id: 'integration', label: 'API keys & webhooks' },
    ...(has('PORT_ADMIN', 'HARBOUR_MASTER') ? [{ id: 'reference', label: 'Berths & terminals' }] : []),
    ...(has('PORT_ADMIN') ? [{ id: 'settings', label: 'Port settings' }] : []),
    ...(has('PORT_ADMIN', 'EXECUTIVE') ? [{ id: 'audit', label: 'Audit log' }] : []),
  ];
  return (
    <div>
      <PageHeader title={t('admin')} />
      <Tabs value={tab} onChange={(x) => nav(`/admin/${x}`)} tabs={tabs} />
      {tab === 'organisations' && <Orgs />}
      {tab === 'users' && <Users />}
      {tab === 'integration' && <Integration />}
      {tab === 'reference' && <Reference />}
      {tab === 'settings' && <Settings />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

function Orgs() {
  const [status, setStatus] = useState('');
  const q = useQuery({ queryKey: ['orgs', status], queryFn: () => api<any[]>(`/organisations${status ? `?status=${status}` : ''}`) });
  const [sel, setSel] = useState<any>(null);
  const [reason, setReason] = useState('');
  const setS = useAction((s: string) => post(`/organisations/${sel.id}/status`, { status: s, reason: reason || undefined }), { invalidate: [['orgs']], success: 'Organisation updated', onDone: () => setSel(null) });
  const [add, setAdd] = useState<any>(null);
  const create = useAction(() => post('/organisations', add), { invalidate: [['orgs']], success: 'Organisation created', onDone: () => setAdd(null) });
  return (
    <Card pad={false} title={<Select value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All statuses" className="w-44" options={['PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED'].map((s) => ({ value: s, label: label(s) }))} />} actions={<Button size="sm" onClick={() => setAdd({ type: 'GOVERNMENT_AGENCY' })}>Add organisation</Button>}>
      <Table rows={q.data} loading={q.isLoading} onRow={setSel} cols={[
        { key: 'name', header: 'Name', render: (o) => <><div className="font-medium">{o.name}</div><div className="text-xs text-slate-500">{o.email}</div></> },
        { key: 'type', header: 'Type', render: (o) => label(o.type) }, { key: 'registration_no', header: 'Registry no.' }, { key: 'tax_id', header: 'Tax ID' },
        { key: 'user_count', header: 'Users' }, { key: 'created_at', header: 'Registered', render: (o) => fmtDateTime(o.created_at) },
        { key: 'status', header: 'Status', render: (o) => <Badge s={o.status} /> },
      ]} />
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel?.name} footer={<>
        {sel?.status !== 'ACTIVE' && <Button variant="success" onClick={() => setS.mutate('ACTIVE')}>Approve / activate</Button>}
        {sel?.status === 'PENDING' && <Button variant="danger" onClick={() => setS.mutate('REJECTED')} disabled={!reason}>Reject</Button>}
        {sel?.status === 'ACTIVE' && <Button variant="danger" onClick={() => setS.mutate('SUSPENDED')} disabled={!reason}>Suspend</Button>}
      </>}>
        {sel && <div className="space-y-2 text-sm">
          <div>{label(sel.type)} · {sel.registration_no} · {sel.tax_id ?? 'no tax ID'}</div><div>{sel.address}</div><div>{sel.phone}</div>
          <Field label="Reason (required to reject or suspend)"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        </div>}
      </Modal>
      <Modal open={!!add} onClose={() => setAdd(null)} title="Add organisation" footer={<Button onClick={() => create.mutate()} loading={create.isPending}>Create</Button>}>
        {add && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" className="sm:col-span-2"><Input value={add.name ?? ''} onChange={(e) => setAdd({ ...add, name: e.target.value })} /></Field>
          <Field label="Type"><Select value={add.type} onChange={(e) => setAdd({ ...add, type: e.target.value })} options={ORG_TYPES.map((x) => ({ value: x, label: label(x) }))} /></Field>
          <Field label="Email"><Input value={add.email ?? ''} onChange={(e) => setAdd({ ...add, email: e.target.value })} /></Field>
          <Field label="Registry no."><Input value={add.registrationNo ?? ''} onChange={(e) => setAdd({ ...add, registrationNo: e.target.value })} /></Field>
        </div>}
      </Modal>
    </Card>
  );
}

function Users() {
  const { has } = useAuth();
  const q = useQuery({ queryKey: ['users'], queryFn: () => api<any[]>('/users') });
  const orgs = useQuery({ queryKey: ['dir', 'all'], queryFn: () => api<any[]>('/directory/organisations') });
  const [f, setF] = useState<any>(null);
  const create = useAction(() => post('/users', { ...f, roles: [f.role], orgId: f.orgId || undefined }), { invalidate: [['users']], success: 'User created', onDone: () => setF(null) });
  const toggle = useAction((u: any) => patch(`/users/${u.id}`, { active: !u.active }), { invalidate: [['users']], success: 'User updated' });
  return (
    <Card pad={false} actions={<Button size="sm" onClick={() => setF({ role: 'SHIPPING_AGENT', lang: 'en' })}>Add user</Button>}>
      <Table rows={q.data} loading={q.isLoading} cols={[
        { key: 'name', header: 'Name', render: (u) => <><div className="font-medium">{u.name}</div><div className="text-xs text-slate-500">{u.email}</div></> },
        { key: 'org_name', header: 'Organisation' }, { key: 'roles', header: 'Roles', render: (u) => u.roles.map(label).join(', ') },
        { key: 'last_login_at', header: 'Last sign-in', render: (u) => fmtDateTime(u.last_login_at) },
        { key: 'active', header: 'Status', render: (u) => <Badge s={u.active ? 'ACTIVE' : 'SUSPENDED'} /> },
        { key: 'x', header: '', render: (u) => has('PORT_ADMIN') && <Button size="sm" variant="ghost" onClick={() => toggle.mutate(u)}>{u.active ? 'Deactivate' : 'Activate'}</Button> },
      ]} />
      <Modal open={!!f} onClose={() => setF(null)} title="Add user" footer={<Button onClick={() => create.mutate()} loading={create.isPending}>Create</Button>}>
        {f && <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Email"><Input value={f.email ?? ''} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Initial password"><Input type="password" value={f.password ?? ''} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          <Field label="Role"><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} options={ROLES.filter((r) => r !== 'SYS_ADMIN').map((r) => ({ value: r, label: label(r) }))} /></Field>
          {has('PORT_ADMIN') && <Field label="Organisation" className="sm:col-span-2"><Select value={f.orgId ?? ''} onChange={(e) => setF({ ...f, orgId: e.target.value })} placeholder="My organisation" options={(orgs.data ?? []).map((o) => ({ value: o.id, label: o.name }))} /></Field>}
        </div>}
      </Modal>
    </Card>
  );
}

function Integration() {
  const keys = useQuery({ queryKey: ['api-keys'], queryFn: () => api<any[]>('/api-keys') });
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api<any[]>('/webhooks') });
  const [secret, setSecret] = useState<any>(null);
  const [name, setName] = useState('');
  const [hook, setHook] = useState({ url: '', events: 'vessel_call.arrival_cleared,bl.customs_status,gate.out' });
  const mkKey = useAction(() => post('/api-keys', { name }), { invalidate: [['api-keys']], onDone: setSecret });
  const rmKey = useAction((id: string) => del(`/api-keys/${id}`), { invalidate: [['api-keys']], success: 'Key revoked' });
  const mkHook = useAction(() => post('/webhooks', { url: hook.url, events: hook.events.split(',').map((s) => s.trim()) }), { invalidate: [['webhooks']], onDone: setSecret });
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="API keys (system-to-system)" pad={false}>
        <div className="flex gap-2 border-b border-slate-100 p-3"><Input placeholder="Key name, e.g. TOS integration" value={name} onChange={(e) => setName(e.target.value)} /><Button onClick={() => mkKey.mutate()} disabled={name.length < 2}>Create</Button></div>
        <Table rows={keys.data} cols={[
          { key: 'name', header: 'Name' }, { key: 'prefix', header: 'Prefix', render: (k) => <span className="font-mono text-xs">{k.prefix}…</span> },
          { key: 'last_used_at', header: 'Last used', render: (k) => fmtDateTime(k.last_used_at) }, { key: 'active', header: '', render: (k) => k.active ? <Button size="sm" variant="ghost" onClick={() => rmKey.mutate(k.id)}>Revoke</Button> : <Badge s="REVOKED" /> },
        ]} />
        <p className="p-3 text-xs text-slate-500">Send <code className="rounded bg-slate-100 px-1">x-api-key</code> on any endpoint in the <a href="/api/docs" target="_blank" className="text-teal-600 underline">OpenAPI reference</a>, or post EDIFACT to <code className="rounded bg-slate-100 px-1">/api/edi/inbound</code>.</p>
      </Card>
      <Card title="Webhooks (event push)" pad={false}>
        <div className="space-y-2 border-b border-slate-100 p-3">
          <Input placeholder="https://your-system/pcs-events" value={hook.url} onChange={(e) => setHook({ ...hook, url: e.target.value })} />
          <div className="flex gap-2"><Input value={hook.events} onChange={(e) => setHook({ ...hook, events: e.target.value })} className="font-mono text-xs" /><Button onClick={() => mkHook.mutate()} disabled={!hook.url}>Subscribe</Button></div>
        </div>
        <Table rows={hooks.data} cols={[{ key: 'url', header: 'URL' }, { key: 'events', header: 'Events', render: (h) => <span className="font-mono text-[11px]">{h.events.join(', ')}</span> }, { key: 'active', header: '', render: (h) => <Badge s={h.active ? 'ACTIVE' : 'CANCELLED'} /> }]} />
      </Card>
      <Modal open={!!secret} onClose={() => setSecret(null)} title="Copy this secret now">
        <p className="mb-2 text-sm text-slate-600">{secret?.note}</p>
        <pre className="overflow-x-auto rounded bg-navy-950 p-3 font-mono text-sm text-teal-300">{secret?.key ?? secret?.secret}</pre>
      </Modal>
    </div>
  );
}

function Reference() {
  const berths = useQuery({ queryKey: ['berths'], queryFn: () => api<any[]>('/ref/berths') });
  const terms = useQuery({ queryKey: ['terminals'], queryFn: () => api<any[]>('/ref/terminals') });
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card title="Terminals" pad={false}><Table rows={terms.data} cols={[{ key: 'code', header: 'Code' }, { key: 'name', header: 'Name' }, { key: 'type', header: 'Type', render: (x) => label(x.type) }, { key: 'operator_name', header: 'Operator' }]} /></Card>
      <Card title="Berths" pad={false}><Table rows={berths.data} cols={[{ key: 'code', header: 'Code' }, { key: 'name', header: 'Name' }, { key: 'terminal_code', header: 'Terminal' }, { key: 'length_m', header: 'Length m', className: 'text-right' }, { key: 'depth_m', header: 'Depth m', className: 'text-right' }, { key: 'barge_berth', header: 'Barge', render: (b) => b.barge_berth ? 'Yes' : '' }]} /></Card>
    </div>
  );
}

function Settings() {
  const q = useQuery({ queryKey: ['port'], queryFn: () => api('/port') });
  const s: any = q.data?.settings;
  const [draft, setDraft] = useState<any>(null);
  const v = draft ?? s;
  const save = useAction(() => patch('/port/settings', draft), { invalidate: [['port'], ['me']], success: 'Settings saved', onDone: () => setDraft(null) });
  if (!v) return null;
  const toggle = (k: string, a: string) => setDraft({ ...v, [k]: v[k].includes(a) ? v[k].filter((x: string) => x !== a) : [...v[k], a] });
  return (
    <Card title={`${q.data.name} (${q.data.code})`} actions={draft && <Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button>}>
      <div className="grid gap-6 md:grid-cols-2">
        <div><div className="mb-2 text-sm font-medium">Arrival clearance agencies</div>{AGENCIES.map((a) => <label key={a} className="flex items-center gap-2 py-0.5 text-sm"><input type="checkbox" checked={v.clearanceAgencies.includes(a)} onChange={() => toggle('clearanceAgencies', a)} />{label(a)}</label>)}</div>
        <div><div className="mb-2 text-sm font-medium">Departure clearance agencies</div>{AGENCIES.map((a) => <label key={a} className="flex items-center gap-2 py-0.5 text-sm"><input type="checkbox" checked={(v.departureAgencies ?? v.clearanceAgencies).includes(a)} onChange={() => toggle('departureAgencies', a)} />{label(a)}</label>)}</div>
        <div><div className="mb-2 text-sm font-medium">Required FAL forms</div>{[1, 2, 3, 4, 5, 6, 7].map((n) => <label key={n} className="flex items-center gap-2 py-0.5 text-sm"><input type="checkbox" checked={v.falFormsRequired.includes(n)} onChange={() => setDraft({ ...v, falFormsRequired: v.falFormsRequired.includes(n) ? v.falFormsRequired.filter((x: number) => x !== n) : [...v.falFormsRequired, n].sort() })} />FAL {n}</label>)}</div>
        <div className="space-y-3">
          <Field label="VAT rate"><Input type="number" step="0.001" value={v.vatRate} onChange={(e) => setDraft({ ...v, vatRate: Number(e.target.value) })} /></Field>
          <Field label="Truck slot length (min)"><Input type="number" value={v.truckSlotMinutes} onChange={(e) => setDraft({ ...v, truckSlotMinutes: Number(e.target.value) })} /></Field>
          <Field label="Trucks per slot per terminal"><Input type="number" value={v.truckSlotCapacity} onChange={(e) => setDraft({ ...v, truckSlotCapacity: Number(e.target.value) })} /></Field>
          <Field label="Customs system adapter"><Select value={v.customsSystem} onChange={(e) => setDraft({ ...v, customsSystem: e.target.value })} options={[{ value: 'MOCK', label: 'Mock (demo)' }, { value: 'NICIS_II', label: 'NICIS II (Nigeria)' }, { value: 'RO_CUSTOMS', label: 'Romanian Customs (BVBS)' }]} /></Field>
          <Field label="Portal languages"><Input value={v.languages.join(',')} onChange={(e) => setDraft({ ...v, languages: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /></Field>
        </div>
      </div>
    </Card>
  );
}

function Audit() {
  const q = useQuery({ queryKey: ['audit'], queryFn: () => api<any[]>('/audit') });
  return (
    <Card pad={false}>
      <Table rows={q.data} loading={q.isLoading} cols={[
        { key: 'at', header: 'Time', render: (a) => fmtDateTime(a.at) }, { key: 'user_name', header: 'User', render: (a) => a.user_name ?? 'system / API' },
        { key: 'action', header: 'Action', render: (a) => <span className="font-mono text-xs">{a.action}</span> }, { key: 'entity_type', header: 'Entity', render: (a) => label(a.entity_type) },
        { key: 'data', header: 'Details', render: (a) => <span className="line-clamp-2 max-w-md font-mono text-[11px] text-slate-500">{a.data ? JSON.stringify(a.data) : ''}</span> },
      ]} />
    </Card>
  );
}
