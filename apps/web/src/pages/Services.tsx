import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { SERVICE_TYPES } from '@pcs/shared';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { fmtDateTime, fmtMoney, label } from '../lib/format';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Table, Tabs, useAction } from '../components/ui';

const NEXT: Record<string, [string, string][]> = { REQUESTED: [['accept', 'Accept'], ['reject', 'Reject']], ACCEPTED: [['schedule', 'Schedule'], ['complete', 'Complete']], SCHEDULED: [['complete', 'Complete']] };

export default function Services() {
  const t = useT();
  const { me, has } = useAuth();
  const [tab, setTab] = useState('requests');
  const [open, setOpen] = useState(false);
  const reqs = useQuery({ queryKey: ['service-requests'], queryFn: () => api<any[]>('/service-requests') });
  const offers = useQuery({ queryKey: ['offerings'], queryFn: () => api<any[]>('/service-offerings') });
  const act = useAction((a: { id: string; action: string }) => post(`/service-requests/${a.id}/${a.action}`), { invalidate: [['service-requests'], ['vessel-call']], success: 'Service updated' });
  const [f, setF] = useState<any>({ serviceType: 'PILOTAGE', unit: 'JOB', currency: me?.tenant.currency });
  const addOffer = useAction(() => post('/service-offerings', { serviceType: f.serviceType, description: f.description, unit: f.unit, unitPrice: Number(f.unitPrice), currency: f.currency ?? me?.tenant.currency }), { invalidate: [['offerings']], success: 'Offering published', onDone: () => setOpen(false) });

  return (
    <div>
      <PageHeader title={t('services')} subtitle="Marketplace for pilotage, towage, mooring, bunkering, water and waste — requests, scheduling and billing" actions={has('SERVICE_PROVIDER') && <Button onClick={() => setOpen(true)}>Publish offering</Button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'requests', label: 'Requests', count: reqs.data?.length }, { id: 'catalogue', label: 'Catalogue', count: offers.data?.length }]} />
      {tab === 'requests' ? (
        <Card pad={false}>
          <Table rows={reqs.data} loading={reqs.isLoading} cols={[
            { key: 'request_no', header: 'Request', render: (r) => <span className="font-mono text-xs">{r.request_no}</span> },
            { key: 'service_type', header: 'Service', render: (r) => label(r.service_type) },
            { key: 'vessel_name', header: 'Vessel', render: (r) => r.call_id ? <Link className="text-teal-700 hover:underline" to={`/vessel-calls/${r.call_id}`}>{r.vessel_name}</Link> : '—' },
            { key: 'requester_name', header: 'Requested by' }, { key: 'provider_name', header: 'Provider' }, { key: 'quantity', header: 'Qty' },
            { key: 'requested_for', header: 'For', render: (r) => fmtDateTime(r.requested_for) },
            { key: 'status', header: t('status'), render: (r) => <Badge s={r.status} /> },
            { key: 'x', header: '', render: (r) => (
              <div className="flex gap-1">
                {r.provider_org_id === me?.user.orgId && (NEXT[r.status] ?? []).map(([a, l]) => <Button key={a} size="sm" variant={a === 'reject' ? 'ghost' : 'secondary'} onClick={() => act.mutate({ id: r.id, action: a })}>{l}</Button>)}
                {r.requester_org_id === me?.user.orgId && ['REQUESTED', 'ACCEPTED', 'SCHEDULED'].includes(r.status) && <Button size="sm" variant="ghost" onClick={() => act.mutate({ id: r.id, action: 'cancel' })}>Cancel</Button>}
              </div>) },
          ]} />
        </Card>
      ) : (
        <Card pad={false}>
          <Table rows={offers.data} cols={[
            { key: 'service_type', header: 'Service', render: (r) => label(r.service_type) }, { key: 'provider_name', header: 'Provider' },
            { key: 'description', header: 'Description' }, { key: 'unit', header: 'Unit', render: (r) => label(r.unit) },
            { key: 'unit_price', header: 'Price', className: 'num text-right', render: (r) => fmtMoney(r.unit_price, r.currency) },
          ]} />
        </Card>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Publish service offering" footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button onClick={() => addOffer.mutate()} loading={addOffer.isPending}>Publish</Button></>}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Service"><Select value={f.serviceType} onChange={(e) => setF({ ...f, serviceType: e.target.value })} options={SERVICE_TYPES.map((s) => ({ value: s, label: label(s) }))} /></Field>
          <Field label="Unit"><Select value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })} options={['JOB', 'HOUR', 'TUG_HOUR', 'TONNE', 'M3'].map((s) => ({ value: s, label: label(s) }))} /></Field>
          <Field label="Unit price"><Input type="number" value={f.unitPrice ?? ''} onChange={(e) => setF({ ...f, unitPrice: e.target.value })} /></Field>
          <Field label="Currency"><Input value={f.currency ?? ''} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></Field>
          <Field label="Description" className="sm:col-span-2"><Input value={f.description ?? ''} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        </div>
      </Modal>
    </div>
  );
}
