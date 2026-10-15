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
      const divergent = await walletsDivergingFromLedger(sql);
      await sql.close();
      await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.close();
      if (divergent.length > 0) {
        throw new Error(`final invariant violated (wallet.balance != ledger): ${JSON.stringify(divergent)}`);
      }
    },
  };
}

export async function walletsDivergingFromLedger(sql: SQL): Promise<{ walletId: string; balance: string; ledger: string }[]> {
  const [schema] = (await sql`SELECT to_regclass('public.wallets') IS NOT NULL AS ready`) as { ready: boolean }[];
  if (!schema?.ready) return [];
  return (await sql`
    SELECT w.id AS "walletId", w.balance::text AS balance, COALESCE(l.total, 0)::text AS ledger
      FROM wallets w
      LEFT JOIN (
        SELECT wallet_id, SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END) AS total
          FROM wallet_ledger_entries GROUP BY wallet_id
      ) l ON l.wallet_id = w.id
     WHERE w.balance <> COALESCE(l.total, 0)`) as { walletId: string; balance: string; ledger: string }[];
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
