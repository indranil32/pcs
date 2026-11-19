// FR-CGO / FR-CON / FR-CUS: manifests, bills of lading, containers, customs status exchange, holds, tracking
// System boundary: PCS carries the customs *status* (from the national customs system via adapter, or from customs users);
// declaration assessment stays in the Customs Management System. Yard planning stays in the TOS.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CUSTOMS_STATUS, CONTAINER_STATUS, isValidContainerNo, isValidUnlocode } from '@pcs/shared';
import { one, many, insert, update, type Db } from '../core/db.js';
import { tx, audit, emit, notify, requireRole, hasRole, isAuthority, badRequest, notFound, forbidden, conflict, type Actor } from '../core/context.js';
import { loadCall } from './vessel-calls.js';

const containerIn = z.object({
  containerNo: z.string().transform((s) => s.replace(/\s|-/g, '').toUpperCase()).refine(isValidContainerNo, 'Invalid ISO 6346 container number'),
  isoType: z.string().max(4).optional(),
  sealNo: z.string().optional(),
  grossKg: z.number().nonnegative().optional(),
  fullEmpty: z.enum(['F', 'E']).default('F'),
});
const blIn = z.object({
  blNo: z.string().min(3).max(35),
  shipper: z.string().optional(), consignee: z.string().optional(), notifyParty: z.string().optional(),
  consigneeOrgId: z.string().uuid().optional().nullable(), forwarderOrgId: z.string().uuid().optional().nullable(),
  pol: z.string().refine(isValidUnlocode, 'Invalid UN/LOCODE').optional(), pod: z.string().refine(isValidUnlocode, 'Invalid UN/LOCODE').optional(),
  description: z.string().optional(), hsCode: z.string().regex(/^\d{4,10}$/, 'HS code must be 4–10 digits').optional(),
  packages: z.number().int().nonnegative().optional(), grossKg: z.number().nonnegative().optional(),
  containers: z.array(containerIn).default([]),
});
export const manifestIn = z.object({ direction: z.enum(['IMPORT', 'EXPORT']), bls: z.array(blIn).min(1) });

const BL_SCOPE = (p: number) => `($${p} OR b.forwarder_org_id=$${p + 1} OR b.consignee_org_id=$${p + 1} OR m.submitted_by_org=$${p + 1}
  OR vc.agent_org_id=$${p + 1} OR vc.line_org_id=$${p + 1} OR vc.terminal_id IN (SELECT id FROM terminals WHERE operator_org_id=$${p + 1}))`;

/** Create or amend the manifest for a call. Shared by the UI/API and the EDI CUSCAR handler. */
export async function upsertManifest(c: Db, a: Actor, callId: string, body: z.infer<typeof manifestIn>, source: 'UI' | 'API' | 'EDI') {
  const call = await one(c, 'SELECT * FROM vessel_calls WHERE id=$1', [callId]);
  if (!call) throw notFound('Vessel call not found');
  if (['CANCELLED', 'DRAFT'].includes(call.status)) throw conflict('Submit the berthing request before the manifest');
  const seen = new Set<string>();
  for (const b of body.bls) for (const k of b.containers) {
    if (seen.has(k.containerNo)) throw badRequest(`Container ${k.containerNo} appears twice`);
    seen.add(k.containerNo);
  }
  let m = await one(c, 'SELECT * FROM manifests WHERE call_id=$1 AND direction=$2', [callId, body.direction]);
  if (m) {
    const locked = await one(c, `SELECT bl_no FROM bills_of_lading WHERE manifest_id=$1 AND customs_status IN ('RELEASED','UNDER_INSPECTION') LIMIT 1`, [m.id]);
    if (locked) throw conflict(`B/L ${locked.bl_no} is already under customs control — amend individual B/Ls with customs`);
    await c.query('DELETE FROM bills_of_lading WHERE manifest_id=$1', [m.id]);
    m = await update(c, 'manifests', m.id, { version: m.version + 1, status: 'AMENDED', source });
  } else {
    m = await insert(c, 'manifests', { tenant_id: a.tenantId, call_id: callId, direction: body.direction, submitted_by_org: a.orgId ?? call.agent_org_id, source });
  }
  let containers = 0;
  for (const b of body.bls) {
    const bl = await insert(c, 'bills_of_lading', {
      tenant_id: a.tenantId, manifest_id: m.id, bl_no: b.blNo, shipper: b.shipper, consignee: b.consignee, notify_party: b.notifyParty,
      consignee_org_id: b.consigneeOrgId ?? null, forwarder_org_id: b.forwarderOrgId ?? null, pol: b.pol, pod: b.pod,
      description: b.description, hs_code: b.hsCode, packages: b.packages, gross_kg: b.grossKg,
    });
    for (const k of b.containers) {
      await insert(c, 'containers', {
        tenant_id: a.tenantId, bl_id: bl.id, call_id: callId, container_no: k.containerNo, iso_type: k.isoType, seal_no: k.sealNo,
        gross_kg: k.grossKg, full_empty: k.fullEmpty, terminal_id: call.terminal_id, status: body.direction === 'IMPORT' ? 'ON_VESSEL' : 'GATED_IN',
        holds: body.direction === 'IMPORT' && k.fullEmpty === 'F' ? ['CUSTOMS'] : [],
      });
      containers++;
    }
    if (b.forwarderOrgId) await notify(c, a.tenantId, { orgId: b.forwarderOrgId }, `B/L ${b.blNo} manifested`, `Vessel call ${call.call_no}`, '/cargo');
  }
  await audit(c, a, m.version > 1 ? 'MANIFEST_AMENDED' : 'MANIFEST_SUBMITTED', 'manifest', m.id, { callId, direction: body.direction, bls: body.bls.length, containers, source });
  await emit(c, a.tenantId, 'manifest.submitted', 'manifest', m.id, { callNo: call.call_no, direction: body.direction, version: m.version, bls: body.bls.length, containers });
  await notify(c, a.tenantId, { role: 'CUSTOMS' }, `${body.direction} manifest ${m.version > 1 ? 'amended' : 'received'}`, `${call.call_no}: ${body.bls.length} B/L, ${containers} containers`, `/vessel-calls/${callId}`);
  return { ...m, bls: body.bls.length, containers };
}

/** Apply a container movement from the TOS (UI, API or EDI CODECO/COARRI). */
export async function applyContainerEvent(c: Db, a: Actor, containerNo: string, event: string, at: Date, source: string, location?: string) {
  const k = await one(c, `SELECT * FROM containers WHERE container_no=$1 ORDER BY updated_at DESC LIMIT 1`, [containerNo]);
  if (!k) throw notFound(`Container ${containerNo} not known to PCS`);
  const patch: Record<string, unknown> = { status: event, updated_at: new Date() };
  if (event === 'DISCHARGED') patch.discharged_at = at;
  if (event === 'GATED_OUT') patch.gated_out_at = at;
  if (event === 'GATED_IN') patch.gated_in_at = at;
  if (event === 'LOADED') patch.loaded_at = at;
  await update(c, 'containers', k.id, patch);
  await insert(c, 'container_events', { tenant_id: a.tenantId, container_id: k.id, event, location, source, at });
  await emit(c, a.tenantId, `container.${event.toLowerCase()}`, 'container', k.id, { containerNo, event, at, source });
  return k;
}

export default async function cargo(app: FastifyInstance) {
  app.post('/vessel-calls/:id/manifests', async (req) => {
    requireRole(req.actor, 'SHIPPING_AGENT', 'SHIPPING_LINE');
    const { id } = req.params as { id: string };
    const b = manifestIn.parse(req.body);
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      if (req.actor.orgId !== call.agent_org_id && req.actor.orgId !== call.line_org_id && !hasRole(req.actor, 'PORT_ADMIN')) throw forbidden();
      return upsertManifest(c, req.actor, id, b, req.actor.apiKeyId ? 'API' : 'UI');
    });
  });

  app.get('/manifests/:id', async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const m = await one(c, `SELECT m.*, vc.call_no, v.name AS vessel_name FROM manifests m JOIN vessel_calls vc ON vc.id=m.call_id JOIN vessels v ON v.id=vc.vessel_id WHERE m.id=$1`, [id]);
      if (!m) throw notFound();
      const bls = await many(c, `SELECT b.*, (SELECT json_agg(k ORDER BY k.container_no) FROM containers k WHERE k.bl_id=b.id) AS containers FROM bills_of_lading b WHERE manifest_id=$1 ORDER BY bl_no`, [id]);
      return { ...m, bls };
    });
  });

  app.get('/bls', async (req) => {
    const q = z.object({ search: z.string().optional(), customsStatus: z.string().optional(), callId: z.string().uuid().optional() }).parse(req.query);
    return tx(req, (c) => many(c, `SELECT b.*, m.direction, vc.call_no, vc.id AS call_id, v.name AS vessel_name, f.name AS forwarder_name,
        (SELECT count(*) FROM containers k WHERE k.bl_id=b.id) AS container_count,
        (SELECT d.status FROM delivery_orders d WHERE d.bl_id=b.id ORDER BY d.created_at DESC LIMIT 1) AS do_status
      FROM bills_of_lading b JOIN manifests m ON m.id=b.manifest_id JOIN vessel_calls vc ON vc.id=m.call_id JOIN vessels v ON v.id=vc.vessel_id
      LEFT JOIN organisations f ON f.id=b.forwarder_org_id
      WHERE ${BL_SCOPE(1)} AND ($3::text IS NULL OR b.bl_no ILIKE '%'||$3||'%' OR b.consignee ILIKE '%'||$3||'%' OR b.declaration_no ILIKE '%'||$3||'%'
        OR EXISTS (SELECT 1 FROM containers k WHERE k.bl_id=b.id AND k.container_no LIKE upper($3)||'%'))
        AND ($4::text IS NULL OR b.customs_status=$4) AND ($5::uuid IS NULL OR m.call_id=$5)
      ORDER BY b.created_at DESC LIMIT 300`, [isAuthority(req.actor), req.actor.orgId, q.search ?? null, q.customsStatus ?? null, q.callId ?? null]));
  });

  app.get('/bls/:id', async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const bl = await one(c, `SELECT b.*, m.direction, m.submitted_by_org, vc.call_no, vc.id AS call_id, vc.agent_org_id, vc.line_org_id, v.name AS vessel_name, f.name AS forwarder_name
        FROM bills_of_lading b JOIN manifests m ON m.id=b.manifest_id JOIN vessel_calls vc ON vc.id=m.call_id JOIN vessels v ON v.id=vc.vessel_id
        LEFT JOIN organisations f ON f.id=b.forwarder_org_id WHERE b.id=$3 AND ${BL_SCOPE(1)}`, [isAuthority(req.actor), req.actor.orgId, id]);
      if (!bl) throw notFound();
      return {
        ...bl,
        containers: await many(c, 'SELECT * FROM containers WHERE bl_id=$1 ORDER BY container_no', [id]),
        deliveryOrders: await many(c, `SELECT d.*, h.name AS haulier_name FROM delivery_orders d LEFT JOIN organisations h ON h.id=d.haulier_org_id WHERE bl_id=$1 ORDER BY created_at DESC`, [id]),
      };
    });
  });

  // Forwarder records the declaration lodged in the customs system (PCS does not assess declarations)
  app.post('/bls/:id/declaration', async (req) => {
    requireRole(req.actor, 'FREIGHT_FORWARDER', 'SHIPPING_AGENT');
    const { id } = req.params as { id: string };
    const b = z.object({ declarationNo: z.string().min(3) }).parse(req.body);
    return tx(req, async (c) => {
      const bl = await one(c, 'SELECT * FROM bills_of_lading WHERE id=$1', [id]);
      if (!bl) throw notFound();
      if (!['NOT_DECLARED', 'DECLARED'].includes(bl.customs_status)) throw conflict(`B/L is ${bl.customs_status}`);
      if (!bl.forwarder_org_id && req.actor.orgId) await update(c, 'bills_of_lading', id, { forwarder_org_id: req.actor.orgId });
      const r = await update(c, 'bills_of_lading', id, { declaration_no: b.declarationNo, customs_status: 'DECLARED', declared_at: new Date() });
      await audit(c, req.actor, 'DECLARATION_LINKED', 'bill_of_lading', id, b);
      await emit(c, req.actor.tenantId, 'bl.declared', 'bill_of_lading', id, { blNo: bl.bl_no, declarationNo: b.declarationNo });
      await notify(c, req.actor.tenantId, { role: 'CUSTOMS' }, `Declaration ${b.declarationNo} linked`, `B/L ${bl.bl_no}`, '/cargo');
      return r;
    });
  });

  // Customs status update: customs officer in PCS, or the customs system via API key / CUSRES
  app.post('/bls/:id/customs-status', async (req) => {
    requireRole(req.actor, 'CUSTOMS');
    const { id } = req.params as { id: string };
    const b = z.object({ status: z.enum(CUSTOMS_STATUS), declarationNo: z.string().optional(), remarks: z.string().optional() }).parse(req.body);
    return tx(req, (c) => setCustomsStatus(c, req.actor, id, b.status, b.declarationNo, b.remarks));
  });

  app.get('/containers', async (req) => {
    const q = z.object({ search: z.string().optional(), status: z.string().optional(), terminalId: z.string().uuid().optional() }).parse(req.query);
    return tx(req, (c) => many(c, `SELECT k.*, b.bl_no, b.customs_status, vc.call_no, v.name AS vessel_name, t.code AS terminal_code,
        CASE WHEN k.discharged_at IS NOT NULL THEN round(extract(epoch FROM (coalesce(k.gated_out_at, now()) - k.discharged_at))/86400, 1) END AS dwell_days
      FROM containers k LEFT JOIN bills_of_lading b ON b.id=k.bl_id LEFT JOIN manifests m ON m.id=b.manifest_id
      LEFT JOIN vessel_calls vc ON vc.id=k.call_id LEFT JOIN vessels v ON v.id=vc.vessel_id LEFT JOIN terminals t ON t.id=k.terminal_id
      WHERE ${BL_SCOPE(1)} AND ($3::text IS NULL OR k.container_no LIKE upper($3)||'%' OR b.bl_no ILIKE $3||'%')
        AND ($4::text IS NULL OR k.status=$4) AND ($5::uuid IS NULL OR k.terminal_id=$5)
      ORDER BY k.updated_at DESC LIMIT 300`, [isAuthority(req.actor), req.actor.orgId, q.search ?? null, q.status ?? null, q.terminalId ?? null]));
  });

  app.get('/containers/track/:no', async (req) => {
    const { no } = req.params as { no: string };
    return tx(req, async (c) => {
      const k = await one(c, `SELECT k.*, b.bl_no, b.customs_status, b.declaration_no, vc.call_no, v.name AS vessel_name, t.name AS terminal_name
        FROM containers k LEFT JOIN bills_of_lading b ON b.id=k.bl_id LEFT JOIN vessel_calls vc ON vc.id=k.call_id LEFT JOIN vessels v ON v.id=vc.vessel_id LEFT JOIN terminals t ON t.id=k.terminal_id
        WHERE k.container_no=$1 ORDER BY k.updated_at DESC LIMIT 1`, [no.toUpperCase()]);
      if (!k) throw notFound('Container not found');
      const events = await many(c, 'SELECT event, location, source, at FROM container_events WHERE container_id=$1 ORDER BY at', [k.id]);
      const gate = await many(c, 'SELECT direction, truck_plate, result, reason, at FROM gate_events WHERE container_no=$1 ORDER BY at', [k.container_no]);
      return { ...k, events, gate };
    });
  });

  app.post('/containers/events', async (req) => {
    requireRole(req.actor, 'TERMINAL_OPERATOR');
    const b = z.object({ containerNo: z.string(), event: z.enum(CONTAINER_STATUS), at: z.coerce.date().default(() => new Date()), location: z.string().optional() }).parse(req.body);
    return tx(req, async (c) => {
      await applyContainerEvent(c, req.actor, b.containerNo.toUpperCase(), b.event, b.at, req.actor.apiKeyId ? 'API' : 'UI', b.location);
      return { ok: true };
    });
  });

  app.post('/containers/:id/holds', async (req) => {
    requireRole(req.actor, 'CUSTOMS', 'PORT_HEALTH', 'HARBOUR_MASTER', 'TERMINAL_OPERATOR', 'BORDER_POLICE');
    const { id } = req.params as { id: string };
    const b = z.object({ hold: z.string().min(2).max(30), action: z.enum(['ADD', 'REMOVE']), reason: z.string().optional() }).parse(req.body);
    return tx(req, async (c) => {
      const k = await one(c, 'SELECT * FROM containers WHERE id=$1', [id]);
      if (!k) throw notFound();
      const holds: string[] = b.action === 'ADD' ? Array.from(new Set([...k.holds, b.hold])) : k.holds.filter((h: string) => h !== b.hold);
      const r = await update(c, 'containers', id, { holds, updated_at: new Date() });
      await audit(c, req.actor, `HOLD_${b.action}`, 'container', id, b);
      await emit(c, req.actor.tenantId, 'container.hold_changed', 'container', id, { containerNo: k.container_no, holds });
      return r;
    });
  });
}

export async function setCustomsStatus(c: Db, a: Actor, blId: string, status: string, declarationNo?: string, remarks?: string) {
  const bl = await one(c, `SELECT b.*, vc.agent_org_id, vc.line_org_id FROM bills_of_lading b JOIN manifests m ON m.id=b.manifest_id JOIN vessel_calls vc ON vc.id=m.call_id WHERE b.id=$1`, [blId]);
  if (!bl) throw notFound('B/L not found');
  const patch: Record<string, unknown> = { customs_status: status };
  if (declarationNo) patch.declaration_no = declarationNo;
  if (status === 'DECLARED' && !bl.declared_at) patch.declared_at = new Date();
  if (status === 'RELEASED') { patch.released_at = new Date(); if (!bl.declared_at) patch.declared_at = new Date(); }
  const r = await update(c, 'bills_of_lading', blId, patch);
  if (status === 'RELEASED') await c.query(`UPDATE containers SET holds = array_remove(holds, 'CUSTOMS'), updated_at=now() WHERE bl_id=$1`, [blId]);
  if (status === 'HELD' || status === 'UNDER_INSPECTION') await c.query(`UPDATE containers SET holds = array(SELECT DISTINCT unnest(holds || ARRAY['CUSTOMS'])), updated_at=now() WHERE bl_id=$1`, [blId]);
  await audit(c, a, `CUSTOMS_${status}`, 'bill_of_lading', blId, { declarationNo, remarks });
  await emit(c, a.tenantId, 'bl.customs_status', 'bill_of_lading', blId, { blNo: bl.bl_no, status, declarationNo: declarationNo ?? bl.declaration_no });
  const sev = status === 'RELEASED' ? 'success' : status === 'HELD' ? 'critical' : 'info';
  for (const org of [bl.forwarder_org_id, bl.consignee_org_id, bl.line_org_id ?? bl.agent_org_id]) if (org) await notify(c, a.tenantId, { orgId: org }, `Customs: B/L ${bl.bl_no} ${status.replace('_', ' ').toLowerCase()}`, remarks, '/cargo', sev);
  return r;
}
