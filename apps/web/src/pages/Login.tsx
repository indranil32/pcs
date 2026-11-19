import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { Ship, Anchor, ShieldCheck, Truck } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useT, setLang, useLang, type Lang } from '../lib/i18n';
import { Button, Field, Input } from '../components/ui';

const DEMO: [string, string][] = [
  ['Shipping agent', 'agent'], ['Harbour master', 'harbour'], ['Customs', 'customs'], ['Border police', 'border'], ['Port health', 'health'],
  ['Immigration', 'immigration'], ['Maritime safety', 'maritime'], ['Shipping line', 'line'], ['Freight forwarder', 'forwarder'], ['Haulier', 'haulier'],
  ['Terminal operator', 'terminal'], ['Barge operator', 'barge'], ['Rail operator', 'rail'], ['Marine services', 'services'], ['Finance', 'finance'],
  ['Port admin', 'portadmin'], ['Executive', 'exec'],
];

export default function Login() {
  const { me, login } = useAuth();
  const t = useT();
  const lang = useLang();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [port, setPort] = useState<'zzalp' | 'zzbet'>('zzalp');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (me) return <Navigate to="/" replace />;

  const go = async (e?: React.FormEvent, em = email, pw = password) => {
    e?.preventDefault();
    setBusy(true); setErr('');
    try { await login(em, pw); nav('/'); } catch (x: any) { setErr(x.message); } finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-full flex-col lg:flex-row">
      <div className="relative flex flex-col justify-between overflow-hidden bg-navy-900 p-8 text-white lg:w-[46%] lg:p-12">
        <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: 'repeating-linear-gradient(135deg, #fff 0 1px, transparent 1px 22px)' }} />
        <div className="relative flex items-center gap-3">
          <img src="/favicon.svg" className="h-10 w-10" alt="" />
          <div>
            <div className="text-lg font-semibold">PCS</div>
            <div className="text-xs text-teal-400">Port Community System</div>
          </div>
        </div>
        <div className="relative my-10">
          <h1 className="text-3xl font-semibold leading-tight lg:text-4xl">{t('welcome')}</h1>
          <p className="mt-3 max-w-md text-slate-300">{t('tagline')}</p>
          <div className="mt-8 grid max-w-md grid-cols-2 gap-3 text-sm">
            {[[Ship, 'Vessel calls & FAL'], [ShieldCheck, 'Single Window clearance'], [Anchor, 'Cargo, customs & eDO'], [Truck, 'Truck appointments & gate']].map(([I, s]: any) => (
              <div key={s} className="flex items-center gap-2 rounded-lg bg-white/5 px-3 py-2.5"><I className="h-4 w-4 text-teal-400" />{s}</div>
            ))}
          </div>
        </div>
        <div className="relative text-xs text-slate-400">IMO FAL · WCO Data Model · UN/EDIFACT · WTO TFA · IPCSA · ISO 27001:2022</div>
      </div>

      <div className="flex flex-1 items-center justify-center p-6 lg:p-12">
        <div className="w-full max-w-md">
          <div className="mb-6 flex justify-end gap-1">
            {(['en', 'ro', 'uk'] as Lang[]).map((l) => (
              <button key={l} onClick={() => setLang(l)} className={`rounded px-2 py-1 text-xs font-medium uppercase ${lang === l ? 'bg-navy-900 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>{l}</button>
            ))}
          </div>
          <h2 className="text-xl font-semibold text-navy-900">{t('signIn')}</h2>
          <form onSubmit={go} className="mt-5 space-y-4">
            <Field label={t('email')}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" /></Field>
            <Field label={t('password')}><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" /></Field>
            {err && <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{err}</div>}
            <Button type="submit" loading={busy} className="w-full">{t('signIn')}</Button>
          </form>
          <p className="mt-4 text-center text-sm text-slate-500"><Link to="/register" className="font-medium text-teal-600 hover:underline">{t('register')}</Link></p>

          <div className="mt-8 rounded-xl border border-slate-200 bg-white p-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t('demoAccounts')}</span>
              <div className="flex gap-1 rounded-md bg-slate-100 p-0.5 text-xs">
                {(['zzalp', 'zzbet'] as const).map((p) => (
                  <button key={p} onClick={() => setPort(p)} className={`rounded px-2 py-1 font-medium ${port === p ? 'bg-white text-navy-900 shadow-sm' : 'text-slate-500'}`}>{p === 'zzalp' ? 'Demo Port Alpha' : 'Demo Port Beta'}</button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {DEMO.filter(([, k]) => !(port === 'zzalp' && k === 'immigration') && !(port === 'zzbet' && k === 'border')).map(([n, k]) => (
                <button key={k} onClick={() => { setEmail(`${k}@${port}.demo`); setPassword(''); }} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-teal-500 hover:text-teal-600">{n}</button>
              ))}
              <button onClick={() => { setEmail('admin@pcs.demo'); setPassword(''); }} className="rounded-full border border-slate-200 px-2.5 py-1 text-xs text-slate-600 hover:border-teal-500 hover:text-teal-600">Platform admin</button>
            </div>
            <p className="mt-3 text-[11px] text-slate-400">Picks the email; enter the demo password you were given. All demo data is synthetic.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
