import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ORG_TYPES } from '@pcs/shared';
import { api, post } from '../lib/api';
import { label } from '../lib/format';
import { useT } from '../lib/i18n';
import { Button, Card, Field, Input, Select } from '../components/ui';

export default function Register() {
  const t = useT();
  const ports = useQuery({ queryKey: ['ports'], queryFn: () => api<any[]>('/public/ports') });
  const [f, setF] = useState<any>({ type: 'SHIPPING_AGENT' });
  const [done, setDone] = useState<string>('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await post('/public/register', {
        tenantId: f.tenantId,
        organisation: { name: f.name, type: f.type, registrationNo: f.registrationNo, taxId: f.taxId || undefined, email: f.orgEmail, phone: f.phone || undefined, address: f.address || undefined },
        user: { name: f.userName, email: f.email, password: f.password },
      });
      setDone(r.message);
    } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Link to="/login" className="text-sm text-teal-600 hover:underline">← {t('signIn')}</Link>
      <h1 className="mt-3 text-2xl font-semibold text-navy-900">{t('register')}</h1>
      <p className="mt-1 text-sm text-slate-500">Shipping agents, lines, forwarders, hauliers, barge and rail operators and service providers register here. The port administrator verifies your company before you can sign in.</p>
      {done ? (
        <Card className="mt-6"><p className="text-emerald-700">{done}</p></Card>
      ) : (
        <form onSubmit={submit} className="mt-6 space-y-5">
          <Card title="Organisation">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Port"><Select required value={f.tenantId ?? ''} onChange={set('tenantId')} placeholder="Select port…" options={(ports.data ?? []).map((p) => ({ value: p.id, label: p.name }))} /></Field>
              <Field label="Organisation type"><Select value={f.type} onChange={set('type')} options={ORG_TYPES.filter((x) => !['PORT_AUTHORITY', 'GOVERNMENT_AGENCY'].includes(x)).map((x) => ({ value: x, label: label(x) }))} /></Field>
              <Field label="Legal name" className="sm:col-span-2"><Input required value={f.name ?? ''} onChange={set('name')} /></Field>
              <Field label="Trade registry number"><Input required value={f.registrationNo ?? ''} onChange={set('registrationNo')} /></Field>
              <Field label="Tax ID"><Input value={f.taxId ?? ''} onChange={set('taxId')} /></Field>
              <Field label="Company email"><Input type="email" required value={f.orgEmail ?? ''} onChange={set('orgEmail')} /></Field>
              <Field label="Phone"><Input value={f.phone ?? ''} onChange={set('phone')} /></Field>
              <Field label="Address" className="sm:col-span-2"><Input value={f.address ?? ''} onChange={set('address')} /></Field>
            </div>
          </Card>
          <Card title="Administrator account">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Full name"><Input required value={f.userName ?? ''} onChange={set('userName')} /></Field>
              <Field label={t('email')}><Input type="email" required value={f.email ?? ''} onChange={set('email')} /></Field>
              <Field label={t('password')} hint="At least 8 characters"><Input type="password" minLength={8} required value={f.password ?? ''} onChange={set('password')} /></Field>
            </div>
          </Card>
          {err && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
          <Button type="submit" loading={busy}>{t('submit')}</Button>
        </form>
      )}
    </div>
  );
}
