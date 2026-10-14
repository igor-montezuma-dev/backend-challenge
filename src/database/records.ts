/**
 * Modelos de persistência (EntitySchema) — o espelho das tabelas da migration.
 *
 * Ficam separados do domínio de propósito: o domínio não conhece MikroORM, e
 * estas classes não têm regra de negócio. Os mappers (mappers.ts) convertem
 * nos dois sentidos. EntitySchema evita decorators e deixa o mapeamento
 * explícito, coluna a coluna.
 */
import { EntitySchema } from "@mikro-orm/core";
import { NumericStringType } from "./types/numeric-string.type";

const timestamptz = { type: "Date", columnType: "timestamptz" } as const;
const money = { type: NumericStringType, columnType: "numeric(19,2)" } as const;

// -----------------------------------------------------------------------------
export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid" },
    currency: { type: "string", columnType: "char(3)" },
    balance: money,
    version: { type: "integer" },
    createdAt: timestamptz,
    updatedAt: timestamptz,
  },
});

// -----------------------------------------------------------------------------
export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  balanceAfter?: string | null;
  referenceAttempts!: number;
  nextReferenceCheckAt?: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
  processedAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string" },
    externalTransactionId: { type: "string" },
    idempotencyKey: { type: "string" },
    payloadHash: { type: "string", columnType: "char(64)" },
    walletId: { type: "uuid" },
    playerId: { type: "uuid" },
    roundId: { type: "string" },
    gameId: { type: "string" },
    kind: { type: "string" },
    amount: money,
    currency: { type: "string", columnType: "char(3)" },
    referenceExternalTransactionId: { type: "string", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "string" },
    failureCode: { type: "string", nullable: true },
    balanceAfter: { ...money, nullable: true },
    referenceAttempts: { type: "integer" },
    nextReferenceCheckAt: { ...timestamptz, nullable: true },
    createdAt: timestamptz,
    // mantido pelo trigger wager_tx_guard
    updatedAt: timestamptz,
    processedAt: { ...timestamptz, nullable: true },
  },
});

// -----------------------------------------------------------------------------
export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  walletVersion!: number;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entries",
  // Imutabilidade garantida pelo trigger ledger_no_update_delete. Não usamos
  // `readonly: true` do MikroORM: ele impede também o INSERT. O mapper só cria
  // registros novos, e o domínio (WalletLedgerEntry) não tem métodos de mutação.
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    walletVersion: { type: "integer" },
    direction: { type: "string" },
    amount: money,
    currency: { type: "string", columnType: "char(3)" },
    balanceBefore: money,
    balanceAfter: money,
    createdAt: timestamptz,
  },
});

// -----------------------------------------------------------------------------
export class InboxRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxSchema = new EntitySchema<InboxRecord>({
  class: InboxRecord,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", primary: true },
    messageId: { type: "string", primary: true },
    payloadHash: { type: "string", columnType: "char(64)" },
    receivedAt: timestamptz,
    processedAt: { ...timestamptz, nullable: true },
  },
});

// -----------------------------------------------------------------------------
export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  partitionKey!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt!: Date;
  lockedBy?: string | null;
  lockedUntil?: Date | null;
  lastError?: string | null;
  publishedAt?: Date | null;
  createdAt!: Date;
  /** Atribuída pelo banco (identity); ordem de publicação por partição. */
  position?: string;
}

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "string" },
    partitionKey: { type: "string" },
    eventType: { type: "string" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: timestamptz,
    attempts: { type: "integer" },
    nextAttemptAt: timestamptz,
    lockedBy: { type: "string", nullable: true },
    lockedUntil: { ...timestamptz, nullable: true },
    lastError: { type: "string", nullable: true },
    publishedAt: { ...timestamptz, nullable: true },
    createdAt: timestamptz,
    // bigint como string: nunca vira number. Gerado pelo banco, nunca escrito.
    position: { type: "bigint", persist: false, nullable: true },
  },
});

export const ENTITY_SCHEMAS = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema, InboxSchema, OutboxSchema];
