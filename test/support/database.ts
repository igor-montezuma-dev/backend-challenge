import { SQL } from "bun";
import { MIGRATION_FILES, readMigrationSql } from "../../src/shared/infrastructure/database/migrations";

export const migrationSql = readMigrationSql;
export const MIGRATIONS = MIGRATION_FILES;

const adminUrl = (): string =>
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

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

export async function pgError(fn: () => Promise<unknown>): Promise<{ code: string; constraint?: string; message: string }> {
  try {
    await fn();
  } catch (e) {
    const err = e as { errno?: string; constraint?: string; message: string };
    return { code: err.errno ?? "unknown", constraint: err.constraint, message: err.message };
  }
  throw new Error("expected a PostgreSQL error, but the operation succeeded");
}
