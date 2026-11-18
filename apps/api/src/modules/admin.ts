// FR-PLT / FR-ORG / FR-REF: administration — organisations, users, API keys, webhooks, port settings, reference data, audit
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { ORG_TYPES, ROLES, isValidImo, type Role } from '@pcs/shared';
import { one, many, insert, update } from '../core/db.js';
import { tx, requireRole, audit, notify, hashKey, notFound, badRequest, forbidden, invalidateTenant, hasRole } from '../core/context.js';

const ADMIN: Role[] = ['PORT_ADMIN'];

export default async function admin(app: FastifyInstance) {
  // ---------- Organisations ----------
  app.get('/organisations', async (req) => {
    const q = z.object({ type: z.string().optional(), status: z.string().optional(), search: z.string().optional() }).parse(req.query);
    return tx(req, (c) =>
      many(
        c,
        `SELECT o.*, (SELECT count(*) FROM users u WHERE u.org_id=o.id) AS user_count FROM organisations o
         WHERE ($1::text IS NULL OR type=$1) AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR name ILIKE '%'||$3||'%')
         ORDER BY status='PENDING' DESC, name`,
        [q.type ?? null, q.status ?? null, q.search ?? null],
      ),
    );
  });

  /** Lightweight directory used by pickers (active orgs only). */
  app.get('/directory/organisations', async (req) => {
    const { type } = z.object({ type: z.string().optional() }).parse(req.query);
    return tx(req, (c) => many(c, `SELECT id, name, type FROM organisations WHERE status='ACTIVE' AND ($1::text IS NULL OR type = ANY(string_to_array($1, ','))) ORDER BY name`, [type ?? null]));
  });

  app.post('/organisations', async (req) => {
    requireRole(req.actor, ...ADMIN);
    const b = orgSchema.parse(req.body);
    return tx(req, async (c) => {
      const o = await insert(c, 'organisations', { tenant_id: req.actor.tenantId, ...toOrgRow(b), status: 'ACTIVE' });
      await audit(c, req.actor, 'ORG_CREATED', 'organisation', o.id, b);
      return o;
    });
  });

  app.patch('/organisations/:id', async (req) => {
    requireRole(req.actor, ...ADMIN);
    const { id } = req.params as { id: string };
    const b = orgSchema.partial().parse(req.body);
    return tx(req, async (c) => {
      const o = await update(c, 'organisations', id, toOrgRow(b));
      if (!o) throw notFound();
      await audit(c, req.actor, 'ORG_UPDATED', 'organisation', id, b);
      return o;
    });
  });

  app.post('/organisations/:id/status', async (req) => {
    requireRole(req.actor, ...ADMIN);
    const { id } = req.params as { id: string };
    const b = z.object({ status: z.enum(['ACTIVE', 'SUSPENDED', 'REJECTED']), reason: z.string().optional() }).parse(req.body);
    return tx(req, async (c) => {
      const o = await one(c, 'SELECT * FROM organisations WHERE id=$1', [id]);
      if (!o) throw notFound();
      const r = await update(c, 'organisations', id, { status: b.status, status_reason: b.reason ?? null });
      await audit(c, req.actor, `ORG_${b.status}`, 'organisation', id, b);
      await notify(c, req.actor.tenantId, { orgId: id }, `Organisation ${b.status.toLowerCase()}`, b.reason, '/', b.status === 'ACTIVE' ? 'success' : 'warning');
      return r;
    });
  });

  // ---------- Users ----------
  app.get('/users', async (req) => {
    const a = req.actor;
    const isAdmin = hasRole(a, 'PORT_ADMIN');
    return tx(req, (c) =>
      many(
        c,
        `SELECT u.id, u.email, u.name, u.roles, u.lang, u.active, u.last_login_at, u.org_id, o.name AS org_name
         FROM users u LEFT JOIN organisations o ON o.id=u.org_id
         WHERE u.tenant_id=$1 AND ($2 OR u.org_id=$3) ORDER BY o.name, u.name`,
        [a.tenantId, isAdmin, a.orgId],
      ),
    );
  });

  app.post('/users', async (req) => {
    const a = req.actor;
    const b = z.object({
      email: z.string().email(), name: z.string().min(2), password: z.string().min(8),
      roles: z.array(z.enum(ROLES)).min(1), orgId: z.string().uuid().optional(), lang: z.enum(['en', 'ro', 'uk']).default('en'),
    }).parse(req.body);
    const isAdmin = hasRole(a, 'PORT_ADMIN');
    const orgId = isAdmin ? (b.orgId ?? a.orgId) : a.orgId;
    if (b.roles.includes('SYS_ADMIN')) throw forbidden('Cannot grant SYS_ADMIN');
    // Non-admin org users may only create colleagues with their own roles
    if (!isAdmin && !b.roles.every((r) => a.roles.includes(r))) throw forbidden('You can only grant roles you hold');
    return tx(req, async (c) => {
      const u = await insert(c, 'users', {
        tenant_id: a.tenantId, org_id: orgId, email: b.email, name: b.name, roles: b.roles, lang: b.lang,
        password_hash: await bcrypt.hash(b.password, 10),
      });
      await audit(c, a, 'USER_CREATED', 'user', u.id, { email: b.email, roles: b.roles });
      return { id: u.id, email: u.email, name: u.name, roles: u.roles };
    });
  });

  app.patch('/users/:id', async (req) => {
    requireRole(req.actor, ...ADMIN);
    const { id } = req.params as { id: string };
    const b = z.object({ roles: z.array(z.enum(ROLES)).optional(), active: z.boolean().optional(), name: z.string().optional() }).parse(req.body);
    if (b.roles?.includes('SYS_ADMIN')) throw forbidden('Cannot grant SYS_ADMIN');
    return tx(req, async (c) => {
      const u = await one(c, 'SELECT id FROM users WHERE id=$1 AND tenant_id=$2', [id, req.actor.tenantId]);
      if (!u) throw notFound();
      await update(c, 'users', id, b);
      await audit(c, req.actor, 'USER_UPDATED', 'user', id, b);
      return { ok: true };
    });
  });

  // ---------- API keys (B2B integration) ----------
  app.get('/api-keys', async (req) =>
    tx(req, (c) => many(c, `SELECT k.id, k.name, k.prefix, k.roles, k.active, k.last_used_at, k.created_at, o.name AS org_name FROM api_keys k JOIN organisations o ON o.id=k.org_id WHERE ($1 OR k.org_id=$2) ORDER BY k.created_at DESC`, [hasRole(req.actor, 'PORT_ADMIN'), req.actor.orgId])),
  );

  app.post('/api-keys', async (req) => {
    const a = req.actor;
    if (!a.orgId) throw badRequest('API keys belong to an organisation');
    const b = z.object({ name: z.string().min(2) }).parse(req.body);
    const key = `pcs_${crypto.randomBytes(24).toString('base64url')}`;
    return tx(req, async (c) => {
      const k = await insert(c, 'api_keys', { tenant_id: a.tenantId, org_id: a.orgId, name: b.name, prefix: key.slice(0, 10), key_hash: hashKey(key), roles: a.roles.filter((r) => r !== 'SYS_ADMIN') });
      await audit(c, a, 'API_KEY_CREATED', 'api_key', k.id, { name: b.name });
      return { id: k.id, name: k.name, key, note: 'Store this key now — it is shown only once.' };
    });
  });

  app.delete('/api-keys/:id', async (req) => {
    const { id } = req.params as { id: string };
    return tx(req, async (c) => {
      const r = await c.query('UPDATE api_keys SET active=false WHERE id=$1 AND ($2 OR org_id=$3)', [id, hasRole(req.actor, 'PORT_ADMIN'), req.actor.orgId]);
      if (!r.rowCount) throw notFound();
      await audit(c, req.actor, 'API_KEY_REVOKED', 'api_key', id);
      return { ok: true };
    });
  });

  // ---------- Webhooks (event subscriptions) ----------
  app.get('/webhooks', async (req) => tx(req, (c) => many(c, 'SELECT id, url, events, active, created_at FROM webhooks WHERE ($1 OR org_id=$2)', [hasRole(req.actor, 'PORT_ADMIN'), req.actor.orgId])));
  app.post('/webhooks', async (req) => {
    const a = req.actor;
    if (!a.orgId) throw badRequest('Webhooks belong to an organisation');
    const b = z.object({ url: z.string().url(), events: z.array(z.string()).min(1) }).parse(req.body);
    const secret = crypto.randomBytes(24).toString('hex');
    return tx(req, async (c) => {
      const w = await insert(c, 'webhooks', { tenant_id: a.tenantId, org_id: a.orgId, url: b.url, events: b.events, secret });
      return { id: w.id, url: w.url, events: w.events, secret, note: 'Payloads are signed with HMAC-SHA256 in the x-pcs-signature header.' };
    });
  });
  app.delete('/webhooks/:id', async (req) => {
    const { id } = req.params as { id: string };
    await tx(req, (c) => c.query('UPDATE webhooks SET active=false WHERE id=$1 AND ($2 OR org_id=$3)', [id, hasRole(req.actor, 'PORT_ADMIN'), req.actor.orgId]));
    return { ok: true };
  });

  // ---------- Port (tenant) settings ----------
  app.get('/port', async (req) => tx(req, (c) => one(c, 'SELECT * FROM tenants WHERE id=$1', [req.actor.tenantId])));
  app.patch('/port/settings', async (req) => {
    requireRole(req.actor, ...ADMIN);
    const b = z.record(z.string(), z.any()).parse(req.body);
    return tx(req, async (c) => {
      const t = await one(c, `UPDATE tenants SET settings = settings || $2::jsonb WHERE id=$1 RETURNING *`, [req.actor.tenantId, JSON.stringify(b)]);
      invalidateTenant(req.actor.tenantId);
      await audit(c, req.actor, 'PORT_SETTINGS_UPDATED', 'tenant', req.actor.tenantId, b);
      return t;
    });
  });

  // ---------- Reference data ----------
  app.get('/ref/terminals', async (req) => tx(req, (c) => many(c, `SELECT t.*, o.name AS operator_name FROM terminals t LEFT JOIN organisations o ON o.id=t.operator_org_id ORDER BY t.code`)));
  app.post('/ref/terminals', async (req) => {
    requireRole(req.actor, ...ADMIN);
    const b = z.object({ code: z.string(), name: z.string(), type: z.string(), operatorOrgId: z.string().uuid().optional(), lat: z.number().optional(), lon: z.number().optional() }).parse(req.body);
    return tx(req, (c) => insert(c, 'terminals', { tenant_id: req.actor.tenantId, code: b.code, name: b.name, type: b.type, operator_org_id: b.operatorOrgId, lat: b.lat, lon: b.lon }));
  });
  app.get('/ref/berths', async (req) => tx(req, (c) => many(c, `SELECT b.*, t.name AS terminal_name, t.code AS terminal_code FROM berths b LEFT JOIN terminals t ON t.id=b.terminal_id ORDER BY b.code`)));
  app.post('/ref/berths', async (req) => {
    requireRole(req.actor, ...ADMIN, 'HARBOUR_MASTER');
    const b = z.object({ code: z.string(), name: z.string(), terminalId: z.string().uuid().optional(), lengthM: z.number().positive(), depthM: z.number().positive(), lat: z.number().optional(), lon: z.number().optional(), bargeBerth: z.boolean().default(false) }).parse(req.body);
    return tx(req, (c) => insert(c, 'berths', { tenant_id: req.actor.tenantId, code: b.code, name: b.name, terminal_id: b.terminalId, length_m: b.lengthM, depth_m: b.depthM, lat: b.lat, lon: b.lon, barge_berth: b.bargeBerth }));
  });
  app.get('/ref/vessels', async (req) => {
    const { search } = z.object({ search: z.string().optional() }).parse(req.query);
    return tx(req, (c) => many(c, `SELECT * FROM vessels WHERE ($1::text IS NULL OR name ILIKE '%'||$1||'%' OR imo LIKE $1||'%') ORDER BY name LIMIT 100`, [search ?? null]));
  });
  app.post('/ref/vessels', async (req) => {
    const b = z.object({
      imo: z.string().refine(isValidImo, 'Invalid IMO number (check digit)'), name: z.string().min(2), callSign: z.string().optional(), mmsi: z.string().optional(),
      flag: z.string().length(2).optional(), type: z.string(), gt: z.number().int().optional(), dwt: z.number().int().optional(),
      loa: z.number().optional(), beam: z.number().optional(), maxDraft: z.number().optional(),
    }).parse(req.body);
    return tx(req, (c) => insert(c, 'vessels', { imo: b.imo, name: b.name.toUpperCase(), call_sign: b.callSign, mmsi: b.mmsi, flag: b.flag, type: b.type, gt: b.gt, dwt: b.dwt, loa: b.loa, beam: b.beam, max_draft: b.maxDraft }));
  });
  app.get('/ref/locations', async (req) => {
    const { search } = z.object({ search: z.string().optional() }).parse(req.query);
    return tx(req, (c) => many(c, `SELECT * FROM locations WHERE ($1::text IS NULL OR unlocode ILIKE $1||'%' OR name ILIKE '%'||$1||'%') ORDER BY unlocode LIMIT 50`, [search ?? null]));
  });

  // ---------- Audit trail ----------
  app.get('/audit', async (req) => {
    requireRole(req.actor, ...ADMIN, 'EXECUTIVE');
    const q = z.object({ entityType: z.string().optional(), entityId: z.string().uuid().optional(), limit: z.coerce.number().max(500).default(200) }).parse(req.query);
    return tx(req, (c) =>
      many(c, `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id=a.user_id
               WHERE a.tenant_id=$1 AND ($2::text IS NULL OR entity_type=$2) AND ($3::uuid IS NULL OR entity_id=$3) ORDER BY a.at DESC LIMIT $4`,
        [req.actor.tenantId, q.entityType ?? null, q.entityId ?? null, q.limit]),
    );
  });
}

const orgSchema = z.object({
  name: z.string().min(2), type: z.enum(ORG_TYPES), registrationNo: z.string().optional(), taxId: z.string().optional(),
  email: z.string().email(), phone: z.string().optional(), address: z.string().optional(),
});
function toOrgRow(b: Partial<z.infer<typeof orgSchema>>) {
  return { name: b.name, type: b.type, registration_no: b.registrationNo, tax_id: b.taxId, email: b.email, phone: b.phone, address: b.address };
}
