import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { api } from '../lib/api';
import { fmtDateTime, label } from '../lib/format';

export default function Permit() {
  const { id } = useParams();
  const q = useQuery({ queryKey: ['permit', id], queryFn: () => api(`/vessel-calls/${id}/permit`) });
  const p: any = q.data;
  if (q.error) return <div className="p-10 text-red-600">{String((q.error as any).message)}</div>;
  if (!p) return <div className="p-10 text-slate-400">Loading…</div>;
  const c = p.call;
  return (
    <div className="mx-auto my-8 max-w-3xl bg-white p-10 shadow print:my-0 print:shadow-none">
      <div className="flex items-start justify-between border-b-4 border-navy-900 pb-4">
        <div>
          <div className="text-xs uppercase tracking-widest text-teal-600">{p.port}</div>
          <h1 className="mt-1 text-2xl font-bold text-navy-900">Port Entry Permit</h1>
          <div className="font-mono text-sm">{p.permitNo}</div>
        </div>
        <QRCodeSVG value={`${location.origin}${p.verifyUrl}`} size={96} />
      </div>
      <table className="mt-6 w-full text-sm">
        <tbody>
          {[
            ['Vessel', `${c.vessel_name} (IMO ${c.imo})`], ['Flag / call sign', `${c.flag ?? '—'} / ${c.call_sign ?? '—'}`], ['Type / GT / LOA', `${label(c.vessel_type)} / ${c.gt} / ${c.loa} m`],
            ['Agent', c.agent_name], ['Voyage', `${c.voyage_in ?? '—'} / ${c.voyage_out ?? '—'}`], ['Berth', `${c.berth_code} — ${c.berth_name}`],
            ['ETA / ETD', `${fmtDateTime(c.eta)} / ${fmtDateTime(c.etd)}`], ['Call reference', c.call_no], ['Granted', fmtDateTime(p.grantedAt)],
          ].map(([k, v]) => <tr key={k} className="border-b border-slate-100"><td className="w-48 py-2 text-slate-500">{k}</td><td className="py-2 font-medium">{v}</td></tr>)}
        </tbody>
      </table>
      <h2 className="mt-6 text-sm font-semibold uppercase text-slate-500">Agency clearances</h2>
      <table className="mt-2 w-full text-sm">
        <tbody>{p.approvals.map((a: any) => <tr key={a.agency} className="border-b border-slate-100"><td className="py-2">{label(a.agency)}</td><td className="py-2 font-medium text-emerald-700">{a.status}</td><td className="py-2 text-slate-500">{fmtDateTime(a.decided_at)}</td></tr>)}</tbody>
      </table>
      <p className="mt-8 text-xs text-slate-400">Issued electronically by the {p.port} Port Community System (Maqta PCS). Verify authenticity by scanning the QR code. Valid for the call referenced above only.</p>
      <button onClick={() => print()} className="mt-6 rounded-md bg-navy-900 px-4 py-2 text-sm text-white print:hidden">Print</button>
    </div>
  );
}
