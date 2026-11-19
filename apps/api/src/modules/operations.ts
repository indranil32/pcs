// FR-MKT / FR-VAS: marine services marketplace; FR-TRS: barge (inland waterway) and rail operations
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SERVICE_TYPES, SERVICE_FLOW, BARGE_FLOW, RAIL_FLOW, isValidEni, isValidContainerNo, type Transitions } from '@pcs/shared';
import { one, many, insert, update, nextNo, type Db } from '../core/db.js';
import { tx, audit, emit, notify, requireRole, hasRole, isAuthority, badRequest, notFound, forbidden, conflict, type Actor } from '../core/context.js';
import { generateInvoice } from './finance.js';
import { applyContainerEvent } from './cargo.js';

async function move(c: Db, a: Actor, table: string, entity: string, flow: Transitions<any>, row: any, to: string, patch: Record<string, unknown> = {}) {
  if (!(flow[row.status] ?? []).includes(to)) throw conflict(`Cannot move from ${row.status} to ${to}`);
  const r = await update(c, table, row.id, { ...patch, status: to });
  await audit(c, a, `${entity.toUpperCase()}_${to}`, entity, row.id, patch);
  await emit(c, a.tenantId, `${entity}.${to.toLowerCase()}`, entity, row.id, { ...patch, from: row.status, to });
  return r;
}

export default async function operations(app: FastifyInstance) {
  // ================= Services marketplace =================
  app.get('/service-offerings', async (req) => {
    const q = z.object({ serviceType: z.string().optional() }).parse(req.query);
    return tx(req, (c) => many(c, `SELECT so.*, o.name AS provider_name FROM service_offerings so JOIN organisations o ON o.id=so.org_id WHERE so.active AND o.status='ACTIVE' AND ($1::text IS NULL OR so.service_type=$1) ORDER BY so.service_type, so.unit_price`, [q.serviceType ?? null]));
  });

  app.post('/service-offerings', async (req) => {
    requireRole(req.actor, 'SERVICE_PROVIDER');
    const b = z.object({ serviceType: z.enum(SERVICE_TYPES), description: z.string().optional(), unit: z.string().default('JOB'), unitPrice: z.number().nonnegative(), currency: z.string().length(3) }).parse(req.body);
    return tx(req, (c) => insert(c, 'service_offerings', { tenant_id: req.actor.tenantId, org_id: req.actor.orgId, service_type: b.serviceType, description: b.description, unit: b.unit, unit_price: b.unitPrice, currency: b.currency }));
  });

  app.patch('/service-offerings/:id', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ description: z.string().optional(), unitPrice: z.number().nonnegative().optional(), active: z.boolean().optional() }).parse(req.body);
    return tx(req, async (c) => {
      const o = await one(c, 'SELECT * FROM service_offerings WHERE id=$1', [id]);
      if (!o || o.org_id !== req.actor.orgId) throw notFound();
      return update(c, 'service_offerings', id, { description: b.description, unit_price: b.unitPrice, active: b.active });
    });
  });

  app.get('/service-requests', async (req) => {
    const q = z.object({ status: z.string().optional(), callId: z.string().uuid().optional() }).parse(req.query);
    const a = req.actor;
    return tx(req, (c) => many(c, `SELECT sr.*, p.name AS provider_name, r.name AS requester_name, vc.call_no, v.name AS vessel_name
      FROM service_requests sr JOIN organisations p ON p.id=sr.provider_org_id JOIN organisations r ON r.id=sr.requester_org_id
      LEFT JOIN vessel_calls vc ON vc.id=sr.call_id LEFT JOIN vessels v ON v.id=vc.vessel_id
      WHERE ($1 OR sr.provider_org_id=$2 OR sr.requester_org_id=$2) AND ($3::text IS NULL OR sr.status=$3) AND ($4::uuid IS NULL OR sr.call_id=$4)
      ORDER BY sr.requested_for DESC LIMIT 300`, [isAuthority(a), a.orgId, q.status ?? null, q.callId ?? null]));
  });

  app.post('/service-requests', async (req) => {
    requireRole(req.actor, 'SHIPPING_AGENT', 'SHIPPING_LINE', 'TERMINAL_OPERATOR');
    const b = z.object({ offeringId: z.string().uuid(), callId: z.string().uuid().optional(), quantity: z.number().positive().default(1), requestedFor: z.coerce.date(), notes: z.string().optional() }).parse(req.body);
    return tx(req, async (c) => {
      const o = await one(c, 'SELECT * FROM service_offerings WHERE id=$1 AND active', [b.offeringId]);
      if (!o) throw notFound('Service offering not found');
      if (b.callId) {
        const call = await one(c, 'SELECT * FROM vessel_calls WHERE id=$1', [b.callId]);
        if (!call || ['DEPARTED', 'CANCELLED'].includes(call.status)) throw badRequest('Vessel call is not active');
      }
      const sr = await insert(c, 'service_requests', {
        tenant_id: req.actor.tenantId, request_no: await nextNo(c, req.actor.tenantId, req.actor.tenantCode, 'SR'), call_id: b.callId ?? null, offering_id: o.id,
        service_type: o.service_type, requester_org_id: req.actor.orgId, provider_org_id: o.org_id, quantity: b.quantity, requested_for: b.requestedFor, notes: b.notes,
      });
      await audit(c, req.actor, 'SERVICE_REQUESTED', 'service_request', sr.id, b);
      await notify(c, req.actor.tenantId, { orgId: o.org_id }, `New ${o.service_type.toLowerCase()} request`, `${sr.request_no} for ${new Date(b.requestedFor).toISOString().slice(0, 16)}`, '/services', 'warning');
      if (o.service_type === 'PILOTAGE' || o.service_type === 'TOWAGE') await notify(c, req.actor.tenantId, { role: 'HARBOUR_MASTER' }, `${o.service_type} requested`, sr.request_no, '/services');
      return sr;
    });
  });

  app.post('/service-requests/:id/:action', async (req) => {
    const { id, action } = req.params as { id: string; action: string };
    const map: Record<string, string> = { accept: 'ACCEPTED', reject: 'REJECTED', schedule: 'SCHEDULED', complete: 'COMPLETED', cancel: 'CANCELLED' };
    const to = map[action];
    if (!to) throw notFound();
    const b = z.object({ scheduledAt: z.coerce.date().optional(), completedAt: z.coerce.date().optional(), notes: z.string().optional() }).parse(req.body ?? {});
    return tx(req, async (c) => {
      const sr = await one(c, 'SELECT * FROM service_requests WHERE id=$1', [id]);
      if (!sr) throw notFound();
      const isProvider = sr.provider_org_id === req.actor.orgId, isRequester = sr.requester_org_id === req.actor.orgId;
      if (action === 'cancel' ? !isRequester : !isProvider) throw forbidden();
      const patch: Record<string, unknown> = {};
      if (to === 'SCHEDULED') patch.scheduled_at = b.scheduledAt ?? sr.requested_for;
      if (to === 'COMPLETED') patch.completed_at = b.completedAt ?? new Date();
      if (b.notes) patch.notes = b.notes;
      const r = await move(c, req.actor, 'service_requests', 'service_request', SERVICE_FLOW, sr, to, patch);
      await notify(c, req.actor.tenantId, { orgId: isProvider ? sr.requester_org_id : sr.provider_org_id }, `Service ${sr.request_no} ${to.toLowerCase()}`, b.notes, '/services', to === 'REJECTED' ? 'critical' : 'info');
      if (to === 'COMPLETED') await generateInvoice(c, req.actor, 'service_request', id).catch(() => null);
      return r;
    });
  });

  // ================= Barge operations (inland waterway) =================
  const bargeIn = z.object({
    bargeName: z.string().min(2), eni: z.string().refine(isValidEni, 'ENI must be 8 digits'), convoyRef: z.string().optional(),
    origin: z.string().optional(), destination: z.string().optional(), terminalId: z.string().uuid().optional(), berthId: z.string().uuid().optional(),
    eta: z.coerce.date(), cargoDescription: z.string().optional(), tonnage: z.number().nonnegative().optional(),
    containers: z.array(z.string().toUpperCase().refine(isValidContainerNo, 'Invalid container number')).default([]),
  });

  app.get('/barge-calls', async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const a = req.actor;
    return tx(req, (c) => many(c, `SELECT bc.*, o.name AS operator_name, t.code AS terminal_code, b.code AS berth_code FROM barge_calls bc JOIN organisations o ON o.id=bc.operator_org_id
      LEFT JOIN terminals t ON t.id=bc.terminal_id LEFT JOIN berths b ON b.id=bc.berth_id
      WHERE ($1 OR bc.operator_org_id=$2 OR t.operator_org_id=$2) AND ($3::text IS NULL OR bc.status=$3) ORDER BY bc.eta DESC LIMIT 300`, [isAuthority(a), a.orgId, q.status ?? null]));
  });

  app.post('/barge-calls', async (req) => {
    requireRole(req.actor, 'BARGE_OPERATOR');
    const b = bargeIn.parse(req.body);
    return tx(req, async (c) => {
      const r = await insert(c, 'barge_calls', {
        tenant_id: req.actor.tenantId, call_no: await nextNo(c, req.actor.tenantId, req.actor.tenantCode, 'BC'), operator_org_id: req.actor.orgId,
        barge_name: b.bargeName.toUpperCase(), eni: b.eni, convoy_ref: b.convoyRef, origin: b.origin, destination: b.destination, terminal_id: b.terminalId,
        berth_id: b.berthId, eta: b.eta, cargo_description: b.cargoDescription, tonnage: b.tonnage, containers: b.containers,
      });
      await audit(c, req.actor, 'BARGE_CALL_CREATED', 'barge_call', r.id, b);
      return r;
    });
  });

  app.post('/barge-calls/:id/:action', async (req) => {
    const { id, action } = req.params as { id: string; action: string };
    const map: Record<string, string> = { notify: 'NOTIFIED', arrive: 'ARRIVED', start: 'WORKING', depart: 'DEPARTED', cancel: 'CANCELLED' };
    const to = map[action];
    if (!to) throw notFound();
    const b = z.object({ at: z.coerce.date().default(() => new Date()), berthId: z.string().uuid().optional() }).parse(req.body ?? {});
    return tx(req, async (c) => {
      const bc = await one(c, `SELECT bc.*, t.operator_org_id AS terminal_operator FROM barge_calls bc LEFT JOIN terminals t ON t.id=bc.terminal_id WHERE bc.id=$1`, [id]);
      if (!bc) throw notFound();
      const isOperator = bc.operator_org_id === req.actor.orgId;
      const canOps = hasRole(req.actor, 'HARBOUR_MASTER') || bc.terminal_operator === req.actor.orgId;
      if (['notify', 'cancel'].includes(action) ? !isOperator : !(canOps || isOperator)) throw forbidden();
      const patch: Record<string, unknown> = {};
      if (to === 'ARRIVED') patch.ata = b.at;
      if (to === 'DEPARTED') patch.atd = b.at;
      if (b.berthId) patch.berth_id = b.berthId;
      const r = await move(c, req.actor, 'barge_calls', 'barge_call', BARGE_FLOW, bc, to, patch);
      if (to === 'NOTIFIED') {
        await notify(c, req.actor.tenantId, { role: 'HARBOUR_MASTER' }, `Barge pre-notified: ${bc.barge_name}`, `${bc.call_no} ETA ${new Date(bc.eta).toISOString().slice(0, 16)}`, '/barges');
        if (bc.terminal_operator) await notify(c, req.actor.tenantId, { orgId: bc.terminal_operator }, `Barge pre-notified: ${bc.barge_name}`, bc.call_no, '/barges');
      }
      if (to === 'DEPARTED') {
        for (const k of bc.containers) await applyContainerEvent(c, req.actor, k, 'ON_BARGE', b.at, 'BARGE').catch(() => null);
        await generateInvoice(c, req.actor, 'barge_call', id).catch(() => null);
      }
      return r;
    });
  });

  // ================= Rail =================
  const railIn = z.object({
    trainNo: z.string().min(2), direction: z.enum(['INBOUND', 'OUTBOUND']), terminalId: z.string().uuid().optional(), origin: z.string().optional(), destination: z.string().optional(),
    eta: z.coerce.date(), wagons: z.array(z.object({ wagonNo: z.string(), containers: z.array(z.string().toUpperCase()).default([]), cargo: z.string().optional(), tonnes: z.number().optional() })).default([]),
  });

  app.get('/rail-visits', async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const a = req.actor;
    return tx(req, (c) => many(c, `SELECT rv.*, o.name AS operator_name, t.code AS terminal_code, jsonb_array_length(rv.wagons) AS wagon_count FROM rail_visits rv JOIN organisations o ON o.id=rv.operator_org_id LEFT JOIN terminals t ON t.id=rv.terminal_id
      WHERE ($1 OR rv.operator_org_id=$2 OR t.operator_org_id=$2) AND ($3::text IS NULL OR rv.status=$3) ORDER BY rv.eta DESC LIMIT 300`, [isAuthority(a), a.orgId, q.status ?? null]));
  });

  app.post('/rail-visits', async (req) => {
    requireRole(req.actor, 'RAIL_OPERATOR');
    const b = railIn.parse(req.body);
    for (const w of b.wagons) for (const k of w.containers) if (!isValidContainerNo(k)) throw badRequest(`Invalid container ${k} on wagon ${w.wagonNo}`);
    return tx(req, async (c) => {
      const r = await insert(c, 'rail_visits', {
        tenant_id: req.actor.tenantId, visit_no: await nextNo(c, req.actor.tenantId, req.actor.tenantCode, 'RV'), operator_org_id: req.actor.orgId,
        train_no: b.trainNo, direction: b.direction, terminal_id: b.terminalId, origin: b.origin, destination: b.destination, eta: b.eta, wagons: JSON.stringify(b.wagons),
      });
      await audit(c, req.actor, 'RAIL_VISIT_CREATED', 'rail_visit', r.id, { trainNo: b.trainNo });
      return r;
    });
  });

  app.post('/rail-visits/:id/:action', async (req) => {
    const { id, action } = req.params as { id: string; action: string };
    const map: Record<string, string> = { announce: 'ANNOUNCED', arrive: 'ARRIVED', load: 'LOADING', depart: 'DEPARTED', cancel: 'CANCELLED' };
    const to = map[action];
    if (!to) throw notFound();
    const b = z.object({ at: z.coerce.date().default(() => new Date()) }).parse(req.body ?? {});
    return tx(req, async (c) => {
      const rv = await one(c, `SELECT rv.*, t.operator_org_id AS terminal_operator FROM rail_visits rv LEFT JOIN terminals t ON t.id=rv.terminal_id WHERE rv.id=$1`, [id]);
      if (!rv) throw notFound();
      if (rv.operator_org_id !== req.actor.orgId && rv.terminal_operator !== req.actor.orgId && !hasRole(req.actor, 'HARBOUR_MASTER')) throw forbidden();
      const patch: Record<string, unknown> = {};
      if (to === 'ARRIVED') patch.ata = b.at;
      if (to === 'DEPARTED') patch.atd = b.at;
      const r = await move(c, req.actor, 'rail_visits', 'rail_visit', RAIL_FLOW, rv, to, patch);
      if (to === 'ANNOUNCED' && rv.terminal_operator) await notify(c, req.actor.tenantId, { orgId: rv.terminal_operator }, `Train announced: ${rv.train_no}`, rv.visit_no, '/rail');
      if (to === 'DEPARTED' && rv.direction === 'OUTBOUND')
        for (const w of rv.wagons) for (const k of w.containers ?? []) await applyContainerEvent(c, req.actor, k, 'ON_RAIL', b.at, 'RAIL').catch(() => null);
      return r;
    });
  });
}
