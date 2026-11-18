// FR-GAT: electronic delivery orders (eDO), truck appointment system, gate transactions (ANPR / manual / API)
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { DO_FLOW, isValidContainerNo, type DoStatus } from '@pcs/shared';
import { one, many, insert, update, nextNo, type Db } from '../core/db.js';
import { tx, audit, emit, notify, requireRole, hasRole, isAuthority, getTenant, badRequest, notFound, forbidden, conflict, type Actor } from '../core/context.js';
import { applyContainerEvent } from './cargo.js';
import { generateInvoice } from './finance.js';

const DO_SELECT = `SELECT d.*, b.bl_no, b.customs_status, b.consignee, i.name AS issuer_name, r.name AS requester_name, h.name AS haulier_name,
  (SELECT array_agg(k.container_no) FROM containers k WHERE k.bl_id=d.bl_id) AS containers
  FROM delivery_orders d JOIN bills_of_lading b ON b.id=d.bl_id JOIN organisations i ON i.id=d.issuer_org_id JOIN organisations r ON r.id=d.requester_org_id
  LEFT JOIN organisations h ON h.id=d.haulier_org_id`;

async function moveDo(c: Db, a: Actor, d: any, to: DoStatus, patch: Record<string, unknown> = {}) {
  if (!DO_FLOW[d.status as DoStatus].includes(to)) throw conflict(`Delivery order is ${d.status}`);
  const r = await update(c, 'delivery_orders', d.id, { ...patch, status: to });
  await audit(c, a, `DO_${to}`, 'delivery_order', d.id, patch);
  await emit(c, a.tenantId, `delivery_order.${to.toLowerCase()}`, 'delivery_order', d.id, { doNo: d.do_no, blNo: d.bl_no, status: to });
  return r;
}

export default async function delivery(app: FastifyInstance) {
  // ---------- eDO ----------
  app.get('/delivery-orders', async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const a = req.actor;
    return tx(req, (c) => many(c, `${DO_SELECT} WHERE ($1 OR d.issuer_org_id=$2 OR d.requester_org_id=$2 OR d.haulier_org_id=$2) AND ($3::text IS NULL OR d.status=$3) ORDER BY d.created_at DESC LIMIT 300`, [isAuthority(a) || hasRole(a, 'TERMINAL_OPERATOR'), a.orgId, q.status ?? null]));
  });

  app.post('/delivery-orders', async (req) => {
    requireRole(req.actor, 'FREIGHT_FORWARDER');
    const b = z.object({ blId: z.string().uuid(), haulierOrgId: z.string().uuid().optional() }).parse(req.body);
    return tx(req, async (c) => {
      const bl = await one(c, `SELECT b.*, m.direction, m.submitted_by_org, vc.line_org_id, vc.agent_org_id FROM bills_of_lading b JOIN manifests m ON m.id=b.manifest_id JOIN vessel_calls vc ON vc.id=m.call_id WHERE b.id=$1`, [b.blId]);
      if (!bl) throw notFound('B/L not found');
      if (bl.direction !== 'IMPORT') throw badRequest('Delivery orders apply to import B/Ls');
      if (bl.forwarder_org_id && bl.forwarder_org_id !== req.actor.orgId && bl.consignee_org_id !== req.actor.orgId) throw forbidden('B/L is nominated to another forwarder');
      const open = await one(c, `SELECT do_no FROM delivery_orders WHERE bl_id=$1 AND status IN ('REQUESTED','ISSUED')`, [b.blId]);
      if (open) throw conflict(`Delivery order ${open.do_no} already open for this B/L`);
      const issuer = bl.line_org_id ?? bl.submitted_by_org ?? bl.agent_org_id;
      const d = await insert(c, 'delivery_orders', { tenant_id: req.actor.tenantId, do_no: await nextNo(c, req.actor.tenantId, req.actor.tenantCode, 'DO'), bl_id: b.blId, issuer_org_id: issuer, requester_org_id: req.actor.orgId, haulier_org_id: b.haulierOrgId ?? null });
      await audit(c, req.actor, 'DO_REQUESTED', 'delivery_order', d.id, b);
      await notify(c, req.actor.tenantId, { orgId: issuer }, `Delivery order requested: B/L ${bl.bl_no}`, d.do_no, '/delivery-orders', 'warning');
      return d;
    });
  });

  app.post('/delivery-orders/:id/issue', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ validUntil: z.coerce.date(), haulierOrgId: z.string().uuid().optional(), remarks: z.string().optional() }).parse(req.body);
    return tx(req, async (c) => {
      const d = await one(c, DO_SELECT + ' WHERE d.id=$1', [id]);
      if (!d) throw notFound();
      if (d.issuer_org_id !== req.actor.orgId) throw forbidden('Only the shipping line / agent can issue this delivery order');
      const pin = String(crypto.randomInt(100000, 999999));
      const r = await moveDo(c, req.actor, d, 'ISSUED', { valid_until: b.validUntil, pin, issued_at: new Date(), haulier_org_id: b.haulierOrgId ?? d.haulier_org_id, remarks: b.remarks });
      await notify(c, req.actor.tenantId, { orgId: d.requester_org_id }, `Delivery order issued: ${d.do_no}`, `B/L ${d.bl_no} — release PIN ${pin}`, '/delivery-orders', 'success');
      if (r.haulier_org_id) await notify(c, req.actor.tenantId, { orgId: r.haulier_org_id }, `You are nominated on ${d.do_no}`, `Book a truck appointment for B/L ${d.bl_no}`, '/trucks');
      await generateInvoice(c, req.actor, 'delivery_order', id).catch(() => null);
      return r;
    });
  });

  for (const action of ['reject', 'revoke'] as const) {
    app.post(`/delivery-orders/:id/${action}`, async (req) => {
      const { id } = req.params as { id: string };
      const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
      return tx(req, async (c) => {
        const d = await one(c, DO_SELECT + ' WHERE d.id=$1', [id]);
        if (!d) throw notFound();
        if (d.issuer_org_id !== req.actor.orgId) throw forbidden();
        const r = await moveDo(c, req.actor, d, action === 'reject' ? 'REJECTED' : 'REVOKED', { remarks: reason });
        await notify(c, req.actor.tenantId, { orgId: d.requester_org_id }, `Delivery order ${action}ed: ${d.do_no}`, reason, '/delivery-orders', 'critical');
        return r;
      });
    });
  }

  // ---------- Truck appointments ----------
  app.get('/gate/slots', async (req) => {
    const q = z.object({ terminalId: z.string().uuid(), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
    const t = await getTenant(req.actor.tenantId);
    const s: any = t.settings;
    const mins = s.truckSlotMinutes ?? 60, cap = s.truckSlotCapacity ?? 20;
    return tx(req, async (c) => {
      const booked = await many(c, `SELECT slot_start, count(*)::int AS n FROM truck_appointments WHERE terminal_id=$1 AND slot_start::date=$2::date AND status IN ('BOOKED','GATED_IN','GATED_OUT') GROUP BY slot_start`, [q.terminalId, q.date]);
      const map = new Map(booked.map((b) => [new Date(b.slot_start).toISOString(), b.n]));
      const slots: any[] = [];
      for (let m = 0; m < 24 * 60; m += mins) {
        const start = new Date(`${q.date}T00:00:00Z`); start.setUTCMinutes(m);
        const used = map.get(start.toISOString()) ?? 0;
        slots.push({ start, end: new Date(start.getTime() + mins * 6e4), capacity: cap, booked: used, available: Math.max(0, cap - used) });
      }
      return slots;
    });
  });

  app.get('/truck-appointments', async (req) => {
    const q = z.object({ status: z.string().optional(), terminalId: z.string().uuid().optional(), date: z.string().optional(), search: z.string().optional() }).parse(req.query);
    const a = req.actor;
    return tx(req, (c) => many(c, `SELECT ta.*, t.code AS terminal_code, t.name AS terminal_name, h.name AS haulier_name, d.do_no
      FROM truck_appointments ta JOIN terminals t ON t.id=ta.terminal_id JOIN organisations h ON h.id=ta.haulier_org_id LEFT JOIN delivery_orders d ON d.id=ta.do_id
      WHERE ($1 OR ta.haulier_org_id=$2 OR t.operator_org_id=$2) AND ($3::text IS NULL OR ta.status=$3) AND ($4::uuid IS NULL OR ta.terminal_id=$4)
        AND ($5::date IS NULL OR ta.slot_start::date=$5::date) AND ($6::text IS NULL OR ta.truck_plate ILIKE '%'||$6||'%' OR ta.appt_no ILIKE '%'||$6||'%' OR ta.container_no LIKE upper($6)||'%')
      ORDER BY ta.slot_start DESC LIMIT 300`, [isAuthority(a), a.orgId, q.status ?? null, q.terminalId ?? null, q.date ?? null, q.search ?? null]));
  });

  app.post('/truck-appointments', async (req) => {
    requireRole(req.actor, 'HAULIER');
    const b = z.object({
      terminalId: z.string().uuid(), direction: z.enum(['IMPORT_PICKUP', 'EXPORT_DROPOFF', 'EMPTY_RETURN', 'EMPTY_PICKUP']),
      containerNo: z.string().transform((s) => s.toUpperCase()).refine(isValidContainerNo, 'Invalid ISO 6346 container number').optional(),
      doId: z.string().uuid().optional(), truckPlate: z.string().min(3).max(15).transform((s) => s.toUpperCase().replace(/\s/g, '')),
      driverName: z.string().optional(), driverLicence: z.string().optional(), slotStart: z.coerce.date(),
    }).parse(req.body);
    const t = await getTenant(req.actor.tenantId);
    const s: any = t.settings;
    const mins = s.truckSlotMinutes ?? 60, cap = s.truckSlotCapacity ?? 20;
    return tx(req, async (c) => {
      if (b.slotStart.getTime() < Date.now() - mins * 6e4) throw badRequest('Slot is in the past');
      if (b.direction === 'IMPORT_PICKUP') {
        if (!b.containerNo || !b.doId) throw badRequest('Import pickup needs the container and an issued delivery order');
        const d = await one(c, `SELECT d.*, b.customs_status FROM delivery_orders d JOIN bills_of_lading b ON b.id=d.bl_id WHERE d.id=$1`, [b.doId]);
        if (!d || d.status !== 'ISSUED') throw conflict('Delivery order is not issued');
        if (d.haulier_org_id && d.haulier_org_id !== req.actor.orgId) throw forbidden('Delivery order nominates another haulier');
        const k = await one(c, 'SELECT * FROM containers WHERE bl_id=$1 AND container_no=$2', [d.bl_id, b.containerNo]);
        if (!k) throw badRequest('Container is not on this delivery order');
        if (k.terminal_id && k.terminal_id !== b.terminalId) throw badRequest('Container is at a different terminal');
      }
      const used = await one(c, `SELECT count(*)::int AS n FROM truck_appointments WHERE terminal_id=$1 AND slot_start=$2 AND status IN ('BOOKED','GATED_IN')`, [b.terminalId, b.slotStart]);
      if (used!.n >= cap) throw conflict('Slot is full — choose another slot');
      const ta = await insert(c, 'truck_appointments', {
        tenant_id: req.actor.tenantId, appt_no: await nextNo(c, req.actor.tenantId, req.actor.tenantCode, 'TA'), terminal_id: b.terminalId,
        haulier_org_id: req.actor.orgId, direction: b.direction, container_no: b.containerNo, do_id: b.doId, truck_plate: b.truckPlate,
        driver_name: b.driverName, driver_licence: b.driverLicence, slot_start: b.slotStart, slot_end: new Date(b.slotStart.getTime() + mins * 6e4),
        token: crypto.randomBytes(4).toString('hex').toUpperCase(),
      });
      await audit(c, req.actor, 'APPOINTMENT_BOOKED', 'truck_appointment', ta.id, b);
      await emit(c, req.actor.tenantId, 'truck_appointment.booked', 'truck_appointment', ta.id, { apptNo: ta.appt_no, plate: ta.truck_plate, slotStart: ta.slot_start });
      return ta;
    });
  });

  app.post('/truck-appointments/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const ta = await one(c, 'SELECT * FROM truck_appointments WHERE id=$1', [id]);
      if (!ta) throw notFound();
      if (ta.haulier_org_id !== req.actor.orgId && !hasRole(req.actor, 'TERMINAL_OPERATOR')) throw forbidden();
      if (ta.status !== 'BOOKED') throw conflict(`Appointment is ${ta.status}`);
      await update(c, 'truck_appointments', id, { status: 'CANCELLED' });
      await audit(c, req.actor, 'APPOINTMENT_CANCELLED', 'truck_appointment', id);
      return { ok: true };
    });
  });

  // ---------- Gate transactions ----------
  app.get('/gate/events', async (req) => {
    const q = z.object({ terminalId: z.string().uuid().optional() }).parse(req.query);
    return tx(req, (c) => many(c, `SELECT g.*, t.code AS terminal_code, ta.appt_no FROM gate_events g JOIN terminals t ON t.id=g.terminal_id LEFT JOIN truck_appointments ta ON ta.id=g.appointment_id
      WHERE ($1::uuid IS NULL OR g.terminal_id=$1) AND ($2 OR t.operator_org_id=$3) ORDER BY g.at DESC LIMIT 200`, [q.terminalId ?? null, isAuthority(req.actor), req.actor.orgId]));
  });

  app.post('/gate/transactions', async (req) => {
    requireRole(req.actor, 'TERMINAL_OPERATOR');
    const b = z.object({
      terminalId: z.string().uuid(), direction: z.enum(['IN', 'OUT']), truckPlate: z.string().transform((s) => s.toUpperCase().replace(/\s/g, '')),
      token: z.string().optional(), containerNo: z.string().optional(), source: z.enum(['ANPR', 'MANUAL', 'API', 'OCR']).default('MANUAL'),
    }).parse(req.body);
    return tx(req, (c) => gateTransaction(c, req.actor, b));
  });
}

/** Validate a truck at the gate against its appointment, DO, customs release and holds. Every attempt is logged. */
export async function gateTransaction(c: Db, a: Actor, b: { terminalId: string; direction: 'IN' | 'OUT'; truckPlate: string; token?: string; containerNo?: string; source: string }) {
  const ta = b.token
    ? await one(c, `SELECT * FROM truck_appointments WHERE token=$1 AND terminal_id=$2`, [b.token.toUpperCase(), b.terminalId])
    : await one(c, `SELECT * FROM truck_appointments WHERE truck_plate=$1 AND terminal_id=$2 AND status=$3 ORDER BY abs(extract(epoch FROM slot_start - now())) LIMIT 1`, [b.truckPlate, b.terminalId, b.direction === 'IN' ? 'BOOKED' : 'GATED_IN']);
  const reject = async (reason: string) => {
    await insert(c, 'gate_events', { tenant_id: a.tenantId, terminal_id: b.terminalId, appointment_id: ta?.id ?? null, truck_plate: b.truckPlate, container_no: b.containerNo ?? ta?.container_no, direction: b.direction, source: b.source, result: 'REJECTED', reason });
    await emit(c, a.tenantId, 'gate.rejected', 'truck_appointment', ta?.id ?? '00000000-0000-0000-0000-000000000000', { plate: b.truckPlate, reason });
    if (ta) await notify(c, a.tenantId, { orgId: ta.haulier_org_id }, `Gate rejected: ${b.truckPlate}`, reason, '/trucks', 'critical');
    return { result: 'REJECTED', reason, appointment: ta };
  };
  if (!ta) return reject('No matching appointment');
  if (ta.truck_plate !== b.truckPlate) return reject(`Plate mismatch: appointment is for ${ta.truck_plate}`);
  const warnings: string[] = [];
  if (b.direction === 'IN') {
    if (ta.status !== 'BOOKED') return reject(`Appointment is ${ta.status}`);
    const early = (new Date(ta.slot_start).getTime() - Date.now()) / 6e4, late = (Date.now() - new Date(ta.slot_end).getTime()) / 6e4;
    if (early > 120) return reject('Too early for appointment slot');
    if (late > 120) return reject('Appointment slot expired');
    if (early > 0 || late > 0) warnings.push('Outside slot window (grace applied)');
    if (ta.direction === 'IMPORT_PICKUP') {
      const d = await one(c, `SELECT d.status, b.customs_status FROM delivery_orders d JOIN bills_of_lading b ON b.id=d.bl_id WHERE d.id=$1`, [ta.do_id]);
      if (d?.status !== 'ISSUED') return reject(`Delivery order is ${d?.status ?? 'missing'}`);
      if (d.customs_status !== 'RELEASED') return reject(`Customs status is ${d.customs_status}`);
      const k = await one(c, `SELECT holds, status FROM containers WHERE container_no=$1 ORDER BY updated_at DESC LIMIT 1`, [ta.container_no]);
      if (k?.holds?.length) return reject(`Container has holds: ${k.holds.join(', ')}`);
      if (k && !['DISCHARGED', 'IN_YARD'].includes(k.status)) return reject(`Container not available for pickup (${k.status})`);
    }
    await update(c, 'truck_appointments', ta.id, { status: 'GATED_IN', gate_in_at: new Date() });
    if (ta.direction === 'EXPORT_DROPOFF' && ta.container_no) await applyContainerEvent(c, a, ta.container_no, 'GATED_IN', new Date(), `GATE_${b.source}`).catch(() => null);
  } else {
    if (ta.status !== 'GATED_IN') return reject(`Truck has not gated in (${ta.status})`);
    await update(c, 'truck_appointments', ta.id, { status: 'GATED_OUT', gate_out_at: new Date() });
    if (ta.direction === 'IMPORT_PICKUP' && ta.container_no) {
      await applyContainerEvent(c, a, ta.container_no, 'GATED_OUT', new Date(), `GATE_${b.source}`).catch(() => null);
      const d = await one(c, 'SELECT * FROM delivery_orders WHERE id=$1', [ta.do_id]);
      const remaining = await one(c, `SELECT count(*)::int AS n FROM containers WHERE bl_id=$1 AND status<>'GATED_OUT'`, [d.bl_id]);
      if (remaining!.n === 0) await update(c, 'delivery_orders', d.id, { status: 'USED' });
    }
    await generateInvoice(c, a, 'truck_appointment', ta.id).catch(() => null);
  }
  await insert(c, 'gate_events', { tenant_id: a.tenantId, terminal_id: b.terminalId, appointment_id: ta.id, truck_plate: b.truckPlate, container_no: ta.container_no, direction: b.direction, source: b.source, result: 'ACCEPTED', reason: warnings.join('; ') || null });
  await audit(c, a, `GATE_${b.direction}`, 'truck_appointment', ta.id, { plate: b.truckPlate, source: b.source });
  await emit(c, a.tenantId, `gate.${b.direction.toLowerCase()}`, 'truck_appointment', ta.id, { apptNo: ta.appt_no, plate: b.truckPlate, containerNo: ta.container_no });
  return { result: 'ACCEPTED', warnings, appointment: await one(c, 'SELECT * FROM truck_appointments WHERE id=$1', [ta.id]) };
}
