/**
 * Monta os casos de uso de verdade (MikroORM + PostgreSQL real) sobre um banco
 * isolado e migrado. Nada é mockado: é o mesmo grafo que a aplicação usa.
 */
import { MikroORM } from "@mikro-orm/postgresql";
import type { SQL } from "bun";
import { buildMikroOrmConfig } from "../../src/database/mikro-orm.config";
import { DEFAULT_UNIT_OF_WORK_OPTIONS, MikroOrmUnitOfWork, type UnitOfWorkOptions } from "../../src/database/mikro-orm-unit-of-work";
import { SystemClock, type Clock } from "../../src/shared/application/clock";
import type { UnitOfWork } from "../../src/shared/application/unit-of-work.port";
import { UuidV7Generator } from "../../src/shared/domain/uuid";
import { ProcessWagerTransaction } from "../../src/modules/wagering/application/process-wager-transaction.use-case";
import { SettlePendingReference } from "../../src/modules/wagering/application/settle-pending-reference.use-case";
import {
  DEFAULT_REFERENCE_RETRY_POLICY,
  type ReferenceRetryPolicy,
} from "../../src/modules/wagering/domain/reference-retry-policy";
import { OpenWallet } from "../../src/modules/wallets/application/open-wallet.use-case";
import { createTestDatabase, migrateUp } from "./database";

export interface Harness {
  url: string;
  sql: SQL;
  orm: MikroORM;
  uow: UnitOfWork;
  openWallet: OpenWallet;
  processWager: ProcessWagerTransaction;
  settlePending: SettlePendingReference;
  close(): Promise<void>;
}

export interface HarnessOptions {
  poolMax?: number;
  retryPolicy?: ReferenceRetryPolicy;
  clock?: Clock;
  unitOfWork?: Partial<UnitOfWorkOptions>;
  /** Permite envolver o UnitOfWork (ex.: injetar falha para testar atomicidade). */
  wrapUnitOfWork?: (uow: UnitOfWork) => UnitOfWork;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const db = await createTestDatabase();
  await migrateUp(db.sql);
  return buildHarness(db.url, db.sql, options, db.drop);
}

/** Usado também por processos filhos (teste multi-instância) sobre um banco existente. */
export async function buildHarness(
  url: string,
  sql: SQL,
  options: HarnessOptions = {},
  drop: () => Promise<void> = async () => {},
): Promise<Harness> {
  const orm = await MikroORM.init({ ...buildMikroOrmConfig(url, options.poolMax ?? 30), debug: false });
  const ids = new UuidV7Generator();
  const clock = options.clock ?? new SystemClock();
  const policy = options.retryPolicy ?? DEFAULT_REFERENCE_RETRY_POLICY;
  const baseUow = new MikroOrmUnitOfWork(orm, { ...DEFAULT_UNIT_OF_WORK_OPTIONS, ...options.unitOfWork });
  const uow = options.wrapUnitOfWork ? options.wrapUnitOfWork(baseUow) : baseUow;

  return {
    url,
    sql,
    orm,
    uow,
    openWallet: new OpenWallet(uow, ids, clock),
    processWager: new ProcessWagerTransaction(uow, ids, clock, policy),
    settlePending: new SettlePendingReference(uow, ids, clock, policy),
    close: async () => {
      await orm.close(true);
      await drop();
    },
  };
}

// ---------------------------------------------------------------------------
// Payloads e consultas de verificação
// ---------------------------------------------------------------------------

let seq = 0;
export const uniq = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${++seq}`;

export interface WagerInput {
  walletId: string;
  playerId: string;
  kind: "BET" | "WIN" | "LOSS" | "REFUND" | "ROLLBACK";
  amount: string;
  currency?: string;
  externalTransactionId?: string;
  idempotencyKey?: string;
  providerId?: string;
  roundId?: string;
  referenceExternalTransactionId?: string;
}

export function wagerPayload(input: WagerInput): Record<string, unknown> {
  const providerId = input.providerId ?? "provider-a";
  const externalTransactionId = input.externalTransactionId ?? uniq("tx");
  return {
    idempotencyKey: input.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    providerId,
    externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId ?? "round-1",
    gameId: "fortune-chimp",
    kind: input.kind,
    money: { amount: input.amount, currency: input.currency ?? "BRL" },
    ...(input.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: input.referenceExternalTransactionId }
      : {}),
  };
}

export const http = (correlationId = uniq("corr")) => ({ correlationId });

export async function newWallet(h: Harness, balance: string, currency = "BRL") {
  const playerId = crypto.randomUUID();
  const wallet = await h.openWallet.execute({ playerId, initialBalance: { amount: balance, currency } }, "test");
  return { walletId: wallet.id, playerId };
}

export interface WalletSnapshot {
  balance: string;
  version: number;
  ledgerSum: string;
  ledgerEntries: number;
  debits: number;
  credits: number;
}

/** Estado persistido + saldo reconstruído pelo ledger. */
export async function snapshot(sql: SQL, walletId: string): Promise<WalletSnapshot> {
  const [row] = await sql`
    SELECT w.balance::text AS balance, w.version,
           COALESCE(SUM(CASE l.direction WHEN 'CREDIT' THEN l.amount ELSE -l.amount END), 0)::numeric(19,2)::text AS "ledgerSum",
           COUNT(l.id)::int AS "ledgerEntries",
           COUNT(l.id) FILTER (WHERE l.direction = 'DEBIT')::int AS debits,
           COUNT(l.id) FILTER (WHERE l.direction = 'CREDIT')::int AS credits
      FROM wallets w LEFT JOIN wallet_ledger_entries l ON l.wallet_id = w.id
     WHERE w.id = ${walletId}
     GROUP BY w.id`;
  return row as WalletSnapshot;
}

/** Invariante final de todos os testes: wallet.balance == saldo reconstruído pelo ledger. */
export async function expectConsistent(sql: SQL, walletId: string): Promise<WalletSnapshot> {
  const s = await snapshot(sql, walletId);
  if (s.balance !== s.ledgerSum) {
    throw new Error(`wallet ${walletId} inconsistent: balance ${s.balance} != ledger ${s.ledgerSum}`);
  }
  return s;
}

export async function outboxTypes(sql: SQL, aggregateOrPartition: string): Promise<string[]> {
  const rows = await sql`
    SELECT event_type FROM outbox_messages
     WHERE partition_key = ${aggregateOrPartition} OR aggregate_id = ${aggregateOrPartition}
     ORDER BY position`;
  return rows.map((r: { event_type: string }) => r.event_type);
}

export async function transactionRow(sql: SQL, id: string) {
  const [row] = await sql`
    SELECT status, failure_code, balance_after::text AS balance_after, reference_transaction_id
      FROM wager_transactions WHERE id = ${id}`;
  return row as { status: string; failure_code: string | null; balance_after: string | null; reference_transaction_id: string | null };
}
