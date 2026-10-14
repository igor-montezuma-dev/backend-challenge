import { SQL } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(import.meta.dir, "../../src/database/migrations/sql");

export const migrationSql = (name: string, direction: "up" | "down"): string =>
  readFileSync(join(MIGRATIONS_DIR, `${name}.${direction}.sql`), "utf8");

export const MIGRATIONS = ["0001_initial", "0002_outbox_position"] as const;

const adminUrl = (): string =>
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

/**
 * Cria um banco isolado por arquivo de teste — os testes de integração rodam
 * contra PostgreSQL real, nunca contra mock.
 */
export async function createTestDatabase(): Promise<{
  url: string;
  sql: SQL;
  drop: () => Promise<void>;
}> {
  const name = `wagering_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new SQL(adminUrl());
  await admin.unsafe(`CREATE DATABASE ${name}`);

  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const sql = new SQL(url.toString());

  return {
    url: url.toString(),
    sql,
    drop: async () => {
      await sql.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.close();
    },
  };
}

export async function migrateUp(sql: SQL): Promise<void> {
  for (const m of MIGRATIONS) await sql.unsafe(migrationSql(m, "up"));
}

export async function migrateDown(sql: SQL): Promise<void> {
  for (const m of [...MIGRATIONS].reverse()) await sql.unsafe(migrationSql(m, "down"));
}

/** Executa `fn` e devolve o erro do PostgreSQL (SQLSTATE + constraint). */
export async function pgError(fn: () => Promise<unknown>): Promise<{ code: string; constraint?: string; message: string }> {
  try {
    await fn();
  } catch (e) {
    const err = e as { errno?: string; constraint?: string; message: string };
    return { code: err.errno ?? "unknown", constraint: err.constraint, message: err.message };
  }
  throw new Error("expected a PostgreSQL error, but the operation succeeded");
}
