// FR-ICD / FR-DEP / FR-CFS: inland facilities connected to the port.
//  - Dry ports (inland container depots): bonded customs transit from the seaport, clearance and delivery inland, export transfer back
//  - Empty container depots: empty returns with EIR and condition survey, M&R estimates approved by the line, empty release orders
//  - Container freight stations: LCL destuffing into house-B/L lots, per-lot customs release and partial delivery, export stuffing
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FACILITY_TYPES, TRANSFER_FLOW, CFS_JOB_FLOW, isValidContainerNo, type TransferStatus, type CfsJobStatus } from '@pcs/shared';
import { one, many, insert, update, nextNo, type Db } from '../core/db.js';
import { tx, audit, emit, notify, requireRole, hasRole, isAuthority, getTenant, badRequest, notFound, forbidden, conflict, type Actor } from '../core/context.js';
import { openApprovals, onApprovalOutcome } from '../core/workflow.js';
import { generateInvoice } from './finance.js';

const cntrNo = z.string().transform((s) => s.replace(/\s/g, '').toUpperCase()).refine(isValidContainerNo, 'Invalid container number (ISO 6346 check digit)');
const DAY = 864e5;

async function loadFacility(c: Db, id: string) {
  const f = await one(c, 'SELECT f.*, o.name AS operator_name FROM facilities f LEFT JOIN organisations o ON o.id=f.operator_org_id WHERE f.id=$1', [id]);
  if (!f) throw notFound('Facility not found');
  return f;
}
const isOperator = (a: Actor, f: any) => hasRole(a, 'FACILITY_OPERATOR') && a.orgId === f.operator_org_id;
function requireOperator(a: Actor, f: any) {
  if (!isOperator(a, f) && !hasRole(a, 'PORT_ADMIN')) throw forbidden(`Only the operator of ${f.name} can do this`);
}
/** Latest container record (any life-cycle) by number. */
const latestContainer = (c: Db, no: string) => one(c, 'SELECT * FROM containers WHERE container_no=$1 ORDER BY updated_at DESC LIMIT 1', [no]);

async function containerEvent(c: Db, a: Actor, k: any, event: string, location: string, patch: Record<string, unknown> = {}) {
  await update(c, 'containers', k.id, { status: event, updated_at: new Date(), ...patch });
  await insert(c, 'container_events', { tenant_id: a.tenantId, container_id: k.id, event, location, source: a.apiKeyId ? 'API' : 'UI', at: new Date() });
  await emit(c, a.tenantId, `container.${event.toLowerCase()}`, 'container', k.id, { containerNo: k.container_no, event, location });
}

// ------------------------------------------------------------------ transfers
const TRANSFER_SELECT = `SELECT it.*, f.name AS facility_name, f.code AS facility_code, f.type AS facility_type, t.code AS terminal_code, t.name AS terminal_name,
    r.name AS requester_name, cr.name AS carrier_name, b.bl_no, b.customs_status,
    (it.status = 'IN_TRANSIT' AND it.transit_deadline < now()) AS overdue
  FROM inland_transfers it JOIN facilities f ON f.id=it.facility_id JOIN terminals t ON t.id=it.terminal_id JOIN organisations r ON r.id=it.requester_org_id
  LEFT JOIN organisations cr ON cr.id=it.carrier_org_id LEFT JOIN bills_of_lading b ON b.id=it.bl_id`;

async function moveTransfer(c: Db, a: Actor, t: any, to: TransferStatus, patch: Record<string, unknown> = {}) {
  if (!TRANSFER_FLOW[t.status as TransferStatus].includes(to)) throw conflict(`Transfer is ${t.status}`);
  const r = await update(c, 'inland_transfers', t.id, { ...patch, status: to });
  await audit(c, a, `TRANSFER_${to}`, 'inland_transfer', t.id, patch);
  await emit(c, a.tenantId, `inland_transfer.${to.toLowerCase()}`, 'inland_transfer', t.id, { transferNo: t.transfer_no, status: to, containers: t.containers });
  return r;
}

// Customs decides the transit (bond) request through the Single Window approval engine.
onApprovalOutcome('inland_transfer', async (c, a, id, _stage, outcome) => {
  const t = await one(c, TRANSFER_SELECT + ' WHERE it.id=$1', [id]);
  if (!t || t.status !== 'REQUESTED') return;
  if (outcome === 'APPROVED') {
    const f = await loadFacility(c, t.facility_id);
    const docNo = await nextNo(c, t.tenant_id, a.tenantCode, 'TD');
    await moveTransfer(c, a, t, 'CUSTOMS_APPROVED', { transit_doc_no: docNo, transit_deadline: new Date(Date.now() + f.transit_hours * 36e5) });
    await notify(c, t.tenant_id, { orgId: t.requester_org_id }, `Transit approved: ${t.transfer_no}`, `Customs transit document ${docNo}`, '/inland', 'success');
    if (t.carrier_org_id) await notify(c, t.tenant_id, { orgId: t.carrier_org_id }, `Transit ready to move: ${t.transfer_no}`, `${t.containers.length} container(s) ${t.terminal_code} → ${t.facility_name}`, '/inland');
  } else if (outcome === 'REJECTED') {
    await moveTransfer(c, a, t, 'REJECTED');
    await notify(c, t.tenant_id, { orgId: t.requester_org_id }, `Transit rejected: ${t.transfer_no}`, 'See the customs remarks', '/inland', 'critical');
  }
});

// ------------------------------------------------------------------ facility gate
interface GateIn {
  direction: 'IN' | 'OUT'; purpose: string; containerNo?: string; truckPlate: string; haulierOrgId?: string; lineOrgId?: string; reference?: string;
  isoType?: string; condition?: 'SOUND' | 'DAMAGED'; damages?: { component: string; code: string; remarks?: string }[]; sealNo?: string;
}

export async function facilityGate(c: Db, a: Actor, f: any, b: GateIn) {
  const base = { tenant_id: a.tenantId, facility_id: f.id, direction: b.direction, purpose: b.purpose, container_no: b.containerNo ?? null, truck_plate: b.truckPlate.toUpperCase(), haulier_org_id: b.haulierOrgId ?? null, reference: b.reference ?? null, created_by: a.userId };
  const reject = async (reason: string) => {
    const m = await insert(c, 'facility_moves', { ...base, result: 'REJECTED', reason, line_org_id: b.lineOrgId ?? null });
    await audit(c, a, 'FACILITY_GATE_REJECTED', 'facility_move', m.id, { reason, ...b });
    return { ...m, result: 'REJECTED', reason };
  };
  const accept = async (k: any, patch: Record<string, unknown>) => {
    const eir = await nextNo(c, a.tenantId, a.tenantCode, 'EIR');
    const dwell = b.direction === 'OUT' && k?.facility_in_at ? Math.max(1, Math.ceil((Date.now() - new Date(k.facility_in_at).getTime()) / DAY)) : null;
    const m = await insert(c, 'facility_moves', { ...base, eir_no: eir, result: 'ACCEPTED', full_empty: k?.full_empty ?? null, line_org_id: k?.line_org_id ?? b.lineOrgId ?? null, condition: b.condition ?? k?.condition ?? null, damages: JSON.stringify(b.damages ?? []), seal_no: b.sealNo ?? k?.seal_no ?? null, dwell_days: dwell, ...patch });
    await audit(c, a, 'FACILITY_GATE', 'facility_move', m.id, b);
    await emit(c, a.tenantId, `facility.gate_${b.direction.toLowerCase()}`, 'facility_move', m.id, { facility: f.code, eirNo: eir, containerNo: b.containerNo, purpose: b.purpose });
    const inv = await generateInvoice(c, a, 'facility_move', m.id);
    return { ...m, invoice: inv ? { id: inv.id, invoiceNo: inv.invoice_no, total: inv.total } : null };
  };

  switch (b.purpose) {
    case 'EMPTY_RETURN': {
      if (b.direction !== 'IN' || f.type !== 'EMPTY_DEPOT') return reject('Empty returns are received IN at an empty depot');
      if (!b.containerNo) return reject('Container number required');
      const prev = await latestContainer(c, b.containerNo);
      if (prev?.status === 'AT_FACILITY') return reject(`Container is already in ${prev.facility_id === f.id ? 'this depot' : 'another facility'}`);
      let line = b.lineOrgId ?? prev?.line_org_id ?? null;
      if (!line && prev?.call_id) line = (await one(c, 'SELECT line_org_id FROM vessel_calls WHERE id=$1', [prev.call_id]))?.line_org_id ?? null;
      if (!line) return reject('Unknown container owner: give the shipping line');
      if (prev && ['ON_VESSEL', 'DISCHARGED', 'IN_YARD'].includes(prev.status) && prev.full_empty === 'F') return reject(`Full container still in the port (${prev.status}) — not delivered yet`);
      const cond = b.condition ?? ((b.damages?.length ?? 0) > 0 ? 'DAMAGED' : 'SOUND');
      const k = await insert(c, 'containers', { tenant_id: a.tenantId, container_no: b.containerNo, iso_type: b.isoType ?? prev?.iso_type ?? null, full_empty: 'E', status: 'AT_FACILITY', facility_id: f.id, line_org_id: line, condition: cond, facility_in_at: new Date(), updated_at: new Date() });
      await insert(c, 'container_events', { tenant_id: a.tenantId, container_id: k.id, event: 'EMPTY_RETURNED', location: f.code, source: 'UI', at: new Date() });
      const r = await accept(k, { condition: cond });
      await notify(c, a.tenantId, { orgId: line }, `Empty returned: ${b.containerNo}`, `${f.name} — ${cond === 'DAMAGED' ? 'damaged, repair estimate to follow' : 'sound'} (EIR ${r.eir_no})`, '/inland');
      return r;
    }
    case 'EMPTY_RELEASE': {
      if (b.direction !== 'OUT' || f.type !== 'EMPTY_DEPOT') return reject('Empty releases leave an empty depot (OUT)');
      const rel = b.reference ? await one(c, 'SELECT * FROM empty_releases WHERE release_no=$1', [b.reference]) : null;
      if (!rel) return reject('Release order not found');
      if (rel.facility_id !== f.id) return reject('Release order is for another depot');
      if (rel.status !== 'OPEN') return reject(`Release order is ${rel.status}`);
      if (new Date(rel.valid_until).getTime() + DAY < Date.now()) return reject('Release order expired');
      if (rel.haulier_org_id && b.haulierOrgId && rel.haulier_org_id !== b.haulierOrgId) return reject('Haulier not nominated on the release order');
      const k = b.containerNo
        ? await one(c, `SELECT * FROM containers WHERE container_no=$1 AND facility_id=$2 AND status='AT_FACILITY' ORDER BY updated_at DESC LIMIT 1`, [b.containerNo, f.id])
        : await one(c, `SELECT * FROM containers WHERE facility_id=$1 AND status='AT_FACILITY' AND full_empty='E' AND line_org_id=$2 AND iso_type=$3 AND condition='SOUND' ORDER BY facility_in_at LIMIT 1`, [f.id, rel.line_org_id, rel.iso_type]);
      if (!k) return reject(b.containerNo ? 'Container not in this depot' : `No sound ${rel.iso_type} empty available for this line`);
      if (k.line_org_id !== rel.line_org_id) return reject('Container belongs to another line');
      if (k.iso_type !== rel.iso_type) return reject(`Container is ${k.iso_type}, release is for ${rel.iso_type}`);
      if (k.condition !== 'SOUND') return reject(`Container condition is ${k.condition}`);
      b.containerNo = k.container_no;
      await containerEvent(c, a, k, 'GATED_OUT', f.code, { facility_id: null, gated_out_at: new Date() });
      const released = rel.released + 1;
      await update(c, 'empty_releases', rel.id, { released, status: released >= rel.quantity ? 'COMPLETED' : 'OPEN' });
      return accept(k, { container_no: k.container_no, line_org_id: rel.line_org_id });
    }
    case 'IMPORT_DELIVERY': {
      if (b.direction !== 'OUT') return reject('Deliveries are OUT movements');
      if (!b.containerNo) return reject('Container number required');
      const k = await one(c, `SELECT * FROM containers WHERE container_no=$1 AND facility_id=$2 AND status='AT_FACILITY' ORDER BY updated_at DESC LIMIT 1`, [b.containerNo, f.id]);
      if (!k) return reject('Container not at this facility');
      if (k.full_empty !== 'F' || !k.bl_id) return reject('Not a full import container');
      const bl = await one(c, 'SELECT * FROM bills_of_lading WHERE id=$1', [k.bl_id]);
      if (bl.customs_status !== 'RELEASED') return reject(`Customs status is ${bl.customs_status}`);
      if (k.holds?.length) return reject(`Container has holds: ${k.holds.join(', ')}`);
      const d = await one(c, `SELECT * FROM delivery_orders WHERE bl_id=$1 AND status='ISSUED' ORDER BY issued_at DESC LIMIT 1`, [k.bl_id]);
      if (!d) return reject('No issued delivery order for the B/L');
      if (b.reference && b.reference !== d.do_no && b.reference !== d.pin) return reject('Delivery order / PIN does not match');
      if (d.haulier_org_id && b.haulierOrgId && d.haulier_org_id !== b.haulierOrgId) return reject('Haulier not nominated on the delivery order');
      if (d.valid_until && new Date(d.valid_until).getTime() + DAY < Date.now()) return reject('Delivery order expired');
      await containerEvent(c, a, k, 'DELIVERED', f.code, { facility_id: null, gated_out_at: new Date() });
      const left = await one(c, `SELECT count(*)::int AS n FROM containers WHERE bl_id=$1 AND status NOT IN ('DELIVERED','GATED_OUT')`, [k.bl_id]);
      if (!left?.n) await update(c, 'delivery_orders', d.id, { status: 'USED' });
      return accept(k, { reference: d.do_no });
    }
    case 'EXPORT_RECEIPT': {
      if (b.direction !== 'IN' || f.type === 'EMPTY_DEPOT') return reject('Export containers are received IN at a dry port or CFS');
      if (!b.containerNo || !b.lineOrgId) return reject('Container number and shipping line required');
      const prev = await latestContainer(c, b.containerNo);
      if (prev?.status === 'AT_FACILITY') return reject('Container is already inside a facility');
      const k = await insert(c, 'containers', { tenant_id: a.tenantId, container_no: b.containerNo, iso_type: b.isoType ?? prev?.iso_type ?? null, full_empty: 'F', status: 'AT_FACILITY', facility_id: f.id, line_org_id: b.lineOrgId, condition: b.condition ?? 'SOUND', seal_no: b.sealNo ?? null, facility_in_at: new Date(), updated_at: new Date() });
      await insert(c, 'container_events', { tenant_id: a.tenantId, container_id: k.id, event: 'EXPORT_RECEIVED', location: f.code, source: 'UI', at: new Date() });
      return accept(k, {});
    }
    case 'EMPTY_EVACUATION': {
      if (b.direction !== 'OUT') return reject('Evacuation is an OUT movement');
      if (!b.containerNo) return reject('Container number required');
      const k = await one(c, `SELECT * FROM containers WHERE container_no=$1 AND facility_id=$2 AND status='AT_FACILITY' ORDER BY updated_at DESC LIMIT 1`, [b.containerNo, f.id]);
      if (!k) return reject('Container not at this facility');
      if (k.full_empty !== 'E') return reject('Container is not empty');
      await containerEvent(c, a, k, 'GATED_OUT', f.code, { facility_id: null, gated_out_at: new Date() });
      return accept(k, {});
    }
  }
  return reject(`Unsupported purpose ${b.purpose}`);
}

// ------------------------------------------------------------------ CFS
const JOB_SELECT = `SELECT j.*, f.name AS facility_name, f.code AS facility_code, r.name AS requester_name, b.bl_no,
    (SELECT coalesce(json_agg(l ORDER BY l.lot_no), '[]') FROM cfs_lots l WHERE l.job_id=j.id) AS lots
  FROM cfs_jobs j JOIN facilities f ON f.id=j.facility_id JOIN organisations r ON r.id=j.requester_org_id LEFT JOIN bills_of_lading b ON b.id=j.bl_id`;

async function moveJob(c: Db, a: Actor, j: any, to: CfsJobStatus, patch: Record<string, unknown> = {}) {
  if (!CFS_JOB_FLOW[j.status as CfsJobStatus].includes(to)) throw conflict(`Job is ${j.status}`);
  const r = await update(c, 'cfs_jobs', j.id, { ...patch, status: to });
  await audit(c, a, `CFS_JOB_${to}`, 'cfs_job', j.id, patch);
  await emit(c, a.tenantId, `cfs_job.${to.toLowerCase()}`, 'cfs_job', j.id, { jobNo: j.job_no, type: j.type, containerNo: j.container_no, status: to });
  return r;
}

const lotIn = z.object({
  houseBl: z.string().min(2), consignee: z.string().optional(), description: z.string().optional(), marks: z.string().optional(),
  packages: z.number().int().positive(), weightKg: z.number().nonnegative().optional(), volumeM3: z.number().nonnegative().optional(),
});

export default async function inland(app: FastifyInstance) {
  // ---------------- facilities ----------------
  app.get('/facilities', async (req) => {
    const q = z.object({ type: z.enum(FACILITY_TYPES).optional() }).parse(req.query);
    return tx(req, (c) => many(c, `SELECT f.*, o.name AS operator_name,
        (SELECT count(*)::int FROM containers k WHERE k.facility_id=f.id AND k.status='AT_FACILITY') AS containers,
        (SELECT coalesce(sum(CASE WHEN left(k.iso_type,1) IN ('4','L') THEN 2 ELSE 1 END),0)::int FROM containers k WHERE k.facility_id=f.id AND k.status='AT_FACILITY') AS teu,
        (SELECT count(*)::int FROM cfs_lots l WHERE l.facility_id=f.id AND l.status IN ('IN_STORE','PARTLY_DELIVERED')) AS lots_in_store
      FROM facilities f LEFT JOIN organisations o ON o.id=f.operator_org_id WHERE ($1::text IS NULL OR f.type=$1) ORDER BY f.type, f.name`, [q.type ?? null]));
  });

  const facilityIn = z.object({
    code: z.string().min(2).max(12), name: z.string().min(2), type: z.enum(FACILITY_TYPES), operatorOrgId: z.string().uuid().optional().nullable(),
    location: z.string().optional(), lat: z.number().optional().nullable(), lon: z.number().optional().nullable(), distanceKm: z.number().nonnegative().optional().nullable(),
    bonded: z.boolean().default(false), capacityTeu: z.number().int().positive().optional().nullable(), capacityM3: z.number().int().positive().optional().nullable(),
    freeDays: z.number().int().min(0).max(60).default(3), transitHours: z.number().int().min(1).max(240).default(24), active: z.boolean().default(true),
  });
  const facilityRow = (b: Partial<z.infer<typeof facilityIn>>) => Object.fromEntries(Object.entries({
    code: b.code, name: b.name, type: b.type, operator_org_id: b.operatorOrgId, location: b.location, lat: b.lat, lon: b.lon, distance_km: b.distanceKm,
    bonded: b.bonded, capacity_teu: b.capacityTeu, capacity_m3: b.capacityM3, free_days: b.freeDays, transit_hours: b.transitHours, active: b.active,
  }).filter(([, v]) => v !== undefined));
  app.post('/facilities', async (req) => {
    requireRole(req.actor, 'PORT_ADMIN');
    const b = facilityIn.parse(req.body);
    return tx(req, async (c) => {
      const f = await insert(c, 'facilities', { tenant_id: req.actor.tenantId, ...facilityRow(b) });
      await audit(c, req.actor, 'FACILITY_CREATED', 'facility', f.id, b);
      return f;
    });
  });
  app.patch('/facilities/:id', async (req) => {
    requireRole(req.actor, 'PORT_ADMIN');
    const { id } = req.params as { id: string };
    const b = facilityIn.partial().parse(req.body);
    return tx(req, async (c) => {
      await loadFacility(c, id);
      const f = await update(c, 'facilities', id, facilityRow(b));
      await audit(c, req.actor, 'FACILITY_UPDATED', 'facility', id, b);
      return f;
    });
  });

  /** Facility dashboard: inventory by line / type / condition, dwell, recent gate moves. Lines see only their own boxes. */
  app.get('/facilities/:id', async (req) => {
    const { id } = req.params as { id: string };
    const a = req.actor;
    return tx(req, async (c) => {
      const f = await loadFacility(c, id);
      const all = isAuthority(a) || isOperator(a, f);
      const lineFilter = all ? null : a.orgId;
      const inventory = await many(c, `SELECT k.id, k.container_no, k.iso_type, k.full_empty, k.condition, k.seal_no, k.holds, k.facility_in_at, k.status, o.name AS line_name, k.line_org_id,
          b.bl_no, b.customs_status, GREATEST(1, ceil(extract(epoch FROM now() - k.facility_in_at) / 86400))::int AS dwell_days
        FROM containers k LEFT JOIN organisations o ON o.id=k.line_org_id LEFT JOIN bills_of_lading b ON b.id=k.bl_id
        WHERE k.facility_id=$1 AND k.status='AT_FACILITY' AND ($2::uuid IS NULL OR k.line_org_id=$2 OR b.forwarder_org_id=$2 OR b.consignee_org_id=$2)
        ORDER BY k.facility_in_at`, [id, lineFilter]);
      const moves = await many(c, `SELECT m.*, h.name AS haulier_name, l.name AS line_name FROM facility_moves m LEFT JOIN organisations h ON h.id=m.haulier_org_id LEFT JOIN organisations l ON l.id=m.line_org_id
        WHERE m.facility_id=$1 AND ($2::uuid IS NULL OR m.line_org_id=$2 OR m.haulier_org_id=$2) ORDER BY m.at DESC LIMIT 50`, [id, lineFilter]);
      const stock = await many(c, `SELECT o.name AS line_name, k.iso_type, k.full_empty, k.condition, count(*)::int AS n FROM containers k LEFT JOIN organisations o ON o.id=k.line_org_id
        WHERE k.facility_id=$1 AND k.status='AT_FACILITY' AND ($2::uuid IS NULL OR k.line_org_id=$2) GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`, [id, lineFilter]);
      return { ...f, canOperate: isOperator(a, f) || hasRole(a, 'PORT_ADMIN'), inventory, stock, moves };
    });
  });

  app.post('/facilities/:id/gate', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({
      direction: z.enum(['IN', 'OUT']), purpose: z.enum(['EMPTY_RETURN', 'EMPTY_RELEASE', 'IMPORT_DELIVERY', 'EXPORT_RECEIPT', 'EMPTY_EVACUATION']),
      containerNo: cntrNo.optional(), truckPlate: z.string().min(3).max(15), haulierOrgId: z.string().uuid().optional(), lineOrgId: z.string().uuid().optional(),
      reference: z.string().max(40).optional(), isoType: z.string().max(4).optional(), condition: z.enum(['SOUND', 'DAMAGED']).optional(),
      damages: z.array(z.object({ component: z.string(), code: z.string().max(3), remarks: z.string().max(200).optional() })).max(30).optional(), sealNo: z.string().max(20).optional(),
    }).parse(req.body);
    return tx(req, async (c) => {
      const f = await loadFacility(c, id);
      requireOperator(req.actor, f);
      return facilityGate(c, req.actor, f, b);
    });
  });

  // ---------------- bonded transfers (dry port) ----------------
  app.get('/inland-transfers', async (req) => {
    const q = z.object({ status: z.string().optional(), facilityId: z.string().uuid().optional() }).parse(req.query);
    const a = req.actor;
    return tx(req, (c) => many(c, `${TRANSFER_SELECT}
      WHERE ($1 OR it.requester_org_id=$2 OR it.carrier_org_id=$2 OR f.operator_org_id=$2 OR t.operator_org_id=$2)
        AND ($3::text IS NULL OR it.status = ANY(string_to_array($3, ','))) AND ($4::uuid IS NULL OR it.facility_id=$4)
      ORDER BY it.created_at DESC LIMIT 300`, [isAuthority(a), a.orgId, q.status ?? null, q.facilityId ?? null]));
  });

  app.post('/inland-transfers', async (req) => {
    const a = req.actor;
    requireRole(a, 'FREIGHT_FORWARDER', 'SHIPPING_LINE', 'SHIPPING_AGENT', 'FACILITY_OPERATOR');
    const b = z.object({
      direction: z.enum(['TO_FACILITY', 'TO_PORT']), facilityId: z.string().uuid(), terminalId: z.string().uuid(), blId: z.string().uuid().optional(),
      containers: z.array(cntrNo).min(1).max(200), mode: z.enum(['TRUCK', 'RAIL', 'BARGE']), carrierOrgId: z.string().uuid().optional(), remarks: z.string().max(500).optional(),
    }).parse(req.body);
    return tx(req, async (c) => {
      const f = await loadFacility(c, b.facilityId);
      if (!f.active) throw badRequest('Facility is not active');
      if (f.type === 'EMPTY_DEPOT') throw badRequest('Bonded transfers go to a dry port or CFS');
      const term = await one(c, 'SELECT * FROM terminals WHERE id=$1', [b.terminalId]);
      if (!term) throw notFound('Terminal not found');
      const uniq = [...new Set(b.containers)];
      for (const no of uniq) {
        const busy = await one(c, `SELECT transfer_no FROM inland_transfers WHERE $1 = ANY(containers) AND status IN ('REQUESTED','CUSTOMS_APPROVED','IN_TRANSIT')`, [no]);
        if (busy) throw conflict(`${no} is already on transfer ${busy.transfer_no}`);
      }
      let bl: any = null;
      if (b.direction === 'TO_FACILITY') {
        if (hasRole(a, 'FACILITY_OPERATOR') && !hasRole(a, 'FREIGHT_FORWARDER', 'SHIPPING_LINE', 'SHIPPING_AGENT')) throw forbidden('Import transfers are requested by the forwarder or the line');
        for (const no of uniq) {
          const k = await latestContainer(c, no);
          if (!k) throw notFound(`Container ${no} not known to PCS`);
          if (!['DISCHARGED', 'IN_YARD'].includes(k.status)) throw badRequest(`${no} is not in the port yard (${k.status})`);
          const blocking = (k.holds ?? []).filter((h: string) => h !== 'CUSTOMS'); // customs control moves with the bond
          if (blocking.length) throw badRequest(`${no} has holds: ${blocking.join(', ')}`);
          if (b.blId && k.bl_id !== b.blId) throw badRequest(`${no} is not on the given B/L`);
          bl ??= k.bl_id ? await one(c, 'SELECT * FROM bills_of_lading WHERE id=$1', [k.bl_id]) : null;
        }
        if (bl && bl.forwarder_org_id && hasRole(a, 'FREIGHT_FORWARDER') && bl.forwarder_org_id !== a.orgId && bl.consignee_org_id !== a.orgId) throw forbidden('B/L is nominated to another forwarder');
        if (bl && ['HELD', 'UNDER_INSPECTION'].includes(bl.customs_status)) throw badRequest(`B/L is ${bl.customs_status.toLowerCase().replace('_', ' ')} by customs at the port`);
        if (bl?.customs_status !== 'RELEASED' && !f.bonded) throw badRequest(`${f.name} is not customs-bonded: uncleared cargo cannot move there`);
      } else {
        for (const no of uniq) {
          const k = await one(c, `SELECT * FROM containers WHERE container_no=$1 AND facility_id=$2 AND status='AT_FACILITY' ORDER BY updated_at DESC LIMIT 1`, [no, f.id]);
          if (!k) throw badRequest(`${no} is not at ${f.name}`);
          if (k.full_empty !== 'F') throw badRequest(`${no} is empty — export transfers carry full containers`);
        }
      }
      const t = await insert(c, 'inland_transfers', {
        tenant_id: a.tenantId, transfer_no: await nextNo(c, a.tenantId, a.tenantCode, 'IT'), direction: b.direction, facility_id: f.id, terminal_id: term.id,
        bl_id: bl?.id ?? b.blId ?? null, requester_org_id: a.orgId, carrier_org_id: b.carrierOrgId ?? null, mode: b.mode, containers: uniq, remarks: b.remarks ?? null,
      });
      await audit(c, a, 'TRANSFER_REQUESTED', 'inland_transfer', t.id, b);
      // Bonded movement of uncleared or export cargo needs a customs transit decision; cleared imports go straight away.
      if (b.direction === 'TO_FACILITY' && bl?.customs_status === 'RELEASED') {
        await update(c, 'inland_transfers', t.id, { status: 'CUSTOMS_APPROVED', remarks: [b.remarks, 'Cargo already released by customs — no transit bond needed'].filter(Boolean).join(' · ') });
      } else {
        await openApprovals(c, a.tenantId, 'inland_transfer', t.id, 'TRANSIT', ['CUSTOMS'], `${t.transfer_no} ${term.code} ${b.direction === 'TO_FACILITY' ? '→' : '←'} ${f.code} (${uniq.length} cntr)`, '/clearance');
      }
      return one(c, TRANSFER_SELECT + ' WHERE it.id=$1', [t.id]);
    });
  });

  app.post('/inland-transfers/:id/dispatch', async (req) => {
    const { id } = req.params as { id: string };
    const a = req.actor;
    return tx(req, async (c) => {
      const t = await one(c, TRANSFER_SELECT + ' WHERE it.id=$1', [id]);
      if (!t) throw notFound();
      const f = await loadFacility(c, t.facility_id);
      const term = await one(c, 'SELECT * FROM terminals WHERE id=$1', [t.terminal_id]);
      const origin = t.direction === 'TO_FACILITY' ? term.operator_org_id : f.operator_org_id;
      if (a.orgId !== origin && a.orgId !== t.carrier_org_id && !hasRole(a, 'PORT_ADMIN')) throw forbidden('Only the origin (terminal / facility) or the carrier dispatches');
      for (const no of t.containers) {
        const k = t.direction === 'TO_FACILITY' ? await latestContainer(c, no) : await one(c, `SELECT * FROM containers WHERE container_no=$1 AND facility_id=$2 ORDER BY updated_at DESC LIMIT 1`, [no, f.id]);
        if (!k) throw notFound(`Container ${no} not found`);
        await containerEvent(c, a, k, 'IN_TRANSIT', t.direction === 'TO_FACILITY' ? term.code : f.code, { facility_id: null, gated_out_at: new Date() });
      }
      return moveTransfer(c, a, t, 'IN_TRANSIT', { dispatched_at: new Date() });
    });
  });

  app.post('/inland-transfers/:id/arrive', async (req) => {
    const { id } = req.params as { id: string };
    const a = req.actor;
    return tx(req, async (c) => {
      const t = await one(c, TRANSFER_SELECT + ' WHERE it.id=$1', [id]);
      if (!t) throw notFound();
      const f = await loadFacility(c, t.facility_id);
      const term = await one(c, 'SELECT * FROM terminals WHERE id=$1', [t.terminal_id]);
      const dest = t.direction === 'TO_FACILITY' ? f.operator_org_id : term.operator_org_id;
      if (a.orgId !== dest && !hasRole(a, 'PORT_ADMIN')) throw forbidden('Only the destination confirms arrival');
      for (const no of t.containers) {
        const k = await latestContainer(c, no);
        if (t.direction === 'TO_FACILITY') {
          await containerEvent(c, a, k, 'AT_FACILITY', f.code, { facility_id: f.id, facility_in_at: new Date(), condition: k.condition ?? 'SOUND' });
          await insert(c, 'facility_moves', { tenant_id: a.tenantId, facility_id: f.id, eir_no: await nextNo(c, a.tenantId, a.tenantCode, 'EIR'), direction: 'IN', purpose: 'TRANSFER', container_no: no, full_empty: k.full_empty, truck_plate: t.mode, reference: t.transfer_no, line_org_id: k.line_org_id, result: 'ACCEPTED', created_by: a.userId });
        } else {
          await containerEvent(c, a, k, 'GATED_IN', term.code, { terminal_id: term.id, gated_in_at: new Date() });
        }
      }
      const late = t.transit_deadline && new Date(t.transit_deadline).getTime() < Date.now();
      const r = await moveTransfer(c, a, t, 'ARRIVED', { arrived_at: new Date(), remarks: late ? [t.remarks, 'Arrived after the transit deadline'].filter(Boolean).join(' · ') : t.remarks });
      if (late) await notify(c, a.tenantId, { role: 'CUSTOMS' }, `Late transit arrival: ${t.transfer_no}`, `${t.transit_doc_no} arrived after its deadline`, '/inland', 'warning');
      await notify(c, a.tenantId, { orgId: t.requester_org_id }, `Transfer arrived: ${t.transfer_no}`, `${t.containers.length} container(s) at ${t.direction === 'TO_FACILITY' ? f.name : term.name}`, '/inland', 'success');
      await generateInvoice(c, a, 'inland_transfer', t.id);
      return r;
    });
  });

  app.post('/inland-transfers/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const t = await one(c, TRANSFER_SELECT + ' WHERE it.id=$1', [id]);
      if (!t) throw notFound();
      if (t.requester_org_id !== req.actor.orgId && !hasRole(req.actor, 'PORT_ADMIN')) throw forbidden();
      await c.query(`UPDATE approvals SET status='REJECTED', remarks='Withdrawn by requester' WHERE entity_type='inland_transfer' AND entity_id=$1 AND status='PENDING'`, [id]);
      return moveTransfer(c, req.actor, t, 'CANCELLED');
    });
  });

  // ---------------- empty depot: repairs and releases ----------------
  app.get('/depot/repairs', async (req) => {
    const a = req.actor;
    return tx(req, (c) => many(c, `SELECT r.*, f.name AS facility_name, l.name AS line_name FROM depot_repairs r JOIN facilities f ON f.id=r.facility_id JOIN organisations l ON l.id=r.line_org_id
      WHERE ($1 OR r.line_org_id=$2 OR f.operator_org_id=$2) ORDER BY r.status='ESTIMATED' DESC, r.created_at DESC LIMIT 300`, [isAuthority(a), a.orgId]));
  });
  app.post('/depot/repairs', async (req) => {
    const b = z.object({
      facilityId: z.string().uuid(), containerNo: cntrNo, remarks: z.string().max(500).optional(),
      items: z.array(z.object({ component: z.string(), damage: z.string(), repair: z.string(), hours: z.number().nonnegative(), material: z.number().nonnegative() })).min(1).max(30),
    }).parse(req.body);
    return tx(req, async (c) => {
      const f = await loadFacility(c, b.facilityId);
      requireOperator(req.actor, f);
      const k = await one(c, `SELECT * FROM containers WHERE container_no=$1 AND facility_id=$2 AND status='AT_FACILITY' ORDER BY updated_at DESC LIMIT 1`, [b.containerNo, f.id]);
      if (!k) throw badRequest('Container is not in this depot');
      if (!k.line_org_id) throw badRequest('Container owner unknown');
      const t = await getTenant(req.actor.tenantId);
      const labour = Number((t.settings as any).depotLabourRate ?? 30);
      const items = b.items.map((i) => ({ ...i, amount: Math.round((i.hours * labour + i.material) * 100) / 100 }));
      const total = Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100;
      const r = await insert(c, 'depot_repairs', { tenant_id: req.actor.tenantId, estimate_no: await nextNo(c, req.actor.tenantId, req.actor.tenantCode, 'MR'), facility_id: f.id, container_no: b.containerNo, line_org_id: k.line_org_id, items: JSON.stringify(items), total, currency: t.currency, remarks: b.remarks ?? null });
      await update(c, 'containers', k.id, { condition: 'DAMAGED', updated_at: new Date() });
      await audit(c, req.actor, 'REPAIR_ESTIMATED', 'depot_repair', r.id, { total });
      await notify(c, req.actor.tenantId, { orgId: k.line_org_id }, `Repair estimate ${r.estimate_no}: ${b.containerNo}`, `${t.currency} ${total.toFixed(2)} at ${f.name} — approval needed`, '/inland', 'warning');
      return r;
    });
  });
  for (const [action, to] of [['approve', 'APPROVED'], ['reject', 'REJECTED']] as const) {
    app.post(`/depot/repairs/:id/${action}`, async (req) => {
      const { id } = req.params as { id: string };
      return tx(req, async (c) => {
        const r = await one(c, 'SELECT * FROM depot_repairs WHERE id=$1', [id]);
        if (!r) throw notFound();
        if (r.line_org_id !== req.actor.orgId) throw forbidden('Only the container owner decides repair estimates');
        if (r.status !== 'ESTIMATED') throw conflict(`Estimate is ${r.status}`);
        const out = await update(c, 'depot_repairs', id, { status: to, decided_at: new Date() });
        if (to === 'APPROVED') await c.query(`UPDATE containers SET condition='UNDER_REPAIR', updated_at=now() WHERE container_no=$1 AND facility_id=$2 AND status='AT_FACILITY'`, [r.container_no, r.facility_id]);
        await audit(c, req.actor, `REPAIR_${to}`, 'depot_repair', id);
        const f = await loadFacility(c, r.facility_id);
        if (f.operator_org_id) await notify(c, req.actor.tenantId, { orgId: f.operator_org_id }, `Repair ${to.toLowerCase()}: ${r.estimate_no}`, r.container_no, '/inland', to === 'APPROVED' ? 'success' : 'warning');
        return out;
      });
    });
  }
  app.post('/depot/repairs/:id/complete', async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const r = await one(c, 'SELECT * FROM depot_repairs WHERE id=$1', [id]);
      if (!r) throw notFound();
      requireOperator(req.actor, await loadFacility(c, r.facility_id));
      if (r.status !== 'APPROVED') throw conflict(`Estimate is ${r.status}`);
      const out = await update(c, 'depot_repairs', id, { status: 'COMPLETED', completed_at: new Date() });
      await c.query(`UPDATE containers SET condition='SOUND', updated_at=now() WHERE container_no=$1 AND facility_id=$2 AND status='AT_FACILITY'`, [r.container_no, r.facility_id]);
      await audit(c, req.actor, 'REPAIR_COMPLETED', 'depot_repair', id);
      await generateInvoice(c, req.actor, 'depot_repair', id);
      return out;
    });
  });

  app.get('/depot/releases', async (req) => {
    const a = req.actor;
    return tx(req, (c) => many(c, `SELECT r.*, f.name AS facility_name, l.name AS line_name, h.name AS haulier_name,
        (SELECT count(*)::int FROM containers k WHERE k.facility_id=r.facility_id AND k.status='AT_FACILITY' AND k.full_empty='E' AND k.line_org_id=r.line_org_id AND k.iso_type=r.iso_type AND k.condition='SOUND') AS available
      FROM empty_releases r JOIN facilities f ON f.id=r.facility_id JOIN organisations l ON l.id=r.line_org_id LEFT JOIN organisations h ON h.id=r.haulier_org_id
      WHERE ($1 OR r.line_org_id=$2 OR r.haulier_org_id=$2 OR f.operator_org_id=$2) ORDER BY r.status='OPEN' DESC, r.created_at DESC LIMIT 300`, [isAuthority(a), a.orgId]));
  });
  app.post('/depot/releases', async (req) => {
    requireRole(req.actor, 'SHIPPING_LINE', 'SHIPPING_AGENT');
    const b = z.object({ facilityId: z.string().uuid(), bookingNo: z.string().min(3).max(30), isoType: z.string().min(4).max(4), quantity: z.number().int().min(1).max(500), haulierOrgId: z.string().uuid().optional(), validUntil: z.coerce.date() }).parse(req.body);
    return tx(req, async (c) => {
      const f = await loadFacility(c, b.facilityId);
      if (f.type !== 'EMPTY_DEPOT') throw badRequest('Empty releases are issued against an empty depot');
      const avail = await one(c, `SELECT count(*)::int AS n FROM containers WHERE facility_id=$1 AND status='AT_FACILITY' AND full_empty='E' AND line_org_id=$2 AND iso_type=$3 AND condition='SOUND'`, [f.id, req.actor.orgId, b.isoType]);
      const r = await insert(c, 'empty_releases', { tenant_id: req.actor.tenantId, release_no: await nextNo(c, req.actor.tenantId, req.actor.tenantCode, 'ER'), facility_id: f.id, line_org_id: req.actor.orgId, booking_no: b.bookingNo, iso_type: b.isoType, quantity: b.quantity, haulier_org_id: b.haulierOrgId ?? null, valid_until: b.validUntil });
      await audit(c, req.actor, 'EMPTY_RELEASE_ISSUED', 'empty_release', r.id, b);
      if (b.haulierOrgId) await notify(c, req.actor.tenantId, { orgId: b.haulierOrgId }, `Empty release ${r.release_no}`, `${b.quantity} × ${b.isoType} at ${f.name} for booking ${b.bookingNo}`, '/inland');
      if (f.operator_org_id) await notify(c, req.actor.tenantId, { orgId: f.operator_org_id }, `Empty release ${r.release_no}`, `${b.quantity} × ${b.isoType}`, '/inland');
      return { ...r, available: avail?.n ?? 0, warning: (avail?.n ?? 0) < b.quantity ? `Only ${avail?.n ?? 0} sound ${b.isoType} available now` : null };
    });
  });
  app.post('/depot/releases/:id/cancel', async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const r = await one(c, 'SELECT * FROM empty_releases WHERE id=$1', [id]);
      if (!r) throw notFound();
      if (r.line_org_id !== req.actor.orgId) throw forbidden();
      if (r.status !== 'OPEN') throw conflict(`Release is ${r.status}`);
      return update(c, 'empty_releases', id, { status: 'CANCELLED' });
    });
  });

  // ---------------- CFS ----------------
  app.get('/cfs/jobs', async (req) => {
    const a = req.actor;
    return tx(req, (c) => many(c, `${JOB_SELECT} WHERE ($1 OR j.requester_org_id=$2 OR f.operator_org_id=$2) ORDER BY j.created_at DESC LIMIT 200`, [isAuthority(a), a.orgId]));
  });
  app.post('/cfs/jobs', async (req) => {
    const a = req.actor;
    requireRole(a, 'FREIGHT_FORWARDER', 'SHIPPING_LINE', 'SHIPPING_AGENT');
    const b = z.object({
      facilityId: z.string().uuid(), type: z.enum(['DESTUFF', 'STUFF']), containerNo: cntrNo, lineOrgId: z.string().uuid().optional(),
      lots: z.array(lotIn).max(200).default([]), lotIds: z.array(z.string().uuid()).max(200).default([]), scheduledAt: z.coerce.date().optional(), remarks: z.string().max(500).optional(),
    }).parse(req.body);
    return tx(req, async (c) => {
      const f = await loadFacility(c, b.facilityId);
      if (f.type !== 'CFS') throw badRequest('Stuffing and destuffing take place at a CFS');
      const open = await one(c, `SELECT job_no FROM cfs_jobs WHERE container_no=$1 AND status IN ('REQUESTED','SCHEDULED','IN_PROGRESS')`, [b.containerNo]);
      if (open) throw conflict(`Container already has open job ${open.job_no}`);
      let k = await one(c, `SELECT * FROM containers WHERE container_no=$1 AND facility_id=$2 AND status='AT_FACILITY' ORDER BY updated_at DESC LIMIT 1`, [b.containerNo, f.id]);
      const job = { tenant_id: a.tenantId, job_no: await nextNo(c, a.tenantId, a.tenantCode, 'CFS'), facility_id: f.id, type: b.type, container_no: b.containerNo, requester_org_id: a.orgId, scheduled_at: b.scheduledAt ?? null, status: b.scheduledAt ? 'SCHEDULED' : 'REQUESTED', remarks: b.remarks ?? null } as Record<string, unknown>;
      if (b.type === 'DESTUFF') {
        if (!k) throw badRequest(`${b.containerNo} is not at ${f.name} — transfer or deliver it there first`);
        if (k.full_empty !== 'F') throw badRequest('Container is empty');
        if (!b.lots.length) throw badRequest('Give the house B/Ls (lots) in the container');
        job.bl_id = k.bl_id;
      } else {
        if (!b.lotIds.length) throw badRequest('Select the export lots to stuff');
        if (k && k.full_empty !== 'E') throw badRequest('Container is not empty');
        if (!k) {
          if (!b.lineOrgId) throw badRequest('Empty container is not at the CFS: give its shipping line to register it');
          k = await insert(c, 'containers', { tenant_id: a.tenantId, container_no: b.containerNo, full_empty: 'E', status: 'AT_FACILITY', facility_id: f.id, line_org_id: b.lineOrgId, condition: 'SOUND', facility_in_at: new Date(), updated_at: new Date() });
        }
      }
      const j = await insert(c, 'cfs_jobs', job);
      if (b.type === 'DESTUFF') {
        for (const [i, l] of b.lots.entries()) await insert(c, 'cfs_lots', {
          tenant_id: a.tenantId, lot_no: `${j.job_no}-${String(i + 1).padStart(2, '0')}`, facility_id: f.id, job_id: j.id, direction: 'IMPORT', house_bl: l.houseBl, owner_org_id: a.orgId,
          consignee: l.consignee ?? null, description: l.description ?? null, marks: l.marks ?? null, packages: l.packages, weight_kg: l.weightKg ?? null, volume_m3: l.volumeM3 ?? null,
        });
      } else {
        for (const id of b.lotIds) {
          const l = await one(c, 'SELECT * FROM cfs_lots WHERE id=$1', [id]);
          if (!l || l.facility_id !== f.id || l.direction !== 'EXPORT') throw badRequest('Lot is not an export lot at this CFS');
          if (l.owner_org_id !== a.orgId) throw forbidden(`Lot ${l.lot_no} belongs to another forwarder`);
          if (l.status !== 'IN_STORE') throw badRequest(`Lot ${l.lot_no} is ${l.status}`);
          if (l.customs_status !== 'RELEASED') throw badRequest(`Lot ${l.lot_no}: export customs status is ${l.customs_status}`);
          await update(c, 'cfs_lots', id, { job_id: j.id });
        }
      }
      await audit(c, a, 'CFS_JOB_REQUESTED', 'cfs_job', j.id, b);
      if (f.operator_org_id) await notify(c, a.tenantId, { orgId: f.operator_org_id }, `${b.type === 'DESTUFF' ? 'Destuffing' : 'Stuffing'} request ${j.job_no}`, b.containerNo, '/inland', 'info');
      return one(c, JOB_SELECT + ' WHERE j.id=$1', [j.id]);
    });
  });

  app.post('/cfs/jobs/:id/:action', async (req) => {
    const { id, action } = req.params as { id: string; action: string };
    const a = req.actor;
    return tx(req, async (c) => {
      const j = await one(c, JOB_SELECT + ' WHERE j.id=$1', [id]);
      if (!j) throw notFound();
      const f = await loadFacility(c, j.facility_id);
      if (action === 'cancel') {
        if (j.requester_org_id !== a.orgId && !isOperator(a, f)) throw forbidden();
        if (j.type === 'STUFF') await c.query('UPDATE cfs_lots SET job_id=NULL WHERE job_id=$1', [id]);
        else await c.query(`DELETE FROM cfs_lots WHERE job_id=$1 AND status='EXPECTED'`, [id]);
        return moveJob(c, a, j, 'CANCELLED');
      }
      requireOperator(a, f);
      if (action === 'schedule') {
        const b = z.object({ at: z.coerce.date() }).parse(req.body ?? {});
        return moveJob(c, a, j, 'SCHEDULED', { scheduled_at: b.at });
      }
      if (action === 'start') return moveJob(c, a, j, 'IN_PROGRESS', { started_at: new Date() });
      if (action !== 'complete') throw notFound();
      const b = z.object({
        sealNo: z.string().max(20).optional(),
        tally: z.array(z.object({ lotId: z.string().uuid(), packagesReceived: z.number().int().min(0), packagesDamaged: z.number().int().min(0).default(0), location: z.string().max(30).optional() })).default([]),
      }).parse(req.body ?? {});
      const k = await one(c, `SELECT * FROM containers WHERE container_no=$1 AND facility_id=$2 AND status='AT_FACILITY' ORDER BY updated_at DESC LIMIT 1`, [j.container_no, f.id]);
      if (!k) throw badRequest('Container is no longer at the CFS');
      const exceptions: string[] = [];
      if (j.type === 'DESTUFF') {
        for (const l of j.lots) {
          const t = b.tally.find((x) => x.lotId === l.id);
          const got = t?.packagesReceived ?? l.packages;
          if (got !== l.packages) exceptions.push(`${l.house_bl}: ${got}/${l.packages} pkgs`);
          if (t?.packagesDamaged) exceptions.push(`${l.house_bl}: ${t.packagesDamaged} damaged`);
          await update(c, 'cfs_lots', l.id, { packages_received: got, packages_damaged: t?.packagesDamaged ?? 0, location: t?.location ?? null, status: got === 0 ? 'SHORT_LANDED' : 'IN_STORE', received_at: new Date() });
        }
        await containerEvent(c, a, k, 'AT_FACILITY', f.code, { full_empty: 'E' });
        await insert(c, 'container_events', { tenant_id: a.tenantId, container_id: k.id, event: 'DESTUFFED', location: f.code, source: 'UI', at: new Date() });
      } else {
        if (!b.sealNo) throw badRequest('Seal number required after stuffing');
        const w = j.lots.reduce((s: number, l: any) => s + Number(l.weight_kg ?? 0), 0);
        await c.query(`UPDATE cfs_lots SET status='STUFFED' WHERE job_id=$1`, [id]);
        await update(c, 'containers', k.id, { full_empty: 'F', seal_no: b.sealNo, gross_kg: w || null, updated_at: new Date() });
        await insert(c, 'container_events', { tenant_id: a.tenantId, container_id: k.id, event: 'STUFFED', location: f.code, source: 'UI', at: new Date() });
      }
      const r = await moveJob(c, a, j, 'COMPLETED', { completed_at: new Date(), seal_no: b.sealNo ?? null, remarks: exceptions.length ? [j.remarks, `Tally exceptions: ${exceptions.join('; ')}`].filter(Boolean).join(' · ') : j.remarks });
      await notify(c, a.tenantId, { orgId: j.requester_org_id }, `${j.type === 'DESTUFF' ? 'Destuffing' : 'Stuffing'} completed: ${j.job_no}`, exceptions.length ? `Exceptions: ${exceptions.join('; ')}` : j.container_no, '/inland', exceptions.length ? 'warning' : 'success');
      await generateInvoice(c, a, 'cfs_job', id);
      return { ...r, exceptions };
    });
  });

  app.get('/cfs/lots', async (req) => {
    const q = z.object({ facilityId: z.string().uuid().optional(), status: z.string().optional(), direction: z.enum(['IMPORT', 'EXPORT']).optional() }).parse(req.query);
    const a = req.actor;
    return tx(req, (c) => many(c, `SELECT l.*, f.name AS facility_name, o.name AS owner_name, j.job_no, j.container_no FROM cfs_lots l JOIN facilities f ON f.id=l.facility_id JOIN organisations o ON o.id=l.owner_org_id LEFT JOIN cfs_jobs j ON j.id=l.job_id
      WHERE ($1 OR l.owner_org_id=$2 OR f.operator_org_id=$2) AND ($3::uuid IS NULL OR l.facility_id=$3) AND ($4::text IS NULL OR l.status = ANY(string_to_array($4, ','))) AND ($5::text IS NULL OR l.direction=$5)
      ORDER BY l.created_at DESC LIMIT 500`, [isAuthority(a), a.orgId, q.facilityId ?? null, q.status ?? null, q.direction ?? null]));
  });

  /** Export cargo pre-advised by the forwarder; the CFS receives it into the shed. */
  app.post('/cfs/lots', async (req) => {
    requireRole(req.actor, 'FREIGHT_FORWARDER');
    const b = lotIn.extend({ facilityId: z.string().uuid() }).parse(req.body);
    return tx(req, async (c) => {
      const f = await loadFacility(c, b.facilityId);
      if (f.type !== 'CFS') throw badRequest('Not a CFS');
      return insert(c, 'cfs_lots', {
        tenant_id: req.actor.tenantId, lot_no: await nextNo(c, req.actor.tenantId, req.actor.tenantCode, 'LOT'), facility_id: f.id, direction: 'EXPORT', house_bl: b.houseBl, owner_org_id: req.actor.orgId,
        consignee: b.consignee ?? null, description: b.description ?? null, marks: b.marks ?? null, packages: b.packages, weight_kg: b.weightKg ?? null, volume_m3: b.volumeM3 ?? null,
      });
    });
  });

  app.post('/cfs/lots/:id/:action', async (req) => {
    const { id, action } = req.params as { id: string; action: string };
    const a = req.actor;
    return tx(req, async (c) => {
      const l = await one(c, 'SELECT * FROM cfs_lots WHERE id=$1', [id]);
      if (!l) throw notFound();
      const f = await loadFacility(c, l.facility_id);
      switch (action) {
        case 'receive': {
          requireOperator(a, f);
          const b = z.object({ packagesReceived: z.number().int().min(0), packagesDamaged: z.number().int().min(0).default(0), location: z.string().max(30).optional(), truckPlate: z.string().min(3).max(15) }).parse(req.body);
          if (l.direction !== 'EXPORT' || l.status !== 'EXPECTED') throw conflict('Only expected export lots are received at the shed');
          await insert(c, 'facility_moves', { tenant_id: a.tenantId, facility_id: f.id, eir_no: await nextNo(c, a.tenantId, a.tenantCode, 'EIR'), direction: 'IN', purpose: 'EXPORT_RECEIPT', truck_plate: b.truckPlate.toUpperCase(), reference: l.lot_no, result: 'ACCEPTED', created_by: a.userId });
          return update(c, 'cfs_lots', id, { packages_received: b.packagesReceived, packages_damaged: b.packagesDamaged, location: b.location ?? null, status: 'IN_STORE', received_at: new Date() });
        }
        case 'declaration': {
          if (l.owner_org_id !== a.orgId) throw forbidden('Only the lot owner declares it');
          const b = z.object({ declarationNo: z.string().min(4).max(40) }).parse(req.body);
          if (!['NOT_DECLARED', 'HELD'].includes(l.customs_status)) throw conflict(`Lot is ${l.customs_status}`);
          const r = await update(c, 'cfs_lots', id, { declaration_no: b.declarationNo, customs_status: 'DECLARED' });
          await notify(c, a.tenantId, { role: 'CUSTOMS' }, `CFS lot declared: ${l.house_bl}`, `${b.declarationNo} at ${f.name}`, '/inland', 'info');
          return r;
        }
        case 'customs-status': {
          requireRole(a, 'CUSTOMS');
          const b = z.object({ status: z.enum(['UNDER_INSPECTION', 'RELEASED', 'HELD']), remarks: z.string().max(500).optional() }).parse(req.body);
          if (l.customs_status === 'NOT_DECLARED') throw conflict('Lot has not been declared');
          const r = await update(c, 'cfs_lots', id, { customs_status: b.status });
          await audit(c, a, `CFS_LOT_${b.status}`, 'cfs_lot', id, b);
          await notify(c, a.tenantId, { orgId: l.owner_org_id }, `Customs ${b.status.toLowerCase().replace('_', ' ')}: ${l.house_bl}`, b.remarks ?? f.name, '/inland', b.status === 'RELEASED' ? 'success' : 'warning');
          return r;
        }
        case 'deliver': {
          requireOperator(a, f);
          const b = z.object({ packages: z.number().int().positive(), truckPlate: z.string().min(3).max(15), haulierOrgId: z.string().uuid().optional() }).parse(req.body);
          if (l.direction !== 'IMPORT') throw conflict('Export lots leave the CFS by stuffing');
          if (!['IN_STORE', 'PARTLY_DELIVERED'].includes(l.status)) throw conflict(`Lot is ${l.status}`);
          if (l.customs_status !== 'RELEASED') throw conflict(`Customs status is ${l.customs_status}`);
          const remaining = Number(l.packages_received ?? l.packages) - Number(l.packages_delivered);
          if (b.packages > remaining) throw badRequest(`Only ${remaining} package(s) remain`);
          const delivered = Number(l.packages_delivered) + b.packages;
          const m = await insert(c, 'facility_moves', {
            tenant_id: a.tenantId, facility_id: f.id, eir_no: await nextNo(c, a.tenantId, a.tenantCode, 'EIR'), direction: 'OUT', purpose: 'CFS_DELIVERY', truck_plate: b.truckPlate.toUpperCase(),
            haulier_org_id: b.haulierOrgId ?? null, reference: l.lot_no, result: 'ACCEPTED', created_by: a.userId,
            dwell_days: l.received_at ? Math.max(1, Math.ceil((Date.now() - new Date(l.received_at).getTime()) / DAY)) : null,
          });
          await emit(c, a.tenantId, 'cfs_lot.delivered', 'cfs_lot', id, { lotNo: l.lot_no, houseBl: l.house_bl, packages: b.packages });
          const total = Number(l.packages_received ?? l.packages);
          const r = await update(c, 'cfs_lots', id, { packages_delivered: delivered, status: delivered >= total ? 'DELIVERED' : 'PARTLY_DELIVERED', delivered_at: new Date() });
          return { ...r, eirNo: m.eir_no };
        }
      }
      throw notFound();
    });
  });

  // ---------------- overview for the inland page ----------------
  app.get('/inland/summary', async (req) => {
    const a = req.actor;
    return tx(req, (c) => one(c, `SELECT
        (SELECT count(*)::int FROM inland_transfers it JOIN facilities f ON f.id=it.facility_id WHERE it.status='IN_TRANSIT' AND ($1 OR it.requester_org_id=$2 OR it.carrier_org_id=$2 OR f.operator_org_id=$2)) AS in_transit,
        (SELECT count(*)::int FROM inland_transfers it JOIN facilities f ON f.id=it.facility_id WHERE it.status='IN_TRANSIT' AND it.transit_deadline < now() AND ($1 OR it.requester_org_id=$2 OR f.operator_org_id=$2)) AS overdue,
        (SELECT count(*)::int FROM inland_transfers it WHERE it.status='REQUESTED' AND ($1 OR it.requester_org_id=$2)) AS awaiting_customs,
        (SELECT count(*)::int FROM containers k JOIN facilities f ON f.id=k.facility_id WHERE k.status='AT_FACILITY' AND f.type='EMPTY_DEPOT' AND k.full_empty='E' AND ($1 OR k.line_org_id=$2 OR f.operator_org_id=$2)) AS empties,
        (SELECT count(*)::int FROM depot_repairs r JOIN facilities f ON f.id=r.facility_id WHERE r.status='ESTIMATED' AND ($1 OR r.line_org_id=$2 OR f.operator_org_id=$2)) AS repairs_pending,
        (SELECT count(*)::int FROM cfs_lots l JOIN facilities f ON f.id=l.facility_id WHERE l.status IN ('IN_STORE','PARTLY_DELIVERED') AND ($1 OR l.owner_org_id=$2 OR f.operator_org_id=$2)) AS lots_in_store`, [isAuthority(a), a.orgId]));
  });
}

