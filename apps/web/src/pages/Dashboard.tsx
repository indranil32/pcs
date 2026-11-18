import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { Ship, Clock, Container, Truck, ShieldCheck, Receipt, Gauge, Timer } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useT } from '../lib/i18n';
import { fmtDateTime, fmtMoney, fmtNum, label } from '../lib/format';
import { Card, PageHeader, Stat, Table, Badge } from '../components/ui';

export default function Dashboard() {
  const { me, has } = useAuth();
  const t = useT();
  const nav = useNavigate();
  const kpi = useQuery({ queryKey: ['kpis'], queryFn: () => api('/analytics/kpis'), refetchInterval: 30_000 });
  const trends = useQuery({ queryKey: ['trends'], queryFn: () => api('/analytics/trends') });
  const calls = useQuery({ queryKey: ['vessel-calls', 'active'], queryFn: () => api<any[]>('/vessel-calls?status=BERTH_REQUESTED,BERTH_ALLOCATED,PRE_ARRIVAL_SUBMITTED,ARRIVAL_CLEARED,ARRIVED,BERTHED,DEPARTURE_REQUESTED,DEPARTURE_CLEARED') });
  const isAgency = has('CUSTOMS', 'IMMIGRATION', 'BORDER_POLICE', 'PORT_HEALTH', 'MARITIME_SAFETY', 'HARBOUR_MASTER');
  const queue = useQuery({ queryKey: ['approvals', 'PENDING'], queryFn: () => api<any[]>('/approvals?status=PENDING'), enabled: isAgency });
  const k: any = kpi.data ?? {};
  const cur = me?.tenant.currency;
  const days = (trends.data?.calls ?? []).map((d: any) => ({ ...d, day: new Date(d.day).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) }));

  return (
    <div className="space-y-5">
      <PageHeader title={`${me?.tenant.name}`} subtitle={`${t('dashboard')} · last 30 days · ${me?.user.orgName ?? 'Platform'}`} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Vessels in port" value={fmtNum(k.vessels_in_port)} hint={`${fmtNum(k.vessel_calls)} calls in period`} icon={<Ship className="h-4 w-4 text-slate-400" />} />
        <Stat label="Avg turnaround" value={k.avg_turnaround_h != null ? `${k.avg_turnaround_h} h` : '—'} hint={`waiting ${k.avg_waiting_h ?? '—'} h · ETA accuracy ${k.eta_accuracy_pct ?? '—'}%`} icon={<Clock className="h-4 w-4 text-slate-400" />} tone="teal" />
        <Stat label="Customs release time" value={k.avg_release_time_h != null ? `${k.avg_release_time_h} h` : '—'} hint="WTO TFA Art. 7.6 — published" icon={<Timer className="h-4 w-4 text-slate-400" />} />
        <Stat label="Import dwell" value={k.avg_import_dwell_days != null ? `${k.avg_import_dwell_days} d` : '—'} hint={`${fmtNum(k.teu_handled)} TEU handled`} icon={<Container className="h-4 w-4 text-slate-400" />} tone="teal" />
        <Stat label="Pending clearances" value={fmtNum(k.pending_clearances)} hint={`avg decision ${k.avg_clearance_h ?? '—'} h`} tone={k.pending_clearances ? 'amber' : 'green'} icon={<ShieldCheck className="h-4 w-4 text-slate-400" />} />
        <Stat label="Truck turnaround" value={k.avg_truck_turnaround_min != null ? `${k.avg_truck_turnaround_min} min` : '—'} hint={`${fmtNum(k.gate_transactions)} gate moves · ${k.gate_rejection_pct ?? 0}% rejected`} icon={<Truck className="h-4 w-4 text-slate-400" />} />
        <Stat label="Appointment adherence" value={k.appointment_adherence_pct != null ? `${k.appointment_adherence_pct}%` : '—'} hint={`EDI success ${k.edi_success_pct ?? '—'}%`} icon={<Gauge className="h-4 w-4 text-slate-400" />} tone="green" />
        <Stat label="Invoiced" value={fmtMoney(k.revenue_invoiced, cur)} hint={<span className={k.overdue_amount > 0 ? 'text-red-600' : ''}>overdue {fmtMoney(k.overdue_amount, cur)}</span>} icon={<Receipt className="h-4 w-4 text-slate-400" />} />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card title="Daily port activity" className="lg:col-span-2">
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={days} margin={{ left: -20, right: 8 }} barCategoryGap="15%">
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                <XAxis dataKey="day" tick={{ fontSize: 11 }} interval={3} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="arrivals" name="Vessel arrivals" fill="#0B2545" radius={[3, 3, 0, 0]} />
                <Bar dataKey="releases" name="Customs releases" fill="#13A3AE" radius={[3, 3, 0, 0]} />
                <Bar dataKey="gate_moves" name="Gate moves" fill="#94a3b8" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card title="Clearance by agency">
          <Table rows={trends.data?.clearanceByAgency} cols={[
            { key: 'agency', header: 'Agency', render: (r: any) => label(r.agency) },
            { key: 'pending', header: 'Pending', className: 'num text-right', render: (r: any) => r.pending ? <Badge s="PENDING">{r.pending}</Badge> : 0 },
            { key: 'avg_hours', header: 'Avg h', className: 'num text-right' },
          ]} />
          <div className="mt-4 border-t border-slate-100 pt-3">
            <div className="mb-2 text-xs font-medium uppercase text-slate-500">Berth occupancy</div>
            {(trends.data?.berthOccupancy ?? []).map((b: any) => (
              <div key={b.code} className="mb-1.5 flex items-center gap-2 text-xs">
                <span className="w-10 font-medium">{b.code}</span>
                <div className="h-2 flex-1 rounded bg-slate-100"><div className="h-2 rounded bg-teal-500" style={{ width: `${Math.min(100, b.pct)}%` }} /></div>
                <span className="num w-10 text-right text-slate-500">{b.pct}%</span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {isAgency && (
        <Card title={`My clearance queue (${queue.data?.length ?? 0})`} actions={<Link to="/clearance" className="text-sm text-teal-600 hover:underline">Open queue →</Link>}>
          <Table rows={queue.data?.slice(0, 6)} empty="No clearances waiting for you" onRow={(r) => nav(`/vessel-calls/${r.entity_id}`)} cols={[
            { key: 'vessel_name', header: t('vessel'), render: (r: any) => <><div className="font-medium">{r.vessel_name}</div><div className="text-xs text-slate-500">{r.call_no}</div></> },
            { key: 'stage', header: 'Stage', render: (r: any) => label(r.stage) },
            { key: 'agency', header: 'Agency', render: (r: any) => label(r.agency) },
            { key: 'eta', header: t('eta'), render: (r: any) => fmtDateTime(r.eta) },
            { key: 'status', header: t('status'), render: (r: any) => <Badge s={r.status} /> },
          ]} />
        </Card>
      )}

      <Card title="Active vessel calls" actions={<Link to="/vessel-calls" className="text-sm text-teal-600 hover:underline">All calls →</Link>} pad={false}>
        <Table rows={calls.data?.slice(0, 10)} loading={calls.isLoading} onRow={(r) => nav(`/vessel-calls/${r.id}`)} cols={[
          { key: 'vessel_name', header: t('vessel'), render: (r: any) => <><div className="font-medium">{r.vessel_name}</div><div className="text-xs text-slate-500">IMO {r.imo} · {r.call_no}</div></> },
          { key: 'agent_name', header: t('agent') },
          { key: 'berth_code', header: t('berth') },
          { key: 'eta', header: `${t('eta')} / ATA`, render: (r: any) => fmtDateTime(r.ata ?? r.eta) },
          { key: 'etd', header: t('etd'), render: (r: any) => fmtDateTime(r.etd) },
          { key: 'status', header: t('status'), render: (r: any) => <Badge s={r.status} /> },
        ]} />
      </Card>
    </div>
  );
}
