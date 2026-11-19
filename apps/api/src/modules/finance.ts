// FR-FIN: tariff engine, invoicing, payments (mock gateway), ERP export
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { teuOf } from '@pcs/shared';
import { one, many, insert, update, nextNo, type Db } from '../core/db.js';
import { tx, audit, emit, notify, requireRole, hasRole, isAuthority, getTenant, badRequest, notFound, conflict, forbidden, type Actor } from '../core/context.js';

export const BILLABLE = ['vessel_call', 'barge_call', 'delivery_order', 'truck_appointment', 'service_request'] as const;
const APPLIES: Record<string, string> = {
  vessel_call: 'VESSEL_CALL', barge_call: 'BARGE_CALL', delivery_order: 'DELIVERY_ORDER', truck_appointment: 'TRUCK_APPOINTMENT', service_request: 'SERVICE_REQUEST',
};

interface Line { tariff_code: string; description: string; quantity: number; rate: number; amount: number }

/** Load what is being billed: the customer and the measures each tariff basis needs. */
async function billingSubject(c: Db, entityType: string, id: string) {
  switch (entityType) {
    case 'vessel_call': {
      const r = await one(c, `SELECT vc.*, v.gt, v.loa, v.type AS vessel_type, v.name AS vessel_name FROM vessel_calls vc JOIN vessels v ON v.id=vc.vessel_id WHERE vc.id=$1`, [id]);
      if (!r) return null;
      const start = new Date(r.ata ?? r.eta).getTime(), end = new Date(r.atd ?? r.etd).getTime();
      const teu = await one(c, `SELECT coalesce(sum(CASE WHEN left(k.iso_type,1) IN ('4','L') THEN 2 ELSE 1 END),0) AS teu FROM containers k WHERE k.call_id=$1`, [id]);
      return { customer: r.agent_org_id, reference: `${r.call_no} ${r.vessel_name}`, measures: { PER_CALL: 1, PER_GT: r.gt ?? 0, PER_LOA_DAY: Number(r.loa ?? 0) * Math.max(1, Math.ceil((end - start) / 864e5)), PER_TEU: teu?.teu ?? 0 }, attrs: { vessel_type: r.vessel_type, purpose: r.purpose } };
    }
    case 'barge_call': {
      const r = await one(c, 'SELECT * FROM barge_calls WHERE id=$1', [id]);
      if (!r) return null;
      return { customer: r.operator_org_id, reference: `${r.call_no} ${r.barge_name}`, measures: { PER_CALL: 1, PER_TONNE: Number(r.tonnage ?? 0), PER_TEU: r.containers.length }, attrs: {} };
    }
    case 'delivery_order': {
      const r = await one(c, `SELECT d.*, (SELECT count(*) FROM containers k WHERE k.bl_id=d.bl_id) AS n FROM delivery_orders d WHERE d.id=$1`, [id]);
      if (!r) return null;
      return { customer: r.requester_org_id, reference: r.do_no, measures: { PER_CALL: 1, PER_UNIT: r.n }, attrs: {} };
    }
    case 'truck_appointment': {
      const r = await one(c, 'SELECT * FROM truck_appointments WHERE id=$1', [id]);
      if (!r) return null;
      return { customer: r.haulier_org_id, reference: `${r.appt_no} ${r.truck_plate}`, measures: { PER_CALL: 1, PER_UNIT: r.container_no ? 1 : 0 }, attrs: { direction: r.direction } };
    }
    case 'service_request': {
      const r = await one(c, `SELECT sr.*, so.unit_price, so.unit, p.name AS provider_name FROM service_requests sr LEFT JOIN service_offerings so ON so.id=sr.offering_id JOIN organisations p ON p.id=sr.provider_org_id WHERE sr.id=$1`, [id]);
      if (!r) return null;
      return { customer: r.requester_org_id, reference: `${r.request_no} ${r.service_type} by ${r.provider_name}`, measures: {}, attrs: {}, direct: r.unit_price ? [{ tariff_code: `SVC-${r.service_type}`, description: `${r.service_type} (${r.unit})`, quantity: Number(r.quantity), rate: Number(r.unit_price), amount: round(Number(r.quantity) * Number(r.unit_price)) }] : [] };
    }
  }
  return null;
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Rate an entity against the port tariff book and issue an invoice. Idempotent per entity. */
export async function generateInvoice(c: Db, a: Actor, entityType: string, entityId: string) {
  if (!APPLIES[entityType]) throw badRequest('Not billable');
  const existing = await one(c, `SELECT * FROM invoices WHERE entity_type=$1 AND entity_id=$2 AND status<>'CANCELLED'`, [entityType, entityId]);
  if (existing) return existing;
  const subj: any = await billingSubject(c, entityType, entityId);
  if (!subj) throw notFound('Billable record not found');
  const t = await getTenant(a.tenantId);
  const tariffs = await many(c, `SELECT * FROM tariffs WHERE active AND applies_to=$1 ORDER BY code`, [APPLIES[entityType]]);
  const lines: Line[] = [...(subj.direct ?? [])];
  for (const tf of tariffs) {
    const cond = tf.conditions ?? {};
    if (cond.vesselTypes && !cond.vesselTypes.includes(subj.attrs.vessel_type)) continue;
    if (cond.purposes && !cond.purposes.includes(subj.attrs.purpose)) continue;
    if (cond.directions && !cond.directions.includes(subj.attrs.direction)) continue;
    const qty = Number(subj.measures[tf.basis] ?? 0);
    if (!qty) continue;
    let amount = round(qty * Number(tf.rate));
    if (tf.min_amount && amount < Number(tf.min_amount)) amount = Number(tf.min_amount);
    lines.push({ tariff_code: tf.code, description: tf.name, quantity: qty, rate: Number(tf.rate), amount });
  }
  if (!lines.length) return null;
  const subtotal = round(lines.reduce((s, l) => s + l.amount, 0));
  const vat = Number((t.settings as any).vatRate ?? 0);
  const tax = round(subtotal * vat);
  const inv = await insert(c, 'invoices', {
    tenant_id: a.tenantId, invoice_no: await nextNo(c, a.tenantId, a.tenantCode, 'INV'), customer_org_id: subj.customer,
    entity_type: entityType, entity_id: entityId, reference: subj.reference, currency: t.currency, subtotal, tax, total: round(subtotal + tax),
    status: 'ISSUED', due_at: new Date(Date.now() + 14 * 864e5),
  });
  for (const l of lines) await insert(c, 'invoice_lines', { invoice_id: inv.id, ...l });
  await audit(c, a, 'INVOICE_ISSUED', 'invoice', inv.id, { entityType, entityId, total: inv.total });
  await emit(c, a.tenantId, 'invoice.issued', 'invoice', inv.id, { invoiceNo: inv.invoice_no, total: inv.total, currency: inv.currency, customerOrgId: inv.customer_org_id });
  await notify(c, a.tenantId, { orgId: subj.customer }, `Invoice ${inv.invoice_no} issued`, `${inv.currency} ${inv.total.toFixed(2)} — ${subj.reference}`, `/finance/invoices/${inv.id}`);
  return inv;
}

export default async function finance(app: FastifyInstance) {
  // ----- Tariffs -----
  app.get('/tariffs', async (req) => tx(req, (c) => many(c, 'SELECT * FROM tariffs ORDER BY applies_to, code')));
  const tariffSchema = z.object({
    code: z.string().min(2), name: z.string().min(2), appliesTo: z.enum(['VESSEL_CALL', 'BARGE_CALL', 'DELIVERY_ORDER', 'TRUCK_APPOINTMENT', 'SERVICE_REQUEST']),
    basis: z.enum(['PER_CALL', 'PER_GT', 'PER_LOA_DAY', 'PER_TEU', 'PER_TONNE', 'PER_UNIT']), rate: z.number().nonnegative(),
    minAmount: z.number().nonnegative().optional().nullable(), conditions: z.record(z.string(), z.any()).default({}), active: z.boolean().default(true),
  });
  app.post('/tariffs', async (req) => {
    requireRole(req.actor, 'FINANCE', 'PORT_ADMIN');
    const b = tariffSchema.parse(req.body);
    const t = await getTenant(req.actor.tenantId);
    return tx(req, async (c) => {
      const r = await insert(c, 'tariffs', { tenant_id: req.actor.tenantId, code: b.code, name: b.name, applies_to: b.appliesTo, basis: b.basis, rate: b.rate, currency: t.currency, min_amount: b.minAmount ?? null, conditions: JSON.stringify(b.conditions), active: b.active });
      await audit(c, req.actor, 'TARIFF_CREATED', 'tariff', r.id, b);
      return r;
    });
  });
  app.patch('/tariffs/:id', async (req) => {
    requireRole(req.actor, 'FINANCE', 'PORT_ADMIN');
    const { id } = req.params as { id: string };
    const b = tariffSchema.partial().parse(req.body);
    return tx(req, async (c) => {
      const r = await update(c, 'tariffs', id, { name: b.name, basis: b.basis, rate: b.rate, min_amount: b.minAmount, conditions: b.conditions ? JSON.stringify(b.conditions) : undefined, active: b.active });
      if (!r) throw notFound();
      await audit(c, req.actor, 'TARIFF_UPDATED', 'tariff', id, b);
      return r;
    });
  });
  app.post('/tariffs/quote', async (req) => {
    const b = z.object({ entityType: z.enum(BILLABLE), entityId: z.string().uuid() }).parse(req.body);
    // Quote by rating inside a transaction that is then rolled back
    return tx(req, async (c) => {
      await c.query('SAVEPOINT quote');
      const inv = await generateInvoice(c, req.actor, b.entityType, b.entityId);
      const lines = inv ? await many(c, 'SELECT tariff_code, description, quantity, rate, amount FROM invoice_lines WHERE invoice_id=$1', [inv.id]) : [];
      const out = inv ? { currency: inv.currency, subtotal: inv.subtotal, tax: inv.tax, total: inv.total, lines } : { lines: [] };
      await c.query('ROLLBACK TO SAVEPOINT quote');
      return out;
    });
  });

  // ----- Invoices -----
  app.get('/invoices', async (req) => {
    const q = z.object({ status: z.string().optional(), search: z.string().optional() }).parse(req.query);
    const all = isAuthority(req.actor);
    return tx(req, (c) => many(c, `SELECT i.*, o.name AS customer_name FROM invoices i JOIN organisations o ON o.id=i.customer_org_id
      WHERE ($1 OR i.customer_org_id=$2) AND ($3::text IS NULL OR i.status=$3) AND ($4::text IS NULL OR i.invoice_no ILIKE '%'||$4||'%' OR i.reference ILIKE '%'||$4||'%')
      ORDER BY i.issued_at DESC LIMIT 300`, [all, req.actor.orgId, q.status ?? null, q.search ?? null]));
  });

  app.get('/invoices/:id', async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const inv = await one(c, `SELECT i.*, o.name AS customer_name, o.tax_id AS customer_tax_id, o.address AS customer_address FROM invoices i JOIN organisations o ON o.id=i.customer_org_id WHERE i.id=$1`, [id]);
      if (!inv || (!isAuthority(req.actor) && inv.customer_org_id !== req.actor.orgId)) throw notFound();
      const t = await getTenant(req.actor.tenantId);
      return { ...inv, port: t.name, lines: await many(c, 'SELECT * FROM invoice_lines WHERE invoice_id=$1', [id]), payments: await many(c, 'SELECT * FROM payments WHERE invoice_id=$1 ORDER BY at', [id]) };
    });
  });

  app.post('/invoices/generate', async (req) => {
    requireRole(req.actor, 'FINANCE', 'PORT_ADMIN');
    const b = z.object({ entityType: z.enum(BILLABLE), entityId: z.string().uuid() }).parse(req.body);
    return tx(req, async (c) => (await generateInvoice(c, req.actor, b.entityType, b.entityId)) ?? { message: 'No applicable tariffs' });
  });

  app.post('/invoices/:id/pay', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ method: z.enum(['CARD', 'BANK_TRANSFER', 'WALLET']) }).parse(req.body);
    return tx(req, async (c) => {
      const inv = await one(c, 'SELECT * FROM invoices WHERE id=$1 FOR UPDATE', [id]);
      if (!inv) throw notFound();
      if (inv.customer_org_id !== req.actor.orgId && !hasRole(req.actor, 'FINANCE')) throw forbidden('Only the customer can pay this invoice');
      if (inv.status !== 'ISSUED') throw conflict(`Invoice is ${inv.status}`);
      // Payment gateway adapter: MOCK_GATEWAY in dev; national payment / bank gateway adapters plug in here.
      const ref = `PAY-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
      const p = await insert(c, 'payments', { tenant_id: req.actor.tenantId, invoice_id: id, amount: inv.total, currency: inv.currency, method: b.method, provider_ref: ref, status: 'SUCCEEDED', paid_by: req.actor.userId });
      await update(c, 'invoices', id, { status: 'PAID', paid_at: new Date() });
      await audit(c, req.actor, 'INVOICE_PAID', 'invoice', id, { method: b.method, ref });
      await emit(c, req.actor.tenantId, 'invoice.paid', 'invoice', id, { invoiceNo: inv.invoice_no, amount: inv.total, ref });
      await notify(c, req.actor.tenantId, { role: 'FINANCE' }, `Payment received ${inv.invoice_no}`, `${inv.currency} ${inv.total}`, `/finance/invoices/${id}`, 'success');
      return p;
    });
  });

  app.post('/invoices/:id/cancel', async (req) => {
    requireRole(req.actor, 'FINANCE');
    const { id } = req.params as { id: string };
    const { reason } = z.object({ reason: z.string().min(3) }).parse(req.body);
    return tx(req, async (c) => {
      const inv = await one(c, 'SELECT * FROM invoices WHERE id=$1', [id]);
      if (!inv) throw notFound();
      if (inv.status === 'PAID') throw conflict('Paid invoices need a credit note');
      await update(c, 'invoices', id, { status: 'CANCELLED' });
      await audit(c, req.actor, 'INVOICE_CANCELLED', 'invoice', id, { reason });
      return { ok: true };
    });
  });

  /** ERP export (e.g. SAP/Oracle) — journal-ready payload. */
  app.get('/invoices/:id/erp', async (req) => {
    requireRole(req.actor, 'FINANCE');
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const inv = await one(c, `SELECT i.*, o.name AS customer_name, o.tax_id FROM invoices i JOIN organisations o ON o.id=i.customer_org_id WHERE i.id=$1`, [id]);
      if (!inv) throw notFound();
      const lines = await many(c, 'SELECT * FROM invoice_lines WHERE invoice_id=$1', [id]);
      return {
        documentType: 'AR_INVOICE', documentNo: inv.invoice_no, postingDate: inv.issued_at, dueDate: inv.due_at, currency: inv.currency,
        customer: { name: inv.customer_name, taxId: inv.tax_id }, reference: inv.reference,
        lines: lines.map((l, i) => ({ lineNo: i + 1, revenueCode: l.tariff_code, text: l.description, quantity: l.quantity, unitPrice: l.rate, amount: l.amount })),
        tax: inv.tax, total: inv.total, status: inv.status,
      };
    });
  });
}

export { teuOf };
