import { MikroORM } from "@mikro-orm/postgresql";
import type { SQL } from "bun";
import type { Clock } from "../../src/shared/application/clock";
import { buildMikroOrmConfig } from "../../src/shared/infrastructure/database/mikro-orm.config";
import { SystemClock } from "../../src/shared/infrastructure/system-clock";
import { UuidV7Generator } from "../../src/shared/infrastructure/uuid-v7.generator";
import { MESSAGING_ENTITIES } from "../../src/modules/messaging/infrastructure/persistence/messaging.entities";
import type { WageringUnitOfWork } from "../../src/modules/wagering/application/ports/wagering-repositories";
import type { OpenWallet } from "../../src/modules/wagering/application/use-cases/open-wallet.use-case";
import type { ProcessWagerTransaction } from "../../src/modules/wagering/application/use-cases/process-wager-transaction.use-case";
import type { SettlePendingReference } from "../../src/modules/wagering/application/use-cases/settle-pending-reference.use-case";
import {
  DEFAULT_REFERENCE_RETRY_POLICY,
  type ReferenceRetryPolicy,
} from "../../src/modules/wagering/domain/transaction/reference-retry-policy";
import { WAGERING_ENTITIES } from "../../src/modules/wagering/infrastructure/persistence/wagering.entities";
import { type WageringSettings, composeWagering } from "../../src/modules/wagering/infrastructure/wagering.composition";
import { createTestDatabase, migrateUp } from "./database";

export interface Harness {
  url: string;
  sql: SQL;
  orm: MikroORM;
  openWallet: OpenWallet;
  processWager: ProcessWagerTransaction;
  settlePending: SettlePendingReference;
  close(): Promise<void>;
}

export interface HarnessOptions {
  poolMax?: number;
  retryPolicy?: ReferenceRetryPolicy;
  clock?: Clock;
  settings?: Partial<Omit<WageringSettings, "referenceRetryPolicy">>;
  decorateUnitOfWork?: (unitOfWork: WageringUnitOfWork) => WageringUnitOfWork;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const db = await createTestDatabase();
  await migrateUp(db.sql);
  return buildHarness(db.url, db.sql, options, db.drop);
}

export async function buildHarness(
  url: string,
  sql: SQL,
  options: HarnessOptions = {},
  drop: () => Promise<void> = async () => {},
): Promise<Harness> {
  const orm = await MikroORM.init({
    ...buildMikroOrmConfig({ url, poolMax: options.poolMax ?? 30, entities: [...WAGERING_ENTITIES, ...MESSAGING_ENTITIES] }),
    debug: false,
  });
  const application = composeWagering({
    orm,
    ids: new UuidV7Generator(),
    clock: options.clock ?? new SystemClock(),
    settings: {
      lockTimeoutMs: 5_000,
      maxTransactionAttempts: 4,
      ...options.settings,
      referenceRetryPolicy: options.retryPolicy ?? DEFAULT_REFERENCE_RETRY_POLICY,
    },
    reconciliationObserver: { onDivergence: () => {} },
    ...(options.decorateUnitOfWork ? { decorateUnitOfWork: options.decorateUnitOfWork } : {}),
  });

  return {
    url,
    sql,
    orm,
    openWallet: application.openWallet,
    processWager: application.processWager,
    settlePending: application.settlePendingReference,
    close: async () => {
      await orm.close(true);
      await drop();
    },
  };
}

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
  const wallet = await h.openWallet.execute({ playerId, initialBalance: { amount: balance, currency } }, { correlationId: "test" });
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
