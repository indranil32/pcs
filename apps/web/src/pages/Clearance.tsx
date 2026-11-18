import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, post } from '../lib/api';
import { useT } from '../lib/i18n';
import { fmtDateTime, label } from '../lib/format';
import { Badge, Button, Card, Input, PageHeader, Table, Tabs, useAction } from '../components/ui';

export default function Clearance() {
  const t = useT();
  const nav = useNavigate();
  const [status, setStatus] = useState('PENDING');
  const q = useQuery({ queryKey: ['approvals', status], queryFn: () => api<any[]>(`/approvals${status ? `?status=${status}` : ''}`), refetchInterval: 20_000 });
  const [remarks, setRemarks] = useState<Record<string, string>>({});
  const decide = useAction((a: { id: string; status: string }) => post(`/approvals/${a.id}/decision`, { status: a.status, remarks: remarks[a.id] || undefined }), { invalidate: [['approvals'], ['vessel-call']], success: 'Decision recorded' });

  return (
    <div>
      <PageHeader title={t('clearance')} subtitle="Single Window — each agency decides independently; the permit is issued automatically when all approve" />
      <Tabs value={status} onChange={setStatus} tabs={[{ id: 'PENDING', label: t('pending') }, { id: 'QUERY', label: 'Queries' }, { id: 'APPROVED', label: 'Approved' }, { id: 'REJECTED', label: 'Rejected' }, { id: '', label: t('all') }]} />
      <Card pad={false}>
        <Table rows={q.data} loading={q.isLoading} empty="Queue is clear" cols={[
          { key: 'vessel_name', header: t('vessel'), render: (r) => <button onClick={() => nav(`/vessel-calls/${r.entity_id}`)} className="text-left"><div className="font-medium text-teal-700 hover:underline">{r.vessel_name}</div><div className="text-xs text-slate-500">IMO {r.imo} · {r.call_no}</div></button> },
          { key: 'agent_name', header: t('agent') },
          { key: 'stage', header: 'Stage', render: (r) => label(r.stage) },
          { key: 'agency', header: 'Agency', render: (r) => label(r.agency) },
          { key: 'eta', header: t('eta'), render: (r) => fmtDateTime(r.eta) },
          { key: 'created_at', header: 'Requested', render: (r) => fmtDateTime(r.created_at) },
          { key: 'status', header: t('status'), render: (r) => <><Badge s={r.status} />{r.remarks && <div className="mt-1 max-w-48 text-xs text-slate-500">{r.remarks}</div>}</> },
          { key: 'act', header: t('actions'), render: (r) => r.status === 'PENDING' || r.status === 'QUERY' ? (
            <div className="flex min-w-72 items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
              <Input className="py-1 text-xs" placeholder="Remarks" value={remarks[r.id] ?? ''} onChange={(e) => setRemarks({ ...remarks, [r.id]: e.target.value })} />
              <Button size="sm" variant="success" onClick={() => decide.mutate({ id: r.id, status: 'APPROVED' })}>{t('approve')}</Button>
              <Button size="sm" variant="secondary" disabled={!remarks[r.id]} onClick={() => decide.mutate({ id: r.id, status: 'QUERY' })}>?</Button>
              <Button size="sm" variant="danger" disabled={!remarks[r.id]} onClick={() => decide.mutate({ id: r.id, status: 'REJECTED' })}>✕</Button>
            </div>) : <span className="text-xs text-slate-500">{r.decided_by_name} · {fmtDateTime(r.decided_at)}</span> },
        ]} />
      </Card>
    </div>
  );
}
