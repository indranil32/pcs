import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { CreditCard, Download, Printer } from 'lucide-react';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { fmtDate, fmtDateTime, fmtMoney, label } from '../lib/format';
import { Badge, Button, Card, Input, KV, Modal, PageHeader, Select, Table, Tabs, useAction } from '../components/ui';

export default function Finance() {
  const t = useT();
  const { id } = useParams();
  const nav = useNavigate();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ['invoices', status, search], queryFn: () => api<any[]>(`/invoices?${new URLSearchParams({ ...(status && { status }), ...(search && { search }) })}`) });
  const totals = (q.data ?? []).reduce((a: any, i: any) => { a[i.status] = (a[i.status] ?? 0) + Number(i.total); return a; }, {});
  const cur = q.data?.[0]?.currency ?? '';
  return (
    <div>
      <PageHeader title={t('finance')} subtitle="Invoices rated automatically from the port tariff book when a call, service, eDO or gate move completes" />
      <div className="mb-4 grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-xs uppercase text-slate-500">Outstanding</div><div className="num mt-1 text-xl font-semibold text-amber-600">{fmtMoney(totals.ISSUED ?? 0, cur)}</div></div>
        <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-xs uppercase text-slate-500">Paid</div><div className="num mt-1 text-xl font-semibold text-emerald-600">{fmtMoney(totals.PAID ?? 0, cur)}</div></div>
        <div className="rounded-xl border border-slate-200 bg-white p-4"><div className="text-xs uppercase text-slate-500">Invoices</div><div className="num mt-1 text-xl font-semibold">{q.data?.length ?? 0}</div></div>
      </div>
      <Tabs value={status} onChange={setStatus} tabs={[{ id: '', label: t('all') }, { id: 'ISSUED', label: 'Outstanding' }, { id: 'PAID', label: 'Paid' }, { id: 'CANCELLED', label: 'Cancelled' }]} />
      <Card pad={false}>
        <div className="border-b border-slate-100 p-3"><Input placeholder={`${t('search')}: invoice no., reference`} value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-sm" /></div>
        <Table rows={q.data} loading={q.isLoading} onRow={(r) => nav(`/finance/invoices/${r.id}`)} cols={[
          { key: 'invoice_no', header: 'Invoice', render: (r) => <span className="font-mono text-xs">{r.invoice_no}</span> },
          { key: 'customer_name', header: 'Customer' }, { key: 'reference', header: 'Reference' },
          { key: 'entity_type', header: 'For', render: (r) => label(r.entity_type) },
          { key: 'issued_at', header: 'Issued', render: (r) => fmtDate(r.issued_at) },
          { key: 'due_at', header: 'Due', render: (r) => <span className={r.status === 'ISSUED' && new Date(r.due_at) < new Date() ? 'font-medium text-red-600' : ''}>{fmtDate(r.due_at)}</span> },
          { key: 'total', header: 'Total', className: 'num text-right', render: (r) => fmtMoney(r.total, r.currency) },
          { key: 'status', header: t('status'), render: (r) => <Badge s={r.status} /> },
        ]} />
      </Card>
      {id && <InvoiceModal id={id} onClose={() => nav('/finance')} />}
    </div>
  );
}

function InvoiceModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { me, has } = useAuth();
  const q = useQuery({ queryKey: ['invoice', id], queryFn: () => api(`/invoices/${id}`) });
  const [method, setMethod] = useState('CARD');
  const pay = useAction(() => post(`/invoices/${id}/pay`, { method }), { invalidate: [['invoice', id], ['invoices'], ['kpis']], success: 'Payment successful' });
  const erp = async () => {
    const d = await api(`/invoices/${id}/erp`);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' })); a.download = `${d.documentNo}_erp.json`; a.click();
  };
  const i: any = q.data;
  return (
    <Modal open onClose={onClose} wide title={i ? <>Invoice <span className="font-mono">{i.invoice_no}</span> <Badge s={i.status} /></> : 'Invoice'}
      footer={i && <>
        <Button variant="secondary" onClick={() => print()}><Printer className="h-4 w-4" />Print</Button>
        {has('FINANCE') && <Button variant="secondary" onClick={erp}><Download className="h-4 w-4" />ERP export</Button>}
        {i.status === 'ISSUED' && (i.customer_org_id === me?.user.orgId || has('FINANCE')) && <>
          <Select value={method} onChange={(e) => setMethod(e.target.value)} className="w-40" options={[{ value: 'CARD', label: 'Card' }, { value: 'BANK_TRANSFER', label: 'Bank transfer' }, { value: 'WALLET', label: 'PCS wallet' }]} />
          <Button onClick={() => pay.mutate()} loading={pay.isPending}><CreditCard className="h-4 w-4" />Pay {fmtMoney(i.total, i.currency)}</Button>
        </>}
      </>}>
      {i && (
        <div className="space-y-4">
          <KV items={[['Issued by', i.port], ['Customer', i.customer_name], ['Tax ID', i.customer_tax_id], ['Reference', i.reference], ['Issued', fmtDate(i.issued_at)], ['Due', fmtDate(i.due_at)]]} />
          <Table rows={i.lines} cols={[
            { key: 'tariff_code', header: 'Code', render: (l: any) => <span className="font-mono text-xs">{l.tariff_code}</span> },
            { key: 'description', header: 'Description' },
            { key: 'quantity', header: 'Qty', className: 'num text-right', render: (l: any) => Number(l.quantity).toLocaleString() },
            { key: 'rate', header: 'Rate', className: 'num text-right', render: (l: any) => Number(l.rate).toLocaleString() },
            { key: 'amount', header: 'Amount', className: 'num text-right', render: (l: any) => fmtMoney(l.amount) },
          ]} />
          <div className="ml-auto w-64 space-y-1 text-sm">
            <div className="flex justify-between"><span className="text-slate-500">Subtotal</span><span className="num">{fmtMoney(i.subtotal, i.currency)}</span></div>
            <div className="flex justify-between"><span className="text-slate-500">VAT</span><span className="num">{fmtMoney(i.tax, i.currency)}</span></div>
            <div className="flex justify-between border-t border-slate-200 pt-1 text-base font-semibold"><span>Total</span><span className="num">{fmtMoney(i.total, i.currency)}</span></div>
          </div>
          {i.payments.length > 0 && <div className="rounded-md bg-emerald-50 p-3 text-sm text-emerald-800">{i.payments.map((p: any) => <div key={p.id}>Paid {fmtMoney(p.amount, p.currency)} by {label(p.method)} · ref <span className="font-mono">{p.provider_ref}</span> · {fmtDateTime(p.at)}</div>)}</div>}
        </div>
      )}
    </Modal>
  );
}
