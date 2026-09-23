import pg from 'pg';
import { env } from '../config/env.js';

// NUMERIC -> JS number (amounts are well within double precision; all money rounded to öre)
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v))); // bigint ids

let pool: pg.Pool | undefined;
export function db(): pg.Pool {
  if (!pool) {
    const url = env().DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not configured');
    const serverless = !!process.env.VERCEL;
    pool = new pg.Pool({
      connectionString: url,
      max: serverless ? 5 : 20,
      idleTimeoutMillis: serverless ? 5_000 : 30_000,
      ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
    });
  }
  return pool;
}

export async function closeDb() { await pool?.end(); pool = undefined; }

export type Q = Pick<pg.PoolClient, 'query'>;

export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db().connect();
  try {
    await c.query('BEGIN');
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

export async function one<T = any>(sql: string, params: unknown[] = [], q: Q = db()): Promise<T | undefined> {
  const r = await q.query(sql, params as any[]);
  return r.rows[0] as T | undefined;
}
export async function many<T = any>(sql: string, params: unknown[] = [], q: Q = db()): Promise<T[]> {
  const r = await q.query(sql, params as any[]);
  return r.rows as T[];
}
