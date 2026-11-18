import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, post } from '../lib/api';
import { useT } from '../lib/i18n';
import { fmtDateTime } from '../lib/format';
import { Badge, Button, Card, Field, Modal, PageHeader, Select, Table, Textarea, useAction } from '../components/ui';

const SAMPLE = `UNA:+.? '
UNB+UNOC:3+TERMINAL+PCS+261118:1200+REF0001'
UNH+1+CODECO:D:95B:UN'
BGM+36+GO001+9'
DTM+7:202611181200:203'
EQD+CN+EUXU1000009+45G1+++5'
UNT+5+1'
UNZ+1+REF0001'`;

export default function Edi() {
  const t = useT();
  const [type, setType] = useState('');
  const [dir, setDir] = useState('');
  const [view, setView] = useState<string | null>(null);
  const [send, setSend] = useState(false);
  const [raw, setRaw] = useState(SAMPLE);
  const [result, setResult] = useState<any>(null);
  const q = useQuery({ queryKey: ['edi', type, dir], queryFn: () => api<any[]>(`/edi/messages?${new URLSearchParams({ ...(type && { type }), ...(dir && { direction: dir }) })}`), refetchInterval: 15_000 });
  const msg = useQuery({ queryKey: ['edi-msg', view], queryFn: () => api(`/edi/messages/${view}`), enabled: !!view });
  const submit = useAction(() => post('/edi/inbound', { raw }), { invalidate: [['edi']], onDone: setResult });
  const m: any = msg.data;

  return (
    <div>
      <PageHeader title={t('edi')} subtitle="UN/EDIFACT gateway — CUSCAR, CODECO, COARRI, BERMAN, CUSRES in; APERAK acknowledgements and CUSCAR to customs out. Every message is stored for audit."
        actions={<Button onClick={() => { setSend(true); setResult(null); }}>Submit EDI message</Button>} />
      <Card pad={false}>
        <div className="flex gap-2 border-b border-slate-100 p-3">
          <Select value={dir} onChange={(e) => setDir(e.target.value)} placeholder="Direction: all" className="max-w-44" options={[{ value: 'IN', label: 'Inbound' }, { value: 'OUT', label: 'Outbound' }]} />
          <Select value={type} onChange={(e) => setType(e.target.value)} placeholder="Type: all" className="max-w-44" options={['CUSCAR', 'CODECO', 'COARRI', 'BERMAN', 'CUSRES', 'APERAK'].map((x) => ({ value: x, label: x }))} />
        </div>
        <Table rows={q.data} loading={q.isLoading} onRow={(r) => setView(r.id)} cols={[
          { key: 'created_at', header: 'Time', render: (r) => fmtDateTime(r.created_at) },
          { key: 'direction', header: 'Dir.', render: (r) => <Badge s={r.direction === 'IN' ? 'SUBMITTED' : 'SENT'}>{r.direction}</Badge> },
          { key: 'msg_type', header: 'Type', render: (r) => <span className="font-mono text-xs font-semibold">{r.msg_type}</span> },
          { key: 'sender', header: 'Sender → receiver', render: (r) => <span className="text-xs">{r.sender ?? '—'} → {r.receiver ?? '—'}</span> },
          { key: 'org_name', header: 'Organisation' },
          { key: 'summary', header: 'Summary', render: (r) => <>{r.summary}{r.errors?.length > 0 && <div className="text-xs text-red-600">{r.errors.join('; ')}</div>}</> },
          { key: 'status', header: t('status'), render: (r) => <Badge s={r.status} /> },
        ]} />
      </Card>
      <Modal open={!!view} onClose={() => setView(null)} wide title={m ? `${m.msg_type} ${m.direction === 'IN' ? 'received' : 'sent'} ${fmtDateTime(m.created_at)}` : 'Message'}>
        {m && <pre className="max-h-[55vh] overflow-auto rounded-lg bg-navy-950 p-4 font-mono text-xs leading-relaxed text-teal-300">{m.raw.replace(/'(?!\n)/g, "'\n")}</pre>}
      </Modal>
      <Modal open={send} onClose={() => setSend(false)} wide title="Submit EDIFACT interchange" footer={<><Button variant="secondary" onClick={() => setSend(false)}>Close</Button><Button onClick={() => submit.mutate()} loading={submit.isPending}>Process</Button></>}>
        <Field label="Interchange (UNA/UNB … UNZ)" hint="Systems normally post to /api/edi/inbound with an API key (content-type application/edifact). This form is for testing and manual re-processing.">
          <Textarea rows={12} className="font-mono text-xs" value={raw} onChange={(e) => setRaw(e.target.value)} />
        </Field>
        {result && result.messages?.map((r: any) => (
          <div key={r.id} className={`mt-3 rounded-md p-3 text-sm ${r.status === 'PROCESSED' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>
            <b>{r.type}: {r.status}</b> {r.summary}{r.errors?.length > 0 && <ul className="mt-1 list-disc pl-5">{r.errors.map((e: string) => <li key={e}>{e}</li>)}</ul>}
            <pre className="mt-2 overflow-x-auto rounded bg-white/60 p-2 font-mono text-[11px]">{r.aperak}</pre>
          </div>
        ))}
        {result && result.status === 'ERROR' && <div className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800">{result.errors?.join('; ')}</div>}
      </Modal>
    </div>
  );
}
