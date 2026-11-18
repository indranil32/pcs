import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { fmtDateTime } from '../lib/format';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Table, Tabs, useAction } from '../components/ui';
import { ReasonModal } from './VesselCallDetail';

export default function DeliveryOrders() {
  const t = useT();
  const { me } = useAuth();
  const [status, setStatus] = useState('');
  const [issue, setIssue] = useState<any>(null);
  const [rej, setRej] = useState<{ d: any; action: string } | null>(null);
  const q = useQuery({ queryKey: ['delivery-orders', status], queryFn: () => api<any[]>(`/delivery-orders${status ? `?status=${status}` : ''}`) });
  const hauliers = useQuery({ queryKey: ['dir', 'HAULIER'], queryFn: () => api<any[]>('/directory/organisations?type=HAULIER') });
  const [f, setF] = useState<any>({ validUntil: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10) });
  const doIssue = useAction(() => post(`/delivery-orders/${issue.id}/issue`, { validUntil: f.validUntil, haulierOrgId: f.haulier || undefined, remarks: f.remarks }), { invalidate: [['delivery-orders']], success: 'Delivery order issued', onDone: () => setIssue(null) });
  const doReject = useAction((reason: string) => post(`/delivery-orders/${rej!.d.id}/${rej!.action}`, { reason }), { invalidate: [['delivery-orders']], success: 'Updated', onDone: () => setRej(null) });

  return (
    <div>
      <PageHeader title={t('deliveryOrders')} subtitle="Electronic delivery orders — requested by forwarders, issued by the shipping line, checked at the gate" />
      <Tabs value={status} onChange={setStatus} tabs={[{ id: '', label: t('all') }, { id: 'REQUESTED', label: 'Requested' }, { id: 'ISSUED', label: 'Issued' }, { id: 'USED', label: 'Used' }, { id: 'REJECTED', label: 'Rejected' }]} />
      <Card pad={false}>
        <Table rows={q.data} loading={q.isLoading} cols={[
          { key: 'do_no', header: 'eDO', render: (d) => <span className="font-mono text-xs">{d.do_no}</span> },
          { key: 'bl_no', header: 'B/L', render: (d) => <span className="font-mono text-xs">{d.bl_no}</span> },
          { key: 'consignee', header: 'Consignee' },
          { key: 'containers', header: 'Containers', render: (d) => <span className="font-mono text-[11px]">{(d.containers ?? []).join(', ')}</span> },
          { key: 'requester_name', header: 'Requested by' }, { key: 'issuer_name', header: 'Issuer' }, { key: 'haulier_name', header: 'Haulier' },
          { key: 'customs_status', header: 'Customs', render: (d) => <Badge s={d.customs_status} /> },
          { key: 'pin', header: 'PIN', render: (d) => d.pin && (me?.user.orgId === d.requester_org_id || me?.user.orgId === d.issuer_org_id) ? <span className="font-mono">{d.pin}</span> : '—' },
          { key: 'status', header: t('status'), render: (d) => <><Badge s={d.status} />{d.issued_at && <div className="text-[11px] text-slate-500">{fmtDateTime(d.issued_at)}</div>}</> },
          { key: 'act', header: '', render: (d) => me?.user.orgId === d.issuer_org_id && (
            <div className="flex gap-1">
              {d.status === 'REQUESTED' && <><Button size="sm" onClick={() => { setIssue(d); setF({ ...f, haulier: d.haulier_org_id ?? '' }); }}>Issue</Button><Button size="sm" variant="secondary" onClick={() => setRej({ d, action: 'reject' })}>Reject</Button></>}
              {d.status === 'ISSUED' && <Button size="sm" variant="secondary" onClick={() => setRej({ d, action: 'revoke' })}>Revoke</Button>}
            </div>) },
        ]} />
      </Card>
      <Modal open={!!issue} onClose={() => setIssue(null)} title={`Issue ${issue?.do_no}`} footer={<><Button variant="secondary" onClick={() => setIssue(null)}>Cancel</Button><Button onClick={() => doIssue.mutate()} loading={doIssue.isPending}>Issue eDO</Button></>}>
        <div className="space-y-3">
          <p className="text-sm text-slate-500">Confirm freight and charges are settled for B/L {issue?.bl_no}. The forwarder and nominated haulier are notified with the release PIN.</p>
          <Field label="Valid until"><Input type="date" value={f.validUntil} onChange={(e) => setF({ ...f, validUntil: e.target.value })} /></Field>
          <Field label="Haulier"><Select value={f.haulier ?? ''} onChange={(e) => setF({ ...f, haulier: e.target.value })} placeholder="Any haulier" options={(hauliers.data ?? []).map((o) => ({ value: o.id, label: o.name }))} /></Field>
          <Field label="Remarks"><Input value={f.remarks ?? ''} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></Field>
        </div>
      </Modal>
      <ReasonModal open={!!rej} title={`${rej?.action === 'reject' ? 'Reject' : 'Revoke'} ${rej?.d.do_no ?? ''}`} onClose={() => setRej(null)} onSave={(r) => doReject.mutate(r)} />
    </div>
  );
}
