/**
 * Conversão domínio <-> registro de persistência.
 *
 * Money é persistido em duas colunas (valor numeric(19,2) + moeda char(3)) e
 * reidratado com Money.from, que valida o formato — um valor corrompido no
 * banco falha alto na leitura em vez de virar saldo errado.
 */
import { Money } from "../shared/domain/money";
import { InboxMessage } from "../modules/messaging/domain/inbox-message";
import type { OutboxMessage } from "../modules/messaging/domain/outbox-message";
import type { FailureCode } from "../modules/wagering/domain/failure-code";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../modules/wagering/domain/wager-transaction";
import { Wallet } from "../modules/wallets/domain/wallet";
import { type LedgerDirection, WalletLedgerEntry } from "../modules/wallets/domain/wallet-ledger-entry";
import {
  InboxRecord,
  LedgerEntryRecord,
  OutboxRecord,
  WagerTransactionRecord,
  WalletRecord,
} from "./records";

const money = (amount: string, currency: string): Money => Money.from({ amount, currency });
const optional = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);

// --- Wallet ------------------------------------------------------------------

export function walletToDomain(r: WalletRecord): Wallet {
  return Wallet.rehydrate({
    id: r.id,
    playerId: r.playerId,
    currency: r.currency,
    balance: money(r.balance, r.currency),
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  });
}

export function walletToRecord(w: Wallet, target: WalletRecord = new WalletRecord()): WalletRecord {
  target.id = w.id;
  target.playerId = w.playerId;
  target.currency = w.currency;
  target.balance = w.balance.amount;
  target.version = w.version;
  target.createdAt = w.createdAt;
  target.updatedAt = w.updatedAt;
  return target;
}

// --- WagerTransaction --------------------------------------------------------

export function transactionToDomain(r: WagerTransactionRecord): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: r.id,
    providerId: r.providerId,
    externalTransactionId: r.externalTransactionId,
    idempotencyKey: r.idempotencyKey,
    payloadHash: r.payloadHash,
    walletId: r.walletId,
    playerId: r.playerId,
    roundId: r.roundId,
    gameId: r.gameId,
    kind: r.kind as WagerTransactionKind,
    money: money(r.amount, r.currency),
    referenceExternalTransactionId: optional(r.referenceExternalTransactionId),
    createdAt: r.createdAt,
    status: r.status as WagerTransactionStatus,
    referenceTransactionId: optional(r.referenceTransactionId),
    failureCode: optional(r.failureCode) as FailureCode | undefined,
    // balance_after pode existir com moeda diferente da operação? Não: é sempre
    // o saldo da wallet, cuja moeda é a da operação quando ele é gravado.
    balanceAfter: r.balanceAfter == null ? undefined : money(r.balanceAfter, r.currency),
    processedAt: optional(r.processedAt),
    referenceAttempts: r.referenceAttempts,
    nextReferenceCheckAt: optional(r.nextReferenceCheckAt),
  });
}

/** Campos imutáveis só são escritos na criação; o trigger recusa mudanças. */
export function transactionToRecord(
  t: WagerTransaction,
  target: WagerTransactionRecord = new WagerTransactionRecord(),
): WagerTransactionRecord {
  target.id = t.id;
  target.providerId = t.providerId;
  target.externalTransactionId = t.externalTransactionId;
  target.idempotencyKey = t.idempotencyKey;
  target.payloadHash = t.payloadHash;
  target.walletId = t.walletId;
  target.playerId = t.playerId;
  target.roundId = t.roundId;
  target.gameId = t.gameId;
  target.kind = t.kind;
  target.amount = t.money.amount;
  target.currency = t.money.currency;
  target.referenceExternalTransactionId = t.referenceExternalTransactionId ?? null;
  target.createdAt = t.createdAt;
  return applyTransactionState(t, target);
}

/** Apenas o estado mutável (transições). */
export function applyTransactionState(t: WagerTransaction, target: WagerTransactionRecord): WagerTransactionRecord {
  target.referenceTransactionId = t.referenceTransactionId ?? null;
  target.status = t.status;
  target.failureCode = t.failureCode ?? null;
  target.balanceAfter = t.balanceAfter?.amount ?? null;
  target.referenceAttempts = t.referenceAttempts;
  target.nextReferenceCheckAt = t.nextReferenceCheckAt ?? null;
  target.processedAt = t.processedAt ?? null;
  target.updatedAt ??= t.createdAt;
  return target;
}

// --- Ledger ------------------------------------------------------------------

export function ledgerEntryToDomain(r: LedgerEntryRecord): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: r.id,
    walletId: r.walletId,
    transactionId: r.transactionId,
    walletVersion: r.walletVersion,
    direction: r.direction as LedgerDirection,
    money: money(r.amount, r.currency),
    balanceBefore: money(r.balanceBefore, r.currency),
    balanceAfter: money(r.balanceAfter, r.currency),
    createdAt: r.createdAt,
  });
}

export function ledgerEntryToRecord(e: WalletLedgerEntry): LedgerEntryRecord {
  const r = new LedgerEntryRecord();
  r.id = e.id;
  r.walletId = e.walletId;
  r.transactionId = e.transactionId;
  r.walletVersion = e.walletVersion;
  r.direction = e.direction;
  r.amount = e.money.amount;
  r.currency = e.money.currency;
  r.balanceBefore = e.balanceBefore.amount;
  r.balanceAfter = e.balanceAfter.amount;
  r.createdAt = e.createdAt;
  return r;
}

// --- Inbox / Outbox ----------------------------------------------------------

export function inboxToDomain(r: InboxRecord): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: r.messageId,
    consumerName: r.consumerName,
    payloadHash: r.payloadHash,
    receivedAt: r.receivedAt,
    processedAt: optional(r.processedAt),
  });
}

export function inboxToRecord(m: InboxMessage): InboxRecord {
  const r = new InboxRecord();
  r.consumerName = m.consumerName;
  r.messageId = m.messageId;
  r.payloadHash = m.payloadHash;
  r.receivedAt = m.receivedAt;
  r.processedAt = m.processedAt ?? null;
  return r;
}

export function outboxToRecord(m: OutboxMessage): OutboxRecord {
  const r = new OutboxRecord();
  r.id = m.id;
  r.aggregateId = m.aggregateId;
  r.partitionKey = m.partitionKey;
  r.eventType = m.eventType;
  r.payload = { ...m.payload };
  r.occurredAt = m.occurredAt;
  r.attempts = m.attempts;
  r.nextAttemptAt = m.nextAttemptAt ?? m.occurredAt;
  r.createdAt = m.occurredAt;
  return r;
}
