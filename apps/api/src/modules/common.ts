// FR-SWN agency queue + cross-cutting document features: attachments (FR-PLT document management), comments (GR-05 chat), history
import type { FastifyInstance } from 'fastify';
import crypto from 'node:crypto';
import { z } from 'zod';
import { AGENCIES, type Agency } from '@pcs/shared';
import { one, many, insert } from '../core/db.js';
import { tx, audit, notFound, forbidden, badRequest, hasRole } from '../core/context.js';
import { decide } from '../core/workflow.js';

export default async function common(app: FastifyInstance) {
  // ---------- Single Window agency queue ----------
  app.get('/approvals', async (req) => {
    const q = z.object({ status: z.string().optional(), entityType: z.string().optional(), entityId: z.string().uuid().optional() }).parse(req.query);
    const a = req.actor;
    const myAgencies = AGENCIES.filter((ag) => a.roles.includes(ag));
    const all = hasRole(a, 'PORT_ADMIN', 'EXECUTIVE') || !!q.entityId;
    return tx(req, (c) =>
      many(
        c,
        `SELECT ap.*, u.name AS decided_by_name,
           vc.call_no, v.name AS vessel_name, v.imo, vc.eta, vc.etd, o.name AS agent_name,
           it.transfer_no, it.direction AS transfer_direction, it.containers AS transfer_containers, it.mode AS transfer_mode, f.name AS facility_name, ro.name AS requester_name
         FROM approvals ap
         LEFT JOIN users u ON u.id=ap.decided_by
         LEFT JOIN vessel_calls vc ON ap.entity_type='vessel_call' AND vc.id=ap.entity_id
         LEFT JOIN vessels v ON v.id=vc.vessel_id
         LEFT JOIN organisations o ON o.id=vc.agent_org_id
         LEFT JOIN inland_transfers it ON ap.entity_type='inland_transfer' AND it.id=ap.entity_id
         LEFT JOIN facilities f ON f.id=it.facility_id
         LEFT JOIN organisations ro ON ro.id=it.requester_org_id
         WHERE ($1 OR ap.agency = ANY($2)) AND ($3::text IS NULL OR ap.status=$3)
           AND ($4::text IS NULL OR ap.entity_type=$4) AND ($5::uuid IS NULL OR ap.entity_id=$5)
         ORDER BY ap.status='PENDING' DESC, ap.created_at DESC LIMIT 300`,
        [all, myAgencies, q.status ?? null, q.entityType ?? null, q.entityId ?? null],
      ),
    );
  });

  app.post('/approvals/:id/decision', async (req) => {
    const { id } = req.params as { id: string };
    const b = z.object({ status: z.enum(['APPROVED', 'REJECTED', 'QUERY']), remarks: z.string().max(2000).optional() }).parse(req.body);
    if (b.status !== 'APPROVED' && !b.remarks) throw badRequest('Remarks are required when rejecting or raising a query');
    return tx(req, async (c) => {
      const ap = await one(c, 'SELECT * FROM approvals WHERE id=$1 FOR UPDATE', [id]);
      if (!ap) throw notFound();
      if (!hasRole(req.actor, ap.agency as Agency)) throw forbidden(`Only ${ap.agency} can decide this clearance`);
      if (ap.status === 'APPROVED') throw badRequest('Already approved');
      await decide(c, req.actor, ap, b.status, b.remarks);
      await audit(c, req.actor, `CLEARANCE_${b.status}`, ap.entity_type, ap.entity_id, { agency: ap.agency, stage: ap.stage, remarks: b.remarks });
      return one(c, 'SELECT * FROM approvals WHERE id=$1', [id]);
    });
  });

  // ---------- Attachments ----------
  app.get('/attachments', async (req) => {
    const q = z.object({ entityType: z.string(), entityId: z.string().uuid() }).parse(req.query);
    return tx(req, (c) => many(c, `SELECT a.id, a.doc_type, a.filename, a.mime, a.size, a.sha256, a.created_at, u.name AS uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id=a.uploaded_by WHERE entity_type=$1 AND entity_id=$2 ORDER BY created_at`, [q.entityType, q.entityId]));
  });

  app.post('/attachments', async (req) => {
    const file = await req.file();
    if (!file) throw badRequest('Multipart file required');
    const fields = Object.fromEntries(Object.entries(file.fields).map(([k, v]: [string, any]) => [k, v?.value]));
    const meta = z.object({ entityType: z.string(), entityId: z.string().uuid(), docType: z.string().optional() }).parse(fields);
    const buf = await file.toBuffer();
    return tx(req, async (c) => {
      const a = await insert(c, 'attachments', {
        tenant_id: req.actor.tenantId, entity_type: meta.entityType, entity_id: meta.entityId, doc_type: meta.docType ?? null,
        filename: file.filename, mime: file.mimetype, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'),
        content: buf, uploaded_by: req.actor.userId,
      });
      await audit(c, req.actor, 'ATTACHMENT_UPLOADED', meta.entityType, meta.entityId, { filename: file.filename, docType: meta.docType });
      return { id: a.id, filename: a.filename, size: a.size, sha256: a.sha256 };
    });
  });

  app.get('/attachments/:id/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const a = await tx(req, (c) => one(c, 'SELECT * FROM attachments WHERE id=$1', [id]));
    if (!a) throw notFound();
    reply.header('content-type', a.mime).header('content-disposition', `attachment; filename="${encodeURIComponent(a.filename)}"`);
    return reply.send(a.content);
  });

  // ---------- Comments (stakeholder chat on a document) ----------
  app.get('/comments', async (req) => {
    const q = z.object({ entityType: z.string(), entityId: z.string().uuid() }).parse(req.query);
    return tx(req, (c) => many(c, 'SELECT * FROM comments WHERE entity_type=$1 AND entity_id=$2 ORDER BY created_at', [q.entityType, q.entityId]));
  });
  app.post('/comments', async (req) => {
    const b = z.object({ entityType: z.string(), entityId: z.string().uuid(), body: z.string().min(1).max(4000) }).parse(req.body);
    if (!req.actor.userId) throw badRequest('Comments require a user session');
    return tx(req, (c) => insert(c, 'comments', { tenant_id: req.actor.tenantId, entity_type: b.entityType, entity_id: b.entityId, user_id: req.actor.userId, author: req.actor.name, body: b.body }));
  });

  // ---------- History (audit trail for one document) ----------
  app.get('/history', async (req) => {
    const q = z.object({ entityType: z.string(), entityId: z.string().uuid() }).parse(req.query);
    return tx(req, (c) => many(c, `SELECT a.action, a.data, a.at, coalesce(u.name, 'system') AS actor FROM audit_log a LEFT JOIN users u ON u.id=a.user_id WHERE a.entity_type=$1 AND a.entity_id=$2 ORDER BY a.at`, [q.entityType, q.entityId]));
  });
}
