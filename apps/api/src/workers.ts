// Background workers: outbox dispatcher (webhooks; Kafka producer slots in here), AIS simulator, no-show sweeper.
import crypto from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { pool, many, withTenant } from './core/db.js';
import { config } from './core/config.js';

export async function dispatchOutbox(log?: FastifyBaseLogger) {
  await withTenant('*', async (c) => {
    const events = await many(c, `SELECT * FROM outbox WHERE published_at IS NULL AND attempts < 10 ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED`);
    for (const e of events) {
      const hooks = await many(c, `SELECT * FROM webhooks WHERE tenant_id=$1 AND active AND ($2 = ANY(events) OR '*' = ANY(events))`, [e.tenant_id, e.event_type]);
      let error: string | null = null;
      for (const h of hooks) {
        const body = JSON.stringify({ id: e.id, type: e.event_type, entityType: e.entity_type, entityId: e.entity_id, occurredAt: e.created_at, data: e.payload });
        const sig = crypto.createHmac('sha256', h.secret).update(body).digest('hex');
        try {
          const r = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pcs-event': e.event_type, 'x-pcs-signature': `sha256=${sig}` }, body, signal: AbortSignal.timeout(5000) });
          if (!r.ok) error = `${h.url} → HTTP ${r.status}`;
        } catch (err: any) {
          error = `${h.url} → ${err.message}`;
        }
      }
      if (error) await c.query('UPDATE outbox SET attempts=attempts+1, last_error=$2 WHERE id=$1', [e.id, error]);
      else await c.query('UPDATE outbox SET published_at=now(), attempts=attempts+1 WHERE id=$1', [e.id]);
    }
  }).catch((e) => log?.error(e, 'outbox dispatch failed'));
}

/** Simulates AIS positions for vessels with active calls so the GIS map is live without a VTMS feed. */
export async function simulateAis() {
  await withTenant('*', async (c) => {
    const calls = await many(c, `SELECT vc.tenant_id, vc.status, v.id AS vessel_id, coalesce(v.mmsi, '9'||right(v.imo,7)||'0') AS mmsi, b.lat AS blat, b.lon AS blon, t.lat AS plat, t.lon AS plon
      FROM vessel_calls vc JOIN vessels v ON v.id=vc.vessel_id JOIN tenants t ON t.id=vc.tenant_id LEFT JOIN berths b ON b.id=vc.berth_id
      WHERE vc.status IN ('BERTH_ALLOCATED','PRE_ARRIVAL_SUBMITTED','ARRIVAL_CLEARED','ARRIVED','BERTHED','DEPARTURE_REQUESTED','DEPARTURE_CLEARED') AND t.lat IS NOT NULL`);
    for (const x of calls) {
      const atBerth = ['BERTHED', 'DEPARTURE_REQUESTED', 'DEPARTURE_CLEARED'].includes(x.status) && x.blat;
      const seed = parseInt(x.mmsi.slice(-4), 10) || 1;
      const ang = ((seed % 360) * Math.PI) / 180 + Date.now() / 3.6e6;
      const dist = x.status === 'ARRIVED' ? 0.03 : 0.08 + (seed % 7) * 0.01;
      const lat = atBerth ? x.blat : x.plat + Math.sin(ang) * dist;
      const lon = atBerth ? x.blon : x.plon + 0.06 + Math.abs(Math.cos(ang)) * dist;
      await c.query(`INSERT INTO ais_positions (tenant_id, mmsi, vessel_id, lat, lon, sog, cog, nav_status, at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now())
        ON CONFLICT (tenant_id, mmsi) DO UPDATE SET lat=EXCLUDED.lat, lon=EXCLUDED.lon, sog=EXCLUDED.sog, cog=EXCLUDED.cog, nav_status=EXCLUDED.nav_status, at=now()`,
        [x.tenant_id, x.mmsi, x.vessel_id, lat, lon, atBerth ? 0 : x.status === 'ARRIVED' ? 3.5 : 0.2, (seed * 7) % 360, atBerth ? 'MOORED' : x.status === 'ARRIVED' ? 'UNDER_WAY' : 'AT_ANCHOR']);
    }
    await c.query(`DELETE FROM ais_positions a WHERE NOT EXISTS (SELECT 1 FROM vessel_calls vc WHERE vc.vessel_id=a.vessel_id AND vc.status IN ('BERTH_ALLOCATED','PRE_ARRIVAL_SUBMITTED','ARRIVAL_CLEARED','ARRIVED','BERTHED','DEPARTURE_REQUESTED','DEPARTURE_CLEARED'))`);
  });
}

export async function sweepNoShows() {
  await withTenant('*', (c) => c.query(`UPDATE truck_appointments SET status='NO_SHOW' WHERE status='BOOKED' AND slot_end < now() - interval '2 hours'`));
}

export function startWorkers(log: FastifyBaseLogger) {
  const every = (ms: number, fn: () => Promise<unknown>) => setInterval(() => fn().catch((e) => log.error(e)), ms).unref();
  every(5_000, () => dispatchOutbox(log));
  every(300_000, sweepNoShows);
  if (config.aisSimulator) { every(30_000, simulateAis); simulateAis().catch(() => {}); }
  log.info('workers started');
  void pool;
}
