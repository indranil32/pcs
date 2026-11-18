import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, post, patch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { fmtMoney, label } from '../lib/format';
import { Badge, Button, Card, Field, Input, Modal, PageHeader, Select, Table, useAction } from '../components/ui';

const APPLIES = ['VESSEL_CALL', 'BARGE_CALL', 'DELIVERY_ORDER', 'TRUCK_APPOINTMENT', 'SERVICE_REQUEST'];
const BASIS = ['PER_CALL', 'PER_GT', 'PER_LOA_DAY', 'PER_TEU', 'PER_TONNE', 'PER_UNIT'];

export default function Tariffs() {
  const t = useT();
  const { has } = useAuth();
  const q = useQuery({ queryKey: ['tariffs'], queryFn: () => api<any[]>('/tariffs') });
  const [edit, setEdit] = useState<any>(null);
  const save = useAction(() => {
    const body = { code: edit.code, name: edit.name, appliesTo: edit.applies_to, basis: edit.basis, rate: Number(edit.rate), minAmount: edit.min_amount ? Number(edit.min_amount) : null, active: edit.active !== false };
    return edit.id ? patch(`/tariffs/${edit.id}`, body) : post('/tariffs', body);
  }, { invalidate: [['tariffs']], success: 'Tariff saved', onDone: () => setEdit(null) });
  const canEdit = has('FINANCE', 'PORT_ADMIN');
  return (
    <div>
      <PageHeader title={t('tariffs')} subtitle="Port tariff book — the rating engine applies every active line whose basis is measurable for the billed record"
        actions={canEdit && <Button onClick={() => setEdit({ applies_to: 'VESSEL_CALL', basis: 'PER_CALL', active: true })}>New tariff line</Button>} />
      <Card pad={false}>
        <Table rows={q.data} loading={q.isLoading} onRow={canEdit ? (r) => setEdit(r) : undefined} cols={[
          { key: 'code', header: 'Code', render: (r) => <span className="font-mono text-xs">{r.code}</span> },
          { key: 'name', header: 'Name' }, { key: 'applies_to', header: 'Applies to', render: (r) => label(r.applies_to) },
          { key: 'basis', header: 'Basis', render: (r) => label(r.basis) },
          { key: 'rate', header: 'Rate', className: 'num text-right', render: (r) => `${r.currency} ${Number(r.rate).toLocaleString()}` },
          { key: 'min_amount', header: 'Minimum', className: 'num text-right', render: (r) => r.min_amount ? fmtMoney(r.min_amount, r.currency) : '—' },
          { key: 'active', header: 'Active', render: (r) => <Badge s={r.active ? 'ACTIVE' : 'CANCELLED'}>{r.active ? 'Active' : 'Inactive'}</Badge> },
        ]} />
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.code}` : 'New tariff line'} footer={<><Button variant="secondary" onClick={() => setEdit(null)}>Cancel</Button><Button onClick={() => save.mutate()} loading={save.isPending}>Save</Button></>}>
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code"><Input disabled={!!edit.id} value={edit.code ?? ''} onChange={(e) => setEdit({ ...edit, code: e.target.value })} /></Field>
            <Field label="Name"><Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Applies to"><Select disabled={!!edit.id} value={edit.applies_to} onChange={(e) => setEdit({ ...edit, applies_to: e.target.value })} options={APPLIES.map((x) => ({ value: x, label: label(x) }))} /></Field>
            <Field label="Basis"><Select value={edit.basis} onChange={(e) => setEdit({ ...edit, basis: e.target.value })} options={BASIS.map((x) => ({ value: x, label: label(x) }))} /></Field>
            <Field label="Rate"><Input type="number" step="0.0001" value={edit.rate ?? ''} onChange={(e) => setEdit({ ...edit, rate: e.target.value })} /></Field>
            <Field label="Minimum amount"><Input type="number" value={edit.min_amount ?? ''} onChange={(e) => setEdit({ ...edit, min_amount: e.target.value })} /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit.active !== false} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} />Active</label>
          </div>
        )}
      </Modal>
    </div>
  );
}
