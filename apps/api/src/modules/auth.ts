// FR-PLT: authentication, self-service organisation registration (FR-ORG), notifications
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { ORG_TYPES, ORG_DEFAULT_ROLE } from '@pcs/shared';
import { pool, one, many, withTenant, insert } from '../core/db.js';
import { HttpError, notify, tx, getTenant, badRequest } from '../core/context.js';

export default async function auth(app: FastifyInstance) {
  app.post('/auth/login', { config: { public: true, rateLimit: { max: Number(process.env.LOGIN_RATE_LIMIT ?? 20), timeWindow: '1 minute' } } }, async (req) => {
    const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    const u = await withTenant('*', (c) => one(
      c,
      `SELECT u.*, o.status AS org_status, o.name AS org_name, o.type AS org_type FROM users u
       LEFT JOIN organisations o ON o.id = u.org_id WHERE lower(u.email)=lower($1)`,
      [email],
    ));
    if (!u || !u.active || !(await bcrypt.compare(password, u.password_hash))) throw new HttpError(401, 'Invalid email or password');
    if (u.org_id && u.org_status !== 'ACTIVE') throw new HttpError(403, `Organisation is ${u.org_status.toLowerCase()}`);
    await pool.query('UPDATE users SET last_login_at=now() WHERE id=$1', [u.id]);
    const token = app.jwt.sign({ sub: u.id, tid: u.tenant_id, org: u.org_id, roles: u.roles, name: u.name });
    return { token, user: publicUser(u) };
  });

  app.get('/auth/me', async (req) => {
    const a = req.actor;
    const u = a.userId
      ? await withTenant('*', (c) => one(c, `SELECT u.*, o.name AS org_name, o.type AS org_type FROM users u LEFT JOIN organisations o ON o.id=u.org_id WHERE u.id=$1`, [a.userId]))
      : null;
    const t = await getTenant(a.tenantId);
    const tenants = a.roles.includes('SYS_ADMIN') ? await many(pool, 'SELECT id, code, name FROM tenants ORDER BY name') : [];
    return { user: u ? publicUser(u) : { name: a.name, roles: a.roles }, tenant: t, tenants };
  });

  app.patch('/auth/me', async (req) => {
    const b = z.object({ lang: z.enum(['en', 'ro', 'uk']).optional(), password: z.string().min(8).optional(), currentPassword: z.string().optional() }).parse(req.body);
    const a = req.actor;
    if (!a.userId) throw badRequest('API keys have no profile');
    if (b.password) {
      const u = await one(pool, 'SELECT password_hash FROM users WHERE id=$1', [a.userId]);
      if (!b.currentPassword || !(await bcrypt.compare(b.currentPassword, u.password_hash))) throw badRequest('Current password is incorrect');
      await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1', [a.userId, await bcrypt.hash(b.password, 10)]);
    }
    if (b.lang) await pool.query('UPDATE users SET lang=$2 WHERE id=$1', [a.userId, b.lang]);
    return { ok: true };
  });

  // Public: list ports so a new organisation can choose where to register
  app.get('/public/ports', { config: { public: true } }, async () =>
    many(pool, `SELECT id, code, name, country, settings->'languages' AS languages FROM tenants ORDER BY name`),
  );

  // Public: organisation self-registration (FR-ORG). Creates a PENDING org + its admin user; port admin approves.
  app.post('/public/register', { config: { public: true, rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = z
      .object({
        tenantId: z.string().uuid(),
        organisation: z.object({
          name: z.string().min(2),
          type: z.enum(ORG_TYPES),
          registrationNo: z.string().min(2),
          taxId: z.string().optional(),
          email: z.string().email(),
          phone: z.string().optional(),
          address: z.string().optional(),
        }),
        user: z.object({ name: z.string().min(2), email: z.string().email(), password: z.string().min(8) }),
      })
      .parse(req.body);
    if (b.organisation.type === 'PORT_AUTHORITY' || b.organisation.type === 'GOVERNMENT_AGENCY')
      throw badRequest('Authority organisations are provisioned by the port administrator');
    return withTenant(b.tenantId, async (c) => {
      const exists = await one(c, 'SELECT 1 FROM users WHERE lower(email)=lower($1)', [b.user.email]);
      if (exists) throw badRequest('A user with this email already exists');
      const o = await insert(c, 'organisations', {
        tenant_id: b.tenantId, name: b.organisation.name, type: b.organisation.type,
        registration_no: b.organisation.registrationNo, tax_id: b.organisation.taxId, email: b.organisation.email,
        phone: b.organisation.phone, address: b.organisation.address, status: 'PENDING',
      });
      await insert(c, 'users', {
        tenant_id: b.tenantId, org_id: o.id, email: b.user.email, name: b.user.name,
        password_hash: await bcrypt.hash(b.user.password, 10), roles: [ORG_DEFAULT_ROLE[b.organisation.type as keyof typeof ORG_DEFAULT_ROLE]],
      });
      await notify(c, b.tenantId, { role: 'PORT_ADMIN' }, 'New organisation registration', `${o.name} (${o.type}) is awaiting approval`, '/admin/organisations', 'warning');
      return { id: o.id, status: o.status, message: 'Registration received. You can sign in once the port administrator approves your organisation.' };
    });
  });

  // Notifications for the current user (targeted at user, organisation or role)
  app.get('/notifications', async (req) => {
    const a = req.actor;
    return tx(req, (c) =>
      many(
        c,
        `SELECT id, title, body, link, severity, created_at, ($1::uuid = ANY(read_by)) AS read FROM notifications
         WHERE user_id = $1 OR org_id = $2 OR role = ANY($3) ORDER BY created_at DESC LIMIT 50`,
        [a.userId ?? '00000000-0000-0000-0000-000000000000', a.orgId, a.roles],
      ),
    );
  });

  app.post('/notifications/read', async (req) => {
    const { ids } = z.object({ ids: z.array(z.string().uuid()).optional() }).parse(req.body ?? {});
    const a = req.actor;
    if (!a.userId) return { ok: true };
    await tx(req, (c) =>
      c.query(
        `UPDATE notifications SET read_by = array_append(read_by, $1) WHERE NOT ($1 = ANY(read_by))
         AND (user_id=$1 OR org_id=$2 OR role = ANY($3)) AND ($4::uuid[] IS NULL OR id = ANY($4))`,
        [a.userId, a.orgId, a.roles, ids ?? null],
      ),
    );
    return { ok: true };
  });

}

function publicUser(u: any) {
  return { id: u.id, email: u.email, name: u.name, roles: u.roles, lang: u.lang, tenantId: u.tenant_id, orgId: u.org_id, orgName: u.org_name, orgType: u.org_type };
}
