import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../lib/api';
import { fmtDateTime, label } from '../lib/format';

export default function Verify() {
  const { no } = useParams();
  const q = useQuery({ queryKey: ['verify', no], queryFn: () => api(`/public/verify/permit/${no}`), retry: false });
  const d: any = q.data;
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow">
        <div className="text-xs uppercase tracking-widest text-teal-600">Maqta PCS · permit verification</div>
        {q.isLoading && <p className="mt-4 text-slate-400">Checking…</p>}
        {q.error && <div className="mt-4 flex items-center gap-2 text-red-600"><XCircle className="h-6 w-6" />No permit found with number {no}</div>}
        {d && (
          <>
            <div className={`mt-4 flex items-center gap-2 text-lg font-semibold ${d.valid ? 'text-emerald-700' : 'text-red-600'}`}>
              {d.valid ? <CheckCircle2 className="h-6 w-6" /> : <XCircle className="h-6 w-6" />}{d.valid ? 'Valid port entry permit' : 'Permit no longer valid'}
            </div>
            <dl className="mt-4 space-y-1 text-sm">
              {[['Port', d.port], ['Permit', d.permitNo], ['Vessel', `${d.vessel} (IMO ${d.imo})`], ['Granted', fmtDateTime(d.grantedAt)], ['ETA / ETD', `${fmtDateTime(d.eta)} / ${fmtDateTime(d.etd)}`], ['Call status', label(d.callStatus)]].map(([k, v]) => (
                <div key={k} className="flex justify-between gap-4"><dt className="text-slate-500">{k}</dt><dd className="text-right font-medium">{v}</dd></div>
              ))}
            </dl>
          </>
        )}
      </div>
    </div>
  );
}
