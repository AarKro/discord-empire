import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type Sql = ReturnType<typeof postgres>;
export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Db;
  sql: Sql;
  close: () => Promise<void>;
}

/**
 * Open a Postgres connection + Drizzle handle.
 * `max: 1` is only appropriate for scripts/tests; services should raise it.
 */
export function openDb(url: string, opts: { max?: number } = {}): DbHandle {
  const sql = postgres(url, { max: opts.max ?? 10, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { db, sql, close: () => sql.end({ timeout: 5 }) };
}

/**
 * Wrap a value for a jsonb column, passed as JSON text and cast by Postgres.
 * postgres-js's `sql.json` breaks on the prepared-statement path (the driver
 * tries to serialize the Parameter wrapper itself during Bind), so we send a
 * plain string and let the server infer jsonb from the column/function type.
 * The `sql` argument is kept so call sites stay connection-scoped.
 */
export function jsonParam(_sql: Sql, value: unknown): string {
  return JSON.stringify(value);
}

export { schema };
