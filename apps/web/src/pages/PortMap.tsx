import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { MapContainer, TileLayer, CircleMarker, Popup, Tooltip } from 'react-leaflet';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { ago, label } from '../lib/format';
import { Card, PageHeader, Table, Badge } from '../components/ui';

export default function PortMap() {
  const t = useT();
  const q = useQuery({ queryKey: ['gis'], queryFn: () => api('/gis/map'), refetchInterval: 30_000 });
  const d: any = q.data;
  if (!d?.port?.lat) return <PageHeader title={t('map')} subtitle="Loading…" />;
  return (
    <div className="space-y-4">
      <PageHeader title={t('map')} subtitle="Berths, terminals and vessel positions (AIS feed — simulated in the demo environment), refreshed every 30 s" />
      <Card pad={false}>
        <div className="h-[62vh] overflow-hidden rounded-xl">
          <MapContainer center={[d.port.lat, d.port.lon]} zoom={12} className="h-full w-full">
            <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
            {d.terminals.map((x: any) => (
              <CircleMarker key={x.id} center={[x.lat, x.lon]} radius={14} pathOptions={{ color: '#0E7C86', fillOpacity: 0.08, weight: 1 }}>
                <Tooltip direction="top">{x.name}</Tooltip>
              </CircleMarker>
            ))}
            {d.berths.map((b: any) => (
              <CircleMarker key={b.id} center={[b.lat, b.lon]} radius={6} pathOptions={{ color: b.occupant ? '#0B2545' : '#94a3b8', fillColor: b.occupant ? '#0B2545' : '#fff', fillOpacity: 1, weight: 2 }}>
                <Popup><b>{b.code}</b> {b.name}<br />{b.length_m} m · {b.depth_m} m{b.occupant && <><br />Occupied: {b.occupant.vessel}</>}</Popup>
              </CircleMarker>
            ))}
            {d.vessels.map((v: any) => (
              <CircleMarker key={v.mmsi} center={[v.lat, v.lon]} radius={7} pathOptions={{ color: '#fff', weight: 2, fillColor: v.nav_status === 'MOORED' ? '#0E7C86' : v.nav_status === 'UNDER_WAY' ? '#4f46e5' : '#f59e0b', fillOpacity: 1 }}>
                <Tooltip>{v.name}</Tooltip>
                <Popup><b>{v.name}</b> (IMO {v.imo})<br />{label(v.type)} · {label(v.nav_status)} · {v.sog} kn<br />{v.call && <Link to={`/vessel-calls/${v.call.id}`}>{v.call.callNo} — {label(v.call.status)}</Link>}<br /><small>{ago(v.at)}</small></Popup>
              </CircleMarker>
            ))}
          </MapContainer>
        </div>
      </Card>
      <div className="flex flex-wrap gap-4 text-xs text-slate-600">
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-full bg-amber-500" />At anchor / waiting</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-full bg-indigo-600" />Under way</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-full bg-teal-600" />Moored</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-full border-2 border-navy-900 bg-navy-900" />Occupied berth</span>
      </div>
      <Card title="Vessels tracked" pad={false}>
        <Table rows={d.vessels} cols={[
          { key: 'name', header: 'Vessel' }, { key: 'mmsi', header: 'MMSI' }, { key: 'nav_status', header: 'Nav status', render: (v: any) => label(v.nav_status) },
          { key: 'sog', header: 'SOG kn' }, { key: 'call', header: 'Call', render: (v: any) => v.call ? <Badge s={v.call.status} /> : '—' }, { key: 'at', header: 'Last fix', render: (v: any) => ago(v.at) },
        ]} />
      </Card>
    </div>
  );
}
