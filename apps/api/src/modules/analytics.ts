// FR-AI / analytics: operational KPIs, trends, WTO TFA Art. 7.6 average release time (public), GIS map data
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, one, many, withTenant } from '../core/db.js';
import { tx, notFound, requireRole } from '../core/context.js';

const range = z.object({ from: z.coerce.date().default(() => new Date(Date.now() - 30 * 864e5)), to: z.coerce.date().default(() => new Date()) });

async function kpis(c: any, from: Date, to: Date) {
  const r = await one(c, `
    WITH calls AS (SELECT * FROM vessel_calls WHERE status<>'CANCELLED' AND eta BETWEEN $1 AND $2)
    SELECT
      (SELECT count(*) FROM calls)::int AS vessel_calls,
      (SELECT count(*) FROM vessel_calls WHERE status IN ('ARRIVED','BERTHED','DEPARTURE_REQUESTED','DEPARTURE_CLEARED'))::int AS vessels_in_port,
      (SELECT round(avg(extract(epoch FROM atd-ata)/3600)::numeric,1) FROM calls WHERE atd IS NOT NULL AND ata IS NOT NULL) AS avg_turnaround_h,
      (SELECT round(avg(extract(epoch FROM berthed_at-ata)/3600)::numeric,1) FROM calls WHERE berthed_at IS NOT NULL AND ata IS NOT NULL) AS avg_waiting_h,
      (SELECT round(100.0*count(*) FILTER (WHERE ata <= eta + interval '2 hours')/nullif(count(*),0),1) FROM calls WHERE ata IS NOT NULL) AS eta_accuracy_pct,
      (SELECT round(avg(extract(epoch FROM ap.decided_at-ap.created_at)/3600)::numeric,2) FROM approvals ap WHERE ap.decided_at BETWEEN $1 AND $2) AS avg_clearance_h,
      (SELECT count(*) FROM approvals WHERE status='PENDING')::int AS pending_clearances,
      (SELECT coalesce(sum(CASE WHEN left(iso_type,1) IN ('4','L') THEN 2 ELSE 1 END),0) FROM containers WHERE discharged_at BETWEEN $1 AND $2 OR loaded_at BETWEEN $1 AND $2)::int AS teu_handled,
      (SELECT round(avg(extract(epoch FROM gated_out_at-discharged_at)/86400)::numeric,2) FROM containers WHERE gated_out_at BETWEEN $1 AND $2 AND discharged_at IS NOT NULL) AS avg_import_dwell_days,
      (SELECT round(avg(extract(epoch FROM released_at-declared_at)/3600)::numeric,2) FROM bills_of_lading WHERE released_at BETWEEN $1 AND $2 AND declared_at IS NOT NULL) AS avg_release_time_h,
      (SELECT count(*) FROM bills_of_lading WHERE customs_status IN ('HELD','UNDER_INSPECTION'))::int AS bls_held,
      (SELECT round(avg(extract(epoch FROM gate_out_at-gate_in_at)/60)::numeric,1) FROM truck_appointments WHERE gate_out_at BETWEEN $1 AND $2) AS avg_truck_turnaround_min,
      (SELECT round(100.0*count(*) FILTER (WHERE gate_in_at BETWEEN slot_start - interval '30 min' AND slot_end)/nullif(count(*) FILTER (WHERE gate_in_at IS NOT NULL OR status='NO_SHOW'),0),1) FROM truck_appointments WHERE slot_start BETWEEN $1 AND $2) AS appointment_adherence_pct,
      (SELECT count(*) FROM gate_events WHERE at BETWEEN $1 AND $2)::int AS gate_transactions,
      (SELECT round(100.0*count(*) FILTER (WHERE result='REJECTED')/nullif(count(*),0),1) FROM gate_events WHERE at BETWEEN $1 AND $2) AS gate_rejection_pct,
      (SELECT count(*) FROM barge_calls WHERE eta BETWEEN $1 AND $2 AND status<>'CANCELLED')::int AS barge_calls,
      (SELECT count(*) FROM rail_visits WHERE eta BETWEEN $1 AND $2 AND status<>'CANCELLED')::int AS rail_visits,
      (SELECT round(100.0*count(*) FILTER (WHERE status='PROCESSED')/nullif(count(*),0),1) FROM edi_messages WHERE direction='IN' AND created_at BETWEEN $1 AND $2) AS edi_success_pct,
      (SELECT coalesce(sum(total),0) FROM invoices WHERE issued_at BETWEEN $1 AND $2 AND status<>'CANCELLED') AS revenue_invoiced,
      (SELECT coalesce(sum(total),0) FROM invoices WHERE status='ISSUED' AND due_at < now()) AS overdue_amount,
      (SELECT round(100.0*count(*) FILTER (WHERE source<>'UI')/nullif(count(*),0),1) FROM manifests WHERE created_at BETWEEN $1 AND $2) AS digital_submission_pct`, [from, to]);
  return r;
}

export default async function analytics(app: FastifyInstance) {
  app.get('/analytics/kpis', async (req) => {
    const q = range.parse(req.query);
    return tx(req, (c) => kpis(c, q.from, q.to));
  });

  app.get('/analytics/trends', async (req) => {
    const q = range.parse(req.query);
    return tx(req, async (c) => ({
      calls: await many(c, `SELECT d::date AS day, (SELECT count(*) FROM vessel_calls WHERE ata::date=d::date)::int AS arrivals, (SELECT count(*) FROM vessel_calls WHERE atd::date=d::date)::int AS departures,
          (SELECT count(*) FROM gate_events WHERE at::date=d::date AND result='ACCEPTED')::int AS gate_moves,
          (SELECT count(*) FROM bills_of_lading WHERE released_at::date=d::date)::int AS releases
        FROM generate_series($1::date, $2::date, '1 day') d ORDER BY d`, [q.from, q.to]),
      callsByStatus: await many(c, `SELECT status, count(*)::int AS n FROM vessel_calls WHERE status NOT IN ('DEPARTED','CANCELLED') GROUP BY status ORDER BY n DESC`),
      clearanceByAgency: await many(c, `SELECT agency, count(*) FILTER (WHERE status='PENDING')::int AS pending, round(avg(extract(epoch FROM decided_at-created_at)/3600)::numeric,2) AS avg_hours FROM approvals GROUP BY agency ORDER BY agency`),
      berthOccupancy: await many(c, `SELECT b.code, round(100.0 * coalesce(sum(extract(epoch FROM least(coalesce(vc.atd, now()), $2) - greatest(vc.berthed_at, $1))) FILTER (WHERE vc.berthed_at IS NOT NULL),0) / extract(epoch FROM ($2::timestamptz - $1::timestamptz)), 1) AS pct
        FROM berths b LEFT JOIN vessel_calls vc ON vc.berth_id=b.id AND vc.berthed_at < $2 AND coalesce(vc.atd, now()) > $1 WHERE NOT b.barge_berth GROUP BY b.code ORDER BY b.code`, [q.from, q.to]),
      revenueByType: await many(c, `SELECT entity_type, currency, sum(total) AS total FROM invoices WHERE status<>'CANCELLED' AND issued_at BETWEEN $1 AND $2 GROUP BY 1,2`, [q.from, q.to]),
    }));
  });

  // WTO TFA Article 7.6 — publish average release times. Public by design.
  app.get('/public/:portCode/release-time', { config: { public: true } }, async (req) => {
    const { portCode } = req.params as { portCode: string };
    const t = await one(pool, 'SELECT id, code, name FROM tenants WHERE code=$1', [portCode.toUpperCase()]);
    if (!t) throw notFound('Unknown port');
    return withTenant(t.id, async (c) => ({
      port: t.name, code: t.code, standard: 'WTO Trade Facilitation Agreement, Article 7.6',
      months: await many(c, `SELECT to_char(date_trunc('month', released_at),'YYYY-MM') AS month, count(*)::int AS releases,
          round(avg(extract(epoch FROM released_at-declared_at)/3600)::numeric,2) AS avg_release_hours,
          round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM released_at-declared_at)/3600))::numeric,2) AS median_release_hours
        FROM bills_of_lading WHERE released_at IS NOT NULL AND declared_at IS NOT NULL AND released_at > now() - interval '12 months' GROUP BY 1 ORDER BY 1`),
    }));
  });

  // Public verification of a port entry permit (target of the QR code on the printed permit)
  app.get('/public/verify/permit/:no', { config: { public: true } }, async (req) => {
    const { no } = req.params as { no: string };
    const code = no.split('-')[0];
    const t = await one(pool, 'SELECT id, name FROM tenants WHERE code=$1', [code]);
    if (!t) throw notFound('Permit not found');
    const r = await withTenant(t.id, (c) => one(c, `SELECT vc.entry_permit_no, vc.entry_permit_at, vc.status, vc.eta, vc.etd, v.name AS vessel, v.imo
      FROM vessel_calls vc JOIN vessels v ON v.id=vc.vessel_id WHERE vc.entry_permit_no=$1`, [no]));
    if (!r) throw notFound('Permit not found');
    return { valid: r.status !== 'CANCELLED', port: t.name, permitNo: r.entry_permit_no, grantedAt: r.entry_permit_at, vessel: r.vessel, imo: r.imo, callStatus: r.status, eta: r.eta, etd: r.etd };
  });

  // FR-GIS: AIS ingestion from an external feed (VTS, AIS receiver network or provider). Batch of latest positions.
  app.post('/ais/positions', async (req) => {
    requireRole(req.actor, 'HARBOUR_MASTER', 'MARITIME_SAFETY');
    const b = z.object({
      source: z.string().min(2).max(30).default('VTS'),
      positions: z.array(z.object({
        mmsi: z.string().regex(/^\d{9}$/), imo: z.string().regex(/^\d{7}$/).optional().nullable(),
        lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180),
        sog: z.number().min(0).max(102.3).optional().nullable(), cog: z.number().min(0).max(360).optional().nullable(),
        navStatus: z.string().max(30).optional().nullable(), at: z.coerce.date(),
      })).max(5000),
    }).parse(req.body);
    return tx(req, async (c) => {
      let n = 0;
      for (const p of b.positions) {
        const v = await one(c, 'SELECT id FROM vessels WHERE mmsi=$1 OR ($2::text IS NOT NULL AND imo=$2) LIMIT 1', [p.mmsi, p.imo ?? null]);
        await c.query(`INSERT INTO ais_positions (tenant_id, mmsi, vessel_id, lat, lon, sog, cog, nav_status, at, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (tenant_id, mmsi) DO UPDATE SET vessel_id=coalesce(EXCLUDED.vessel_id, ais_positions.vessel_id), lat=EXCLUDED.lat, lon=EXCLUDED.lon, sog=EXCLUDED.sog,
            cog=EXCLUDED.cog, nav_status=EXCLUDED.nav_status, at=EXCLUDED.at, source=EXCLUDED.source WHERE ais_positions.at <= EXCLUDED.at`,
          [req.actor.tenantId, p.mmsi, v?.id ?? null, p.lat, p.lon, p.sog ?? null, p.cog ?? null, p.navStatus ?? null, p.at, b.source]);
        n++;
      }
      // Remove stale targets from the same feed (left the area)
      await c.query(`DELETE FROM ais_positions WHERE tenant_id=$1 AND source=$2 AND at < now() - interval '15 minutes'`, [req.actor.tenantId, b.source]);
      return { accepted: n };
    });
  });

  // FR-GIS: map layers
  app.get('/gis/map', async (req) => tx(req, async (c) => ({
    port: await one(c, 'SELECT code, name, lat, lon FROM tenants WHERE id=$1', [req.actor.tenantId]),
    terminals: await many(c, 'SELECT id, code, name, type, lat, lon FROM terminals WHERE lat IS NOT NULL'),
    berths: await many(c, `SELECT b.id, b.code, b.name, b.lat, b.lon, b.length_m, b.depth_m, b.barge_berth,
        (SELECT json_build_object('callNo', vc.call_no, 'vessel', v.name, 'status', vc.status) FROM vessel_calls vc JOIN vessels v ON v.id=vc.vessel_id WHERE vc.berth_id=b.id AND vc.status IN ('BERTHED','DEPARTURE_REQUESTED','DEPARTURE_CLEARED') LIMIT 1) AS occupant
      FROM berths b WHERE b.lat IS NOT NULL`),
    vessels: await many(c, `SELECT a.mmsi, a.lat, a.lon, a.sog, a.cog, a.nav_status, a.at, a.source, coalesce(v.name, 'MMSI ' || a.mmsi) AS name, v.imo, v.type,
        (SELECT json_build_object('id', vc.id, 'callNo', vc.call_no, 'status', vc.status, 'eta', vc.eta) FROM vessel_calls vc WHERE vc.vessel_id=v.id AND vc.status NOT IN ('DEPARTED','CANCELLED','DRAFT') ORDER BY vc.eta LIMIT 1) AS call
      FROM ais_positions a LEFT JOIN vessels v ON v.id=a.vessel_id`),
  })));
}
