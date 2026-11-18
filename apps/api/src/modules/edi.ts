// FR-INT: EDI gateway. Inbound UN/EDIFACT CUSCAR (manifest), CODECO / COARRI (container moves), BERMAN (berth notification)
// and CUSRES (customs response); every inbound interchange is stored and acknowledged with APERAK. Outbound CUSCAR for customs.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isValidImo } from '@pcs/shared';
import { one, many, insert, update, nextNo, type Db } from '../core/db.js';
import { tx, audit, notFound, requireRole, isAuthority, type Actor } from '../core/context.js';
import { parse, build, el, ediDate, toEdiDate, type Segment } from '../core/edifact.js';
import { upsertManifest, applyContainerEvent, setCustomsStatus, manifestIn } from './cargo.js';

type Handler = (c: Db, a: Actor, segs: Segment[]) => Promise<{ summary: string; entityType?: string; entityId?: string; warnings?: string[] }>;

const CODECO_EVENTS: Record<string, string> = { '34': 'GATED_IN', '36': 'GATED_OUT' }; // BGM document codes
const COARRI_EVENTS: Record<string, string> = { '44': 'DISCHARGED', '46': 'LOADED' };

async function findCall(c: Db, segs: Segment[]) {
  const tdt = segs.find((s) => s.tag === 'TDT');
  const voyage = tdt ? el(tdt, 1) : '';
  const imo = tdt ? (tdt.elements[7]?.[0] ?? '') : '';
  const rffVoyage = segs.find((s) => s.tag === 'RFF' && el(s, 0) === 'VON');
  const callNo = segs.find((s) => s.tag === 'RFF' && el(s, 0) === 'ATZ');
  if (callNo) { const r = await one(c, 'SELECT * FROM vessel_calls WHERE call_no=$1', [el(callNo, 0, 1)]); if (r) return r; }
  return one(c, `SELECT vc.* FROM vessel_calls vc JOIN vessels v ON v.id=vc.vessel_id
    WHERE (v.imo=$1 OR $1='') AND (vc.voyage_in=$2 OR vc.voyage_out=$2) AND vc.status NOT IN ('CANCELLED','DEPARTED') ORDER BY vc.eta DESC LIMIT 1`, [imo, rffVoyage ? el(rffVoyage, 0, 1) : voyage]);
}

const handlers: Record<string, Handler> = {
  // CUSCAR: bills of lading (RFF+BM), goods (GID/FTX/MEA), equipment (EQD+CN)
  async CUSCAR(c, a, segs) {
    const call = await findCall(c, segs);
    if (!call) throw new Error('No active vessel call matches TDT voyage / IMO');
    const bgm = segs.find((s) => s.tag === 'BGM');
    const direction = el(bgm ?? { tag: '', elements: [] }, 0) === '785' ? 'EXPORT' : 'IMPORT';
    const bls: any[] = [];
    let bl: any = null, eqd: any = null;
    for (const s of segs) {
      if (s.tag === 'CNI') { bl = { blNo: '', containers: [] }; bls.push(bl); }
      if (!bl) continue;
      if (s.tag === 'RFF' && el(s, 0) === 'BM') bl.blNo = el(s, 0, 1);
      if (s.tag === 'NAD' && el(s, 0) === 'CZ') bl.shipper = el(s, 3) || el(s, 1);
      if (s.tag === 'NAD' && el(s, 0) === 'CN') bl.consignee = el(s, 3) || el(s, 1);
      if (s.tag === 'NAD' && el(s, 0) === 'N1') bl.notifyParty = el(s, 3) || el(s, 1);
      if (s.tag === 'LOC' && el(s, 0) === '9') bl.pol = el(s, 1);
      if (s.tag === 'LOC' && el(s, 0) === '11') bl.pod = el(s, 1);
      if (s.tag === 'GID') bl.packages = Number(el(s, 1)) || undefined;
      if (s.tag === 'FTX' && el(s, 0) === 'AAA') bl.description = s.elements[3]?.join(' ');
      if (s.tag === 'PIA') bl.hsCode = el(s, 1).replace(/\D/g, '') || undefined;
      if (s.tag === 'MEA' && el(s, 1) === 'G' && !eqd) bl.grossKg = Number(el(s, 2, 1)) || undefined;
      if (s.tag === 'EQD' && el(s, 0) === 'CN') { eqd = { containerNo: el(s, 1), isoType: el(s, 2), fullEmpty: el(s, 5) === '4' ? 'E' : 'F' }; bl.containers.push(eqd); }
      if (s.tag === 'SEL' && eqd) eqd.sealNo = el(s, 0);
      if (s.tag === 'MEA' && eqd && el(s, 1) === 'G') eqd.grossKg = Number(el(s, 2, 1)) || undefined;
      if (s.tag === 'CNI') eqd = null;
    }
    const body = manifestIn.parse({ direction, bls });
    const m = await upsertManifest(c, a, call.id, body, 'EDI');
    return { summary: `${direction} manifest v${m.version} for ${call.call_no}: ${m.bls} B/L, ${m.containers} containers`, entityType: 'manifest', entityId: m.id };
  },

  async CODECO(c, a, segs) {
    const code = el(segs.find((s) => s.tag === 'BGM')!, 0);
    const ev = CODECO_EVENTS[code];
    if (!ev) throw new Error(`Unsupported CODECO BGM code ${code} (expected 34 gate-in / 36 gate-out)`);
    return containerMoves(c, a, segs, ev, 'CODECO');
  },

  async COARRI(c, a, segs) {
    const code = el(segs.find((s) => s.tag === 'BGM')!, 0);
    const ev = COARRI_EVENTS[code];
    if (!ev) throw new Error(`Unsupported COARRI BGM code ${code} (expected 44 discharge / 46 load)`);
    return containerMoves(c, a, segs, ev, 'COARRI');
  },

  // BERMAN (PROTECT): berth management notification → draft vessel call for the sending agent
  async BERMAN(c, a, segs) {
    const tdt = segs.find((s) => s.tag === 'TDT');
    if (!tdt) throw new Error('TDT segment missing');
    const imo = tdt.elements[7]?.[0] ?? '';
    if (!isValidImo(imo)) throw new Error(`Invalid IMO in TDT: ${imo}`);
    const v = await one(c, 'SELECT id FROM vessels WHERE imo=$1', [imo]);
    if (!v) throw new Error(`Vessel IMO ${imo} not registered`);
    const dtm = (q: string) => { const s = segs.find((x) => x.tag === 'DTM' && el(x, 0) === q); return s ? ediDate(el(s, 0, 1)) : null; };
    const eta = dtm('132'), etd = dtm('133');
    if (!eta || !etd) throw new Error('DTM+132 (ETA) and DTM+133 (ETD) are required');
    const loc = (q: string) => segs.find((x) => x.tag === 'LOC' && el(x, 0) === q);
    const callNo = await nextNo(c, a.tenantId, a.tenantCode, 'VC');
    const r = await insert(c, 'vessel_calls', {
      tenant_id: a.tenantId, call_no: callNo, vessel_id: v.id, agent_org_id: a.orgId, voyage_in: el(tdt, 1), voyage_out: el(tdt, 1),
      eta, etd, last_port: loc('61') ? el(loc('61')!, 1) : null, next_port: loc('92') ? el(loc('92')!, 1) : null,
    });
    await audit(c, a, 'VESSEL_CALL_CREATED', 'vessel_call', r.id, { callNo, source: 'BERMAN' });
    return { summary: `Draft vessel call ${callNo} created`, entityType: 'vessel_call', entityId: r.id };
  },

  // CUSRES: customs response (release / hold) keyed by B/L (RFF+BM) and declaration (RFF+ABT)
  async CUSRES(c, a, segs) {
    const status = { '1': 'RELEASED', '2': 'HELD', '3': 'UNDER_INSPECTION' }[el(segs.find((s) => s.tag === 'BGM')!, 2)] ?? 'RELEASED';
    const out: string[] = [];
    for (const s of segs.filter((x) => x.tag === 'RFF' && el(x, 0) === 'BM')) {
      const blNo = el(s, 0, 1);
      const decl = segs.find((x) => x.tag === 'RFF' && el(x, 0) === 'ABT');
      const bl = await one(c, `SELECT id FROM bills_of_lading WHERE bl_no=$1 ORDER BY created_at DESC LIMIT 1`, [blNo]);
      if (!bl) throw new Error(`B/L ${blNo} not found`);
      await setCustomsStatus(c, a, bl.id, status, decl ? el(decl, 0, 1) : undefined, 'via CUSRES');
      out.push(blNo);
    }
    return { summary: `${status}: ${out.join(', ')}` };
  },
};

async function containerMoves(c: Db, a: Actor, segs: Segment[], ev: string, src: string) {
  const done: string[] = [], warnings: string[] = [];
  let at = new Date();
  for (const s of segs) {
    if (s.tag === 'DTM' && ['7', '178', '203'].includes(el(s, 0))) at = ediDate(el(s, 0, 1)) ?? at;
    if (s.tag === 'EQD' && el(s, 0) === 'CN') {
      try { await applyContainerEvent(c, a, el(s, 1), ev, at, src); done.push(el(s, 1)); }
      catch (e: any) { warnings.push(e.message); }
    }
  }
  if (!done.length) throw new Error(warnings.join('; ') || 'No EQD+CN segments');
  return { summary: `${ev} for ${done.length} container(s)`, warnings };
}

/** Process one raw interchange. Stores the message, runs the handler in a savepoint, returns APERAK. */
export async function processInbound(c: Db, a: Actor, raw: string) {
  let parsed;
  try { parsed = parse(raw); } catch (e: any) {
    const m = await insert(c, 'edi_messages', { tenant_id: a.tenantId, direction: 'IN', msg_type: 'UNKNOWN', org_id: a.orgId, raw, status: 'ERROR', errors: JSON.stringify([e.message]) });
    return { id: m.id, status: 'ERROR', errors: [e.message] };
  }
  const results: any[] = [];
  for (const msg of parsed.messages) {
    const rec = await insert(c, 'edi_messages', { tenant_id: a.tenantId, direction: 'IN', msg_type: msg.type, sender: parsed.sender, receiver: parsed.receiver, interchange_ref: parsed.ref, org_id: a.orgId, raw, parsed: JSON.stringify(msg.segments.slice(0, 500)), status: 'RECEIVED' });
    const h = handlers[msg.type];
    let status = 'PROCESSED', errors: string[] = [], summary = '', ent: any = {};
    if (!h) { status = 'ERROR'; errors = [`Message type ${msg.type} not supported`]; }
    else {
      await c.query('SAVEPOINT edi');
      try {
        const r = await h(c, a, msg.segments);
        summary = r.summary; ent = r; errors = r.warnings ?? [];
        await c.query('RELEASE SAVEPOINT edi');
      } catch (e: any) {
        await c.query('ROLLBACK TO SAVEPOINT edi');
        status = 'ERROR';
        errors = e?.issues ? e.issues.map((i: any) => `${i.path.join('.')}: ${i.message}`) : [e.message ?? String(e)];
      }
    }
    await update(c, 'edi_messages', rec.id, { status, errors: JSON.stringify(errors), summary, related_entity_type: ent.entityType ?? null, related_entity_id: ent.entityId ?? null });
    // APERAK acknowledgement back to the sender
    const aperak = build({
      sender: a.tenantCode, receiver: parsed.sender ?? 'UNKNOWN', ref: `AK${Date.now().toString().slice(-8)}`, type: 'APERAK', version: 'D:96A',
      segments: [
        ['BGM', ['23'], [msg.ref], status === 'PROCESSED' ? ['29'] : ['27']],
        ['DTM', ['137', toEdiDate(new Date()), '203']],
        ['RFF', ['ACW', parsed.ref ?? msg.ref]],
        ...errors.slice(0, 20).map((e) => ['ERC', [status === 'PROCESSED' ? 'WARN' : 'ERR'], ['FTX'], [e.slice(0, 70)]] as any),
      ],
    });
    await insert(c, 'edi_messages', { tenant_id: a.tenantId, direction: 'OUT', msg_type: 'APERAK', sender: a.tenantCode, receiver: parsed.sender, interchange_ref: parsed.ref, org_id: a.orgId, raw: aperak, status: 'SENT', summary: `${status} ${msg.type} ${msg.ref}` });
    await audit(c, a, `EDI_${msg.type}_${status}`, 'edi_message', rec.id, { summary, errors });
    results.push({ id: rec.id, type: msg.type, status, summary, errors, aperak });
  }
  return { interchange: parsed.ref, messages: results };
}

export default async function edi(app: FastifyInstance) {
  app.addContentTypeParser(['text/plain', 'application/edifact'], { parseAs: 'string' }, (_req, body, done) => done(null, body));

  app.post('/edi/inbound', async (req) => {
    const raw = typeof req.body === 'string' ? req.body : z.object({ raw: z.string().min(10) }).parse(req.body).raw;
    return tx(req, (c) => processInbound(c, req.actor, raw));
  });

  app.get('/edi/messages', async (req) => {
    const q = z.object({ direction: z.string().optional(), type: z.string().optional(), status: z.string().optional() }).parse(req.query);
    return tx(req, (c) => many(c, `SELECT e.id, e.direction, e.msg_type, e.sender, e.receiver, e.interchange_ref, e.status, e.errors, e.summary, e.related_entity_type, e.related_entity_id, e.created_at, o.name AS org_name
      FROM edi_messages e LEFT JOIN organisations o ON o.id=e.org_id
      WHERE ($1 OR e.org_id=$2) AND ($3::text IS NULL OR e.direction=$3) AND ($4::text IS NULL OR e.msg_type=$4) AND ($5::text IS NULL OR e.status=$5)
      ORDER BY e.created_at DESC LIMIT 300`, [isAuthority(req.actor), req.actor.orgId, q.direction ?? null, q.type ?? null, q.status ?? null]));
  });

  app.get('/edi/messages/:id', async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const m = await one(c, 'SELECT * FROM edi_messages WHERE id=$1 AND ($2 OR org_id=$3)', [id, isAuthority(req.actor), req.actor.orgId]);
      if (!m) throw notFound();
      return m;
    });
  });

  /** Outbound CUSCAR for a manifest (PCS → customs system). */
  app.get('/edi/outbound/cuscar/:manifestId', async (req, reply) => {
    requireRole(req.actor, 'CUSTOMS', 'SHIPPING_AGENT', 'SHIPPING_LINE', 'PORT_ADMIN');
    const { manifestId } = req.params as { manifestId: string };
    const raw = await tx(req, async (c) => {
      const m = await one(c, `SELECT m.*, vc.call_no, vc.voyage_in, vc.eta, v.imo, v.name AS vessel_name, v.call_sign FROM manifests m JOIN vessel_calls vc ON vc.id=m.call_id JOIN vessels v ON v.id=vc.vessel_id WHERE m.id=$1`, [manifestId]);
      if (!m) throw notFound();
      const bls = await many(c, 'SELECT * FROM bills_of_lading WHERE manifest_id=$1 ORDER BY bl_no', [manifestId]);
      const segs: any[] = [
        ['BGM', [m.direction === 'IMPORT' ? '785' : '786'], [m.call_no], ['9']],
        ['DTM', ['132', toEdiDate(new Date(m.eta)), '203']],
        ['RFF', ['ATZ', m.call_no]],
        ['TDT', ['20'], [m.voyage_in ?? ''], ['1'], [''], [''], [''], [''], [m.imo, '146', '11', m.vessel_name]],
      ];
      let i = 0;
      for (const b of bls) {
        segs.push(['CNI', [String(++i)], [b.bl_no]], ['RFF', ['BM', b.bl_no]]);
        if (b.shipper) segs.push(['NAD', ['CZ'], [''], [''], [b.shipper]]);
        if (b.consignee) segs.push(['NAD', ['CN'], [''], [''], [b.consignee]]);
        if (b.pol) segs.push(['LOC', ['9'], [b.pol]]);
        if (b.pod) segs.push(['LOC', ['11'], [b.pod]]);
        segs.push(['GID', ['1'], [String(b.packages ?? 0)]]);
        if (b.description) segs.push(['FTX', ['AAA'], [''], [''], [b.description.slice(0, 70)]]);
        if (b.gross_kg) segs.push(['MEA', ['AAE'], ['G'], ['KGM', String(b.gross_kg)]]);
        for (const k of await many(c, 'SELECT * FROM containers WHERE bl_id=$1', [b.id])) {
          segs.push(['EQD', ['CN'], [k.container_no], [k.iso_type ?? ''], [''], [''], [k.full_empty === 'E' ? '4' : '5']]);
          if (k.seal_no) segs.push(['SEL', [k.seal_no]]);
        }
      }
      const out = build({ sender: req.actor.tenantCode, receiver: 'CUSTOMS', ref: `CC${Date.now().toString().slice(-8)}`, type: 'CUSCAR', segments: segs });
      await insert(c, 'edi_messages', { tenant_id: req.actor.tenantId, direction: 'OUT', msg_type: 'CUSCAR', sender: req.actor.tenantCode, receiver: 'CUSTOMS', org_id: req.actor.orgId, raw: out, status: 'SENT', summary: `Manifest ${m.call_no} ${m.direction}`, related_entity_type: 'manifest', related_entity_id: m.id });
      return out;
    });
    reply.header('content-type', 'application/edifact; charset=utf-8');
    return raw;
  });
}
