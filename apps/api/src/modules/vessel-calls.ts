// FR-VES + FR-SWN: vessel call lifecycle
// DRAFT → BERTH_REQUESTED → BERTH_ALLOCATED → PRE_ARRIVAL_SUBMITTED → (all agencies approve) ARRIVAL_CLEARED + port entry permit
// → ARRIVED → BERTHED → DEPARTURE_REQUESTED → (agencies approve) DEPARTURE_CLEARED → DEPARTED (→ invoice)
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { VESSEL_CALL_FLOW, FAL_FORMS, isValidImo, isValidUnlocode, type VesselCallStatus, type Agency } from '@pcs/shared';
import { one, many, insert, update, nextNo, type Db } from '../core/db.js';
import { tx, audit, emit, notify, requireRole, hasRole, isAuthority, getTenant, badRequest, notFound, forbidden, conflict, type Actor } from '../core/context.js';
import { openApprovals, onApprovalOutcome } from '../core/workflow.js';
import { generateInvoice } from './finance.js';

const CALL_SELECT = `
  SELECT vc.*, v.name AS vessel_name, v.imo, v.type AS vessel_type, v.flag, v.gt, v.loa, v.max_draft, v.mmsi, v.call_sign,
         ag.name AS agent_name, ln.name AS line_name, b.code AS berth_code, b.name AS berth_name,
         rb.code AS requested_berth_code, t.name AS terminal_name, t.code AS terminal_code
  FROM vessel_calls vc
  JOIN vessels v ON v.id = vc.vessel_id
  JOIN organisations ag ON ag.id = vc.agent_org_id
  LEFT JOIN organisations ln ON ln.id = vc.line_org_id
  LEFT JOIN berths b ON b.id = vc.berth_id
  LEFT JOIN berths rb ON rb.id = vc.requested_berth_id
  LEFT JOIN terminals t ON t.id = vc.terminal_id`;

/** Row-level visibility for commercial parties. Authorities see every call in their port. */
function scope(a: Actor, p: number) {
  if (isAuthority(a)) return { sql: 'TRUE', params: [] as unknown[] };
  return {
    sql: `(vc.agent_org_id = $${p} OR vc.line_org_id = $${p}
          OR vc.terminal_id IN (SELECT id FROM terminals WHERE operator_org_id = $${p})
          OR EXISTS (SELECT 1 FROM service_requests sr WHERE sr.call_id = vc.id AND sr.provider_org_id = $${p})
          OR (vc.status NOT IN ('DRAFT','CANCELLED') AND $${p + 1}))`,
    // hauliers / forwarders / barge & rail operators see the public port schedule (non-draft calls)
    params: [a.orgId, a.roles.some((r) => ['FREIGHT_FORWARDER', 'HAULIER', 'RAIL_OPERATOR', 'BARGE_OPERATOR', 'SERVICE_PROVIDER'].includes(r))],
  };
}

export async function loadCall(c: Db, a: Actor, id: string) {
  const s = scope(a, 2);
  const call = await one(c, `${CALL_SELECT} WHERE vc.id = $1 AND ${s.sql}`, [id, ...s.params]);
  if (!call) throw notFound('Vessel call not found');
  return call;
}

function isOwner(a: Actor, call: any) {
  return hasRole(a, 'PORT_ADMIN') || (a.orgId && (a.orgId === call.agent_org_id || a.orgId === call.line_org_id));
}

async function transition(c: Db, a: Actor, call: any, to: VesselCallStatus, patch: Record<string, unknown> = {}, note?: string) {
  if (!(VESSEL_CALL_FLOW[call.status as VesselCallStatus] ?? []).includes(to))
    throw conflict(`Cannot move vessel call from ${call.status} to ${to}`);
  const r = await update(c, 'vessel_calls', call.id, { ...patch, status: to, updated_at: new Date() });
  await audit(c, a, `VESSEL_CALL_${to}`, 'vessel_call', call.id, { from: call.status, to, note, ...patch });
  await emit(c, a.tenantId, `vessel_call.${to.toLowerCase()}`, 'vessel_call', call.id, { callNo: call.call_no, imo: call.imo, vessel: call.vessel_name, from: call.status, to, ...patch });
  return r;
}

async function agenciesFor(tenantId: string, stage: 'ARRIVAL' | 'DEPARTURE'): Promise<Agency[]> {
  const t = await getTenant(tenantId);
  const s: any = t.settings;
  return (stage === 'DEPARTURE' ? s.departureAgencies : null) ?? s.clearanceAgencies ?? ['HARBOUR_MASTER', 'CUSTOMS', 'IMMIGRATION', 'PORT_HEALTH'];
}

/** Check physical fit and berth-window conflicts. Returns a list of problems (empty = OK). */
async function checkBerth(c: Db, call: any, berthId: string, eta: Date, etd: Date) {
  const berth = await one(c, 'SELECT * FROM berths WHERE id=$1', [berthId]);
  if (!berth) throw badRequest('Unknown berth');
  const problems: string[] = [];
  if (call.loa && Number(call.loa) > Number(berth.length_m)) problems.push(`LOA ${call.loa} m exceeds berth length ${berth.length_m} m`);
  const draft = Number(call.arrival_draft ?? call.max_draft ?? 0);
  if (draft && draft > Number(berth.depth_m) - 0.5) problems.push(`Draft ${draft} m leaves under 0.5 m under-keel clearance at ${berth.depth_m} m`);
  const clashes = await many(
    c,
    `SELECT vc.call_no, v.name FROM vessel_calls vc JOIN vessels v ON v.id=vc.vessel_id
     WHERE vc.berth_id=$1 AND vc.id<>$2 AND vc.status NOT IN ('DRAFT','CANCELLED','DEPARTED')
       AND tstzrange(vc.eta, vc.etd) && tstzrange($3, $4)`,
    [berthId, call.id, eta, etd],
  );
  for (const x of clashes) problems.push(`Berth window overlaps ${x.call_no} (${x.name})`);
  return { berth, problems };
}

const callInput = z.object({
  vesselId: z.string().uuid().optional(),
  imo: z.string().optional(),
  lineOrgId: z.string().uuid().optional().nullable(),
  voyageIn: z.string().max(20).optional(),
  voyageOut: z.string().max(20).optional(),
  purpose: z.enum(['CARGO_OPERATIONS', 'BUNKERING_ONLY', 'CREW_CHANGE', 'REPAIRS', 'PASSENGERS', 'SHELTER', 'OTHER']).default('CARGO_OPERATIONS'),
  lastPort: z.string().refine(isValidUnlocode, 'Invalid UN/LOCODE').optional(),
  nextPort: z.string().refine(isValidUnlocode, 'Invalid UN/LOCODE').optional(),
  eta: z.coerce.date(),
  etd: z.coerce.date(),
  requestedBerthId: z.string().uuid().optional().nullable(),
  arrivalDraft: z.number().positive().max(25).optional(),
  crewCount: z.number().int().min(0).optional(),
  passengerCount: z.number().int().min(0).optional(),
  dangerousGoods: z.boolean().default(false),
  cargoSummary: z.string().max(1000).optional(),
});

export default async function vesselCalls(app: FastifyInstance) {
  app.get('/vessel-calls', async (req) => {
    const q = z.object({ status: z.string().optional(), search: z.string().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional(), limit: z.coerce.number().max(500).default(200) }).parse(req.query);
    const s = scope(req.actor, 6);
    return tx(req, (c) =>
      many(
        c,
        `${CALL_SELECT} WHERE ($1::text IS NULL OR vc.status = ANY(string_to_array($1, ',')))
           AND ($2::text IS NULL OR v.name ILIKE '%'||$2||'%' OR v.imo LIKE $2||'%' OR vc.call_no ILIKE '%'||$2||'%')
           AND ($3::timestamptz IS NULL OR vc.etd >= $3) AND ($4::timestamptz IS NULL OR vc.eta <= $4)
           AND ${s.sql}
         ORDER BY vc.eta DESC LIMIT $5`,
        [q.status ?? null, q.search ?? null, q.from ?? null, q.to ?? null, q.limit, ...s.params],
      ),
    );
  });

  app.get('/vessel-calls/:id', async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      const fal = await many(c, 'SELECT form_no, data, version, submitted_at FROM fal_forms WHERE call_id=$1 ORDER BY form_no', [id]);
      const approvals = await many(c, `SELECT ap.*, u.name AS decided_by_name FROM approvals ap LEFT JOIN users u ON u.id=ap.decided_by WHERE entity_type='vessel_call' AND entity_id=$1 ORDER BY stage, agency`, [id]);
      const services = await many(c, `SELECT sr.*, p.name AS provider_name FROM service_requests sr JOIN organisations p ON p.id=sr.provider_org_id WHERE call_id=$1 ORDER BY requested_for`, [id]);
      const manifests = await many(c, `SELECT m.*, (SELECT count(*) FROM bills_of_lading b WHERE b.manifest_id=m.id) AS bl_count, (SELECT count(*) FROM containers k JOIN bills_of_lading b ON b.id=k.bl_id WHERE b.manifest_id=m.id) AS container_count FROM manifests m WHERE call_id=$1`, [id]);
      const invoices = await many(c, `SELECT id, invoice_no, total, currency, status FROM invoices WHERE entity_type='vessel_call' AND entity_id=$1`, [id]);
      const t = await getTenant(req.actor.tenantId);
      return { ...call, fal, approvals, services, manifests, invoices, falRequired: (t.settings as any).falFormsRequired ?? [1, 2, 3, 5, 6, 7] };
    });
  });

  app.post('/vessel-calls', async (req) => {
    const a = req.actor;
    requireRole(a, 'SHIPPING_AGENT', 'SHIPPING_LINE');
    const b = callInput.parse(req.body);
    if (b.etd <= b.eta) throw badRequest('ETD must be after ETA');
    return tx(req, async (c) => {
      let vesselId = b.vesselId;
      if (!vesselId && b.imo) {
        if (!isValidImo(b.imo)) throw badRequest('Invalid IMO number');
        vesselId = (await one(c, 'SELECT id FROM vessels WHERE imo=$1', [b.imo]))?.id;
      }
      if (!vesselId) throw badRequest('Vessel not found — register it in reference data first');
      const callNo = await nextNo(c, a.tenantId, a.tenantCode, 'VC');
      const call = await insert(c, 'vessel_calls', {
        tenant_id: a.tenantId, call_no: callNo, vessel_id: vesselId, agent_org_id: a.orgId, line_org_id: b.lineOrgId ?? null,
        voyage_in: b.voyageIn, voyage_out: b.voyageOut, purpose: b.purpose, last_port: b.lastPort, next_port: b.nextPort,
        eta: b.eta, etd: b.etd, requested_berth_id: b.requestedBerthId ?? null, arrival_draft: b.arrivalDraft,
        crew_count: b.crewCount, passenger_count: b.passengerCount, dangerous_goods: b.dangerousGoods, cargo_summary: b.cargoSummary,
        created_by: a.userId,
      });
      await audit(c, a, 'VESSEL_CALL_CREATED', 'vessel_call', call.id, { callNo });
      await emit(c, a.tenantId, 'vessel_call.created', 'vessel_call', call.id, { callNo });
      return call;
    });
  });

  app.patch('/vessel-calls/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = callInput.partial().parse(req.body);
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      if (!isOwner(req.actor, call)) throw forbidden();
      if (['DEPARTED', 'CANCELLED', 'DEPARTURE_CLEARED'].includes(call.status)) throw conflict('Call can no longer be amended');
      const patch = {
        line_org_id: b.lineOrgId, voyage_in: b.voyageIn, voyage_out: b.voyageOut, purpose: b.purpose, last_port: b.lastPort, next_port: b.nextPort,
        eta: b.eta, etd: b.etd, requested_berth_id: b.requestedBerthId, arrival_draft: b.arrivalDraft, crew_count: b.crewCount,
        passenger_count: b.passengerCount, dangerous_goods: b.dangerousGoods, cargo_summary: b.cargoSummary, updated_at: new Date(),
      };
      const r = await update(c, 'vessel_calls', id, patch);
      await audit(c, req.actor, 'VESSEL_CALL_AMENDED', 'vessel_call', id, b);
      if (call.status !== 'DRAFT') await notify(c, req.actor.tenantId, { role: 'HARBOUR_MASTER' }, `Call amended: ${call.vessel_name}`, call.call_no, `/vessel-calls/${id}`);
      return r;
    });
  });

  // ---- Berthing request (FVBR) ----
  app.post('/vessel-calls/:id/berth-request', async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      if (!isOwner(req.actor, call)) throw forbidden();
      const r = await transition(c, req.actor, call, 'BERTH_REQUESTED');
      await notify(c, req.actor.tenantId, { role: 'HARBOUR_MASTER' }, `Berthing request: ${call.vessel_name}`, `${call.call_no} ETA ${new Date(call.eta).toISOString().slice(0, 16)}`, `/vessel-calls/${id}`, 'warning');
      return r;
    });
  });

  app.post('/vessel-calls/:id/berth-check', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ berthId: z.string().uuid(), eta: z.coerce.date().optional(), etd: z.coerce.date().optional() }).parse(req.body);
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      const { problems } = await checkBerth(c, call, b.berthId, b.eta ?? call.eta, b.etd ?? call.etd);
      return { ok: problems.length === 0, problems };
    });
  });

  app.post('/vessel-calls/:id/allocate-berth', async (req) => {
    requireRole(req.actor, 'HARBOUR_MASTER');
    const { id } = req.params as { id: string };
    const b = z.object({ berthId: z.string().uuid(), eta: z.coerce.date().optional(), etd: z.coerce.date().optional(), override: z.boolean().default(false), remarks: z.string().optional() }).parse(req.body);
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      const eta = b.eta ?? call.eta, etd = b.etd ?? call.etd;
      const { berth, problems } = await checkBerth(c, call, b.berthId, eta, etd);
      if (problems.length && !b.override) throw conflict(`Berth allocation blocked: ${problems.join('; ')}`);
      const r = await transition(c, req.actor, call, 'BERTH_ALLOCATED', { berth_id: berth.id, terminal_id: berth.terminal_id, eta, etd }, b.remarks ?? (problems.length ? `override: ${problems.join('; ')}` : undefined));
      await notify(c, req.actor.tenantId, { orgId: call.agent_org_id }, `Berth allocated: ${call.vessel_name}`, `${berth.code} ${berth.name}. Submit pre-arrival documents to obtain clearance.`, `/vessel-calls/${id}`, 'success');
      if (berth.terminal_id) {
        const t = await one(c, 'SELECT operator_org_id FROM terminals WHERE id=$1', [berth.terminal_id]);
        await notify(c, req.actor.tenantId, { orgId: t?.operator_org_id }, `Vessel allocated to your berth: ${call.vessel_name}`, `${berth.code} — ETA ${new Date(eta).toISOString().slice(0, 16)}`, `/vessel-calls/${id}`);
      }
      return r;
    });
  });

  app.post('/vessel-calls/:id/reject-berth-request', async (req) => {
    requireRole(req.actor, 'HARBOUR_MASTER');
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      const r = await transition(c, req.actor, call, 'DRAFT', {}, reason);
      await notify(c, req.actor.tenantId, { orgId: call.agent_org_id }, `Berthing request returned: ${call.vessel_name}`, reason, `/vessel-calls/${id}`, 'warning');
      return r;
    });
  });

  // ---- FAL forms (IMO FAL 1–7) ----
  app.put('/vessel-calls/:id/fal/:formNo', async (req) => {
    const { id, formNo } = req.params as { id: string; formNo: string };
    const n = Number(formNo);
    if (!FAL_FORMS.some((f) => f.no === n)) throw badRequest('FAL form must be 1–7');
    const data = z.record(z.string(), z.any()).parse(req.body);
    validateFal(n, data);
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      if (!isOwner(req.actor, call)) throw forbidden();
      if (['DEPARTED', 'CANCELLED'].includes(call.status)) throw conflict('Call is closed');
      const r = await one(
        c,
        `INSERT INTO fal_forms (tenant_id, call_id, form_no, data, submitted_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (call_id, form_no) DO UPDATE SET data=EXCLUDED.data, version=fal_forms.version+1, submitted_at=now(), submitted_by=EXCLUDED.submitted_by
         RETURNING form_no, version, submitted_at`,
        [req.actor.tenantId, id, n, JSON.stringify(data), req.actor.userId],
      );
      await audit(c, req.actor, `FAL${n}_SUBMITTED`, 'vessel_call', id, { version: r.version });
      if (n === 5 && Array.isArray(data.crew)) await update(c, 'vessel_calls', id, { crew_count: data.crew.length });
      if (n === 6 && Array.isArray(data.passengers)) await update(c, 'vessel_calls', id, { passenger_count: data.passengers.length });
      if (n === 7) await update(c, 'vessel_calls', id, { dangerous_goods: Array.isArray(data.items) && data.items.length > 0 });
      return r;
    });
  });

  // ---- Pre-arrival notification → multi-agency arrival clearance (FVPAN / FVVAC) ----
  app.post('/vessel-calls/:id/pre-arrival', async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      if (!isOwner(req.actor, call)) throw forbidden();
      const t = await getTenant(req.actor.tenantId);
      const required: number[] = (t.settings as any).falFormsRequired ?? [1, 2, 3, 5, 6, 7];
      const have = new Set((await many(c, 'SELECT form_no FROM fal_forms WHERE call_id=$1', [id])).map((r) => r.form_no));
      const missing = required.filter((n) => !have.has(n) && !(n === 6 && !call.passenger_count) && !(n === 7 && !call.dangerous_goods));
      if (missing.length) throw badRequest(`Missing FAL forms: ${missing.map((n) => `FAL ${n}`).join(', ')}`);
      const r = await transition(c, req.actor, call, 'PRE_ARRIVAL_SUBMITTED');
      await openApprovals(c, req.actor.tenantId, 'vessel_call', id, 'ARRIVAL', await agenciesFor(req.actor.tenantId, 'ARRIVAL'), `${call.vessel_name} (${call.call_no})`, `/vessel-calls/${id}`);
      return r;
    });
  });

  app.post('/vessel-calls/:id/respond-query', async (req) => {
    const { id } = req.params as { id: string };
    const { response } = z.object({ response: z.string().min(2) }).parse(req.body);
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      if (!isOwner(req.actor, call)) throw forbidden();
      const q = await many(c, `UPDATE approvals SET status='PENDING' WHERE entity_type='vessel_call' AND entity_id=$1 AND status='QUERY' RETURNING agency`, [id]);
      if (!q.length) throw conflict('No open queries');
      await insert(c, 'comments', { tenant_id: req.actor.tenantId, entity_type: 'vessel_call', entity_id: id, user_id: req.actor.userId, author: req.actor.name, body: `Query response: ${response}` });
      for (const x of q) await notify(c, req.actor.tenantId, { role: x.agency }, `Query answered: ${call.vessel_name}`, response, `/vessel-calls/${id}`);
      await audit(c, req.actor, 'QUERY_RESPONDED', 'vessel_call', id, { response });
      return { reopened: q.map((x) => x.agency) };
    });
  });

  // ---- Movements ----
  app.post('/vessel-calls/:id/arrived', async (req) => {
    requireRole(req.actor, 'HARBOUR_MASTER', 'SHIPPING_AGENT');
    const { id } = req.params as { id: string };
    const { at } = z.object({ at: z.coerce.date().default(() => new Date()) }).parse(req.body ?? {});
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      return transition(c, req.actor, call, 'ARRIVED', { ata: at });
    });
  });

  app.post('/vessel-calls/:id/berthed', async (req) => {
    requireRole(req.actor, 'HARBOUR_MASTER', 'TERMINAL_OPERATOR');
    const { id } = req.params as { id: string };
    const { at } = z.object({ at: z.coerce.date().default(() => new Date()) }).parse(req.body ?? {});
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      const r = await transition(c, req.actor, call, 'BERTHED', { berthed_at: at });
      await notify(c, req.actor.tenantId, { orgId: call.agent_org_id }, `All fast: ${call.vessel_name}`, `Berthed at ${call.berth_code}`, `/vessel-calls/${id}`);
      return r;
    });
  });

  app.post('/vessel-calls/:id/departure-request', async (req) => {
    const { id } = req.params as { id: string };
    const { etd } = z.object({ etd: z.coerce.date().optional() }).parse(req.body ?? {});
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      if (!isOwner(req.actor, call)) throw forbidden();
      const r = await transition(c, req.actor, call, 'DEPARTURE_REQUESTED', etd ? { etd } : {});
      await openApprovals(c, req.actor.tenantId, 'vessel_call', id, 'DEPARTURE', await agenciesFor(req.actor.tenantId, 'DEPARTURE'), `${call.vessel_name} departure`, `/vessel-calls/${id}`);
      return r;
    });
  });

  app.post('/vessel-calls/:id/departed', async (req) => {
    requireRole(req.actor, 'HARBOUR_MASTER');
    const { id } = req.params as { id: string };
    const { at } = z.object({ at: z.coerce.date().default(() => new Date()) }).parse(req.body ?? {});
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      const r = await transition(c, req.actor, call, 'DEPARTED', { atd: at });
      const inv = await generateInvoice(c, req.actor, 'vessel_call', id).catch((e) => ({ error: String(e.message ?? e) }));
      return { ...r, invoice: inv };
    });
  });

  app.post('/vessel-calls/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      if (!isOwner(req.actor, call) && !hasRole(req.actor, 'HARBOUR_MASTER')) throw forbidden();
      await c.query(`UPDATE approvals SET status='REJECTED', remarks='Call cancelled' WHERE entity_type='vessel_call' AND entity_id=$1 AND status='PENDING'`, [id]);
      return transition(c, req.actor, call, 'CANCELLED', {}, reason);
    });
  });

  // ---- Port entry permit / departure clearance documents ----
  app.get('/vessel-calls/:id/permit', async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const call = await loadCall(c, req.actor, id);
      if (!call.entry_permit_no) throw conflict('Port entry permit not yet granted');
      const approvals = await many(c, `SELECT agency, status, decided_at, remarks FROM approvals WHERE entity_type='vessel_call' AND entity_id=$1 AND stage='ARRIVAL'`, [id]);
      const t = await getTenant(req.actor.tenantId);
      return { port: t.name, portCode: t.code, permitNo: call.entry_permit_no, grantedAt: call.entry_permit_at, call, approvals, verifyUrl: `/verify/permit/${call.entry_permit_no}` };
    });
  });

  // ---- Berth schedule (Gantt) ----
  app.get('/berth-schedule', async (req) => {
    const q = z.object({ from: z.coerce.date().default(() => new Date(Date.now() - 2 * 864e5)), to: z.coerce.date().default(() => new Date(Date.now() + 10 * 864e5)) }).parse(req.query);
    return tx(req, async (c) => ({
      berths: await many(c, `SELECT b.id, b.code, b.name, b.length_m, b.depth_m, t.name AS terminal_name FROM berths b LEFT JOIN terminals t ON t.id=b.terminal_id WHERE NOT b.barge_berth ORDER BY b.code`),
      calls: await many(c, `${CALL_SELECT} WHERE vc.status NOT IN ('DRAFT','CANCELLED') AND vc.etd >= $1 AND vc.eta <= $2 ORDER BY vc.eta`, [q.from, q.to]),
    }));
  });

  // Approval outcomes from the Single Window engine
  onApprovalOutcome('vessel_call', async (c, a, id, stage, outcome) => {
    const call = await one(c, `${CALL_SELECT} WHERE vc.id=$1`, [id]);
    if (!call) return;
    const link = `/vessel-calls/${id}`;
    if (stage === 'ARRIVAL') {
      if (outcome === 'APPROVED') {
        const permitNo = await nextNo(c, a.tenantId, a.tenantCode, 'PEP');
        await transition(c, a, call, 'ARRIVAL_CLEARED', { entry_permit_no: permitNo, entry_permit_at: new Date() });
        await notify(c, a.tenantId, { orgId: call.agent_org_id }, `Port entry permit granted: ${call.vessel_name}`, permitNo, link, 'success');
        await notify(c, a.tenantId, { role: 'HARBOUR_MASTER' }, `Arrival cleared: ${call.vessel_name}`, permitNo, link, 'success');
      } else if (outcome === 'REJECTED') {
        await transition(c, a, call, 'BERTH_ALLOCATED', {}, 'arrival clearance rejected');
        await notify(c, a.tenantId, { orgId: call.agent_org_id }, `Arrival clearance rejected: ${call.vessel_name}`, 'Amend the pre-arrival documents and resubmit', link, 'critical');
      } else {
        await notify(c, a.tenantId, { orgId: call.agent_org_id }, `Agency query: ${call.vessel_name}`, 'An agency has raised a query on the pre-arrival notification', link, 'warning');
      }
    } else if (stage === 'DEPARTURE') {
      if (outcome === 'APPROVED') {
        const no = await nextNo(c, a.tenantId, a.tenantCode, 'PDC');
        await transition(c, a, call, 'DEPARTURE_CLEARED', { departure_clearance_no: no });
        await notify(c, a.tenantId, { orgId: call.agent_org_id }, `Departure cleared: ${call.vessel_name}`, no, link, 'success');
        await notify(c, a.tenantId, { role: 'HARBOUR_MASTER' }, `Departure cleared: ${call.vessel_name}`, no, link);
      } else if (outcome === 'REJECTED') {
        await transition(c, a, call, 'BERTHED', {}, 'departure clearance rejected');
        await notify(c, a.tenantId, { orgId: call.agent_org_id }, `Departure clearance rejected: ${call.vessel_name}`, undefined, link, 'critical');
      } else {
        await notify(c, a.tenantId, { orgId: call.agent_org_id }, `Agency query on departure: ${call.vessel_name}`, undefined, link, 'warning');
      }
    }
  });
}

function validateFal(n: number, d: Record<string, any>) {
  const need = (k: string) => { if (d[k] === undefined || d[k] === '' || d[k] === null) throw badRequest(`FAL ${n}: ${k} is required`); };
  const list = (k: string, fields: string[]) => {
    if (!Array.isArray(d[k])) throw badRequest(`FAL ${n}: ${k} must be a list`);
    d[k].forEach((row: any, i: number) => fields.forEach((f) => { if (!row?.[f]) throw badRequest(`FAL ${n}: ${k}[${i + 1}].${f} is required`); }));
  };
  if (n === 1) ['masterName', 'portOfArrival', 'lastPortOfCall', 'briefCargoDescription'].forEach(need);
  if (n === 2) list('items', ['blNo', 'description', 'packages']);
  if (n === 3) list('stores', ['article', 'quantity']);
  if (n === 4) list('effects', ['crewName', 'description']);
  if (n === 5) list('crew', ['familyName', 'givenNames', 'rank', 'nationality', 'idDocNo']);
  if (n === 6) list('passengers', ['familyName', 'givenNames', 'nationality', 'idDocNo']);
  if (n === 7) list('items', ['unNumber', 'properShippingName', 'class', 'quantity']);
}
