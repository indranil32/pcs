import pg from 'pg';
import { config } from './config.js';

// numeric → number, int8 → number for API ergonomics
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 20 });

export type Db = pg.PoolClient;

/** Run fn in a transaction with the tenant context set for row-level security. '*' = all tenants (platform admin). */
export async function withTenant<T>(tenantId: string, fn: (c: Db) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

export async function one<T = any>(c: Db | pg.Pool, sql: string, params: unknown[] = []): Promise<T | null> {
  const r = await c.query(sql, params);
  return (r.rows[0] as T) ?? null;
}

export async function many<T = any>(c: Db | pg.Pool, sql: string, params: unknown[] = []): Promise<T[]> {
  const r = await c.query(sql, params);
  return r.rows as T[];
}

/** Insert a row from an object, returning the inserted row. */
export async function insert<T = any>(c: Db, table: string, row: Record<string, unknown>): Promise<T> {
  const keys = Object.keys(row).filter((k) => row[k] !== undefined);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`;
  const r = await c.query(sql, keys.map((k) => row[k]));
  return r.rows[0] as T;
}

/** Update a row by id from an object of changed columns. */
export async function update<T = any>(c: Db, table: string, id: string, patch: Record<string, unknown>): Promise<T> {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
  if (!keys.length) return (await one<T>(c, `SELECT * FROM ${table} WHERE id=$1`, [id]))!;
  const sql = `UPDATE ${table} SET ${keys.map((k, i) => `${k}=$${i + 2}`).join(',')} WHERE id=$1 RETURNING *`;
  const r = await c.query(sql, [id, ...keys.map((k) => patch[k])]);
  return r.rows[0] as T;
}

/** Next human-readable document number, e.g. ROCND-VC-2026-000042. */
export async function nextNo(c: Db, tenantId: string, tenantCode: string, prefix: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const name = `${prefix}-${year}`;
  const r = await one<{ value: number }>(
    c,
    `INSERT INTO counters (tenant_id, name, value) VALUES ($1,$2,1)
     ON CONFLICT (tenant_id, name) DO UPDATE SET value = counters.value + 1 RETURNING value`,
    [tenantId, name],
  );
  return `${tenantCode}-${prefix}-${year}-${String(r!.value).padStart(6, '0')}`;
}
