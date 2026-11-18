import type { FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'node:crypto';
import { AUTHORITY_ROLES, type Role, type TenantSettings } from '@pcs/shared';
import { pool, one, withTenant, insert, type Db } from './db.js';

export interface Actor {
  userId: string | null;      // null when calling with an API key
  apiKeyId?: string;
  name: string;
  tenantId: string;           // effective tenant ('*' never reaches handlers — admins pick a tenant)
  tenantCode: string;
  orgId: string | null;
  roles: Role[];
}

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (m: string, d?: unknown) => new HttpError(400, m, d);
export const forbidden = (m = 'Not permitted') => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}

const tenantCache = new Map<string, { id: string; code: string; settings: TenantSettings; currency: string; name: string }>();
export async function getTenant(id: string) {
  if (!tenantCache.has(id)) {
    const t = await one(pool, 'SELECT id, code, name, currency, settings FROM tenants WHERE id=$1', [id]);
    if (!t) throw notFound('Unknown port');
    tenantCache.set(id, t);
  }
  return tenantCache.get(id)!;
}
export function invalidateTenant(id: string) {
  tenantCache.delete(id);
}

export const hashKey = (k: string) => crypto.createHash('sha256').update(k).digest('hex');

/** Authenticate a request via Bearer JWT or x-api-key (B2B system-to-system). */
export async function authenticate(req: FastifyRequest) {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey) {
    const k = await withTenant('*', (c) => one(
      c,
      `SELECT k.*, t.code AS tenant_code, o.name AS org_name, o.status AS org_status
       FROM api_keys k JOIN tenants t ON t.id=k.tenant_id JOIN organisations o ON o.id=k.org_id
       WHERE k.key_hash=$1 AND k.active`,
      [hashKey(apiKey)],
    ));
    if (!k || k.org_status !== 'ACTIVE') throw new HttpError(401, 'Invalid API key');
    pool.query('UPDATE api_keys SET last_used_at=now() WHERE id=$1', [k.id]).catch(() => {});
    req.actor = { userId: null, apiKeyId: k.id, name: `${k.org_name} (API: ${k.name})`, tenantId: k.tenant_id, tenantCode: k.tenant_code, orgId: k.org_id, roles: k.roles };
    return;
  }
  try {
    await req.jwtVerify();
  } catch {
    throw new HttpError(401, 'Authentication required');
  }
  const u = req.user as { sub: string; tid: string | null; org: string | null; roles: Role[]; name: string };
  let tenantId = u.tid;
  if (u.roles.includes('SYS_ADMIN')) {
    const h = req.headers['x-tenant-id'];
    if (typeof h === 'string' && h) tenantId = h;
  }
  if (!tenantId) {
    // platform admin without a selected port: default to the first one
    const t = await one(pool, 'SELECT id FROM tenants ORDER BY created_at LIMIT 1');
    tenantId = t?.id ?? null;
  }
  if (!tenantId) throw new HttpError(400, 'No port configured');
  const t = await getTenant(tenantId);
  req.actor = { userId: u.sub, name: u.name, tenantId, tenantCode: t.code, orgId: u.org, roles: u.roles };
}

export function hasRole(a: Actor, ...roles: Role[]) {
  return a.roles.includes('SYS_ADMIN') || roles.some((r) => a.roles.includes(r));
}
export function requireRole(a: Actor, ...roles: Role[]) {
  if (!hasRole(a, ...roles)) throw forbidden(`Requires one of: ${roles.join(', ')}`);
}
export function isAuthority(a: Actor) {
  return a.roles.some((r) => AUTHORITY_ROLES.includes(r));
}

/** Run a handler body in the actor's tenant transaction. */
export function tx<T>(req: FastifyRequest, fn: (c: Db) => Promise<T>) {
  return withTenant(req.actor.tenantId, fn);
}

export async function audit(c: Db, a: Actor, action: string, entityType?: string, entityId?: string, data?: unknown, ip?: string) {
  await c.query(
    'INSERT INTO audit_log (tenant_id, user_id, org_id, action, entity_type, entity_id, data, ip) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [a.tenantId, a.userId, a.orgId, action, entityType ?? null, entityId ?? null, data ? JSON.stringify(data) : null, ip ?? null],
  );
}

/** Write a domain event to the transactional outbox (published to webhooks / Kafka by the dispatcher). */
export async function emit(c: Db, tenantId: string, eventType: string, entityType: string, entityId: string, payload: unknown) {
  await insert(c, 'outbox', { tenant_id: tenantId, event_type: eventType, entity_type: entityType, entity_id: entityId, payload: JSON.stringify(payload) });
}

export async function notify(
  c: Db,
  tenantId: string,
  target: { orgId?: string | null; role?: Role; userId?: string },
  title: string,
  body?: string,
  link?: string,
  severity: 'info' | 'success' | 'warning' | 'critical' = 'info',
) {
  if (!target.orgId && !target.role && !target.userId) return;
  await insert(c, 'notifications', {
    tenant_id: tenantId, org_id: target.orgId ?? null, role: target.role ?? null, user_id: target.userId ?? null,
    title, body, link, severity,
  });
}

export function sendError(err: any, reply: FastifyReply) {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, details: err.details });
  if (err?.name === 'ZodError') return reply.status(400).send({ error: 'Validation failed', details: err.issues });
  if (err?.validation) return reply.status(400).send({ error: err.message });
  if (err?.code === '23505') return reply.status(409).send({ error: 'Duplicate record', details: err.detail });
  if (err?.code === '23503') return reply.status(400).send({ error: 'Referenced record does not exist', details: err.detail });
  if (err?.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
  reply.log.error(err);
  return reply.status(500).send({ error: 'Internal error' });
}
