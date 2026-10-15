import { Money } from "../../../../shared/domain/money";
import { nullToUndefined } from "../../../../shared/infrastructure/database/columns";
import type { FailureCode } from "../../domain/transaction/failure-code";
import {
  WagerTransaction,
  type WagerTransactionKind,
  type WagerTransactionStatus,
} from "../../domain/transaction/wager-transaction";
import { WagerTransactionRecord } from "./wager-transaction.record";

export const WagerTransactionMapper = {
  toDomain(record: WagerTransactionRecord): WagerTransaction {
    const money = (amount: string) => Money.from({ amount, currency: record.currency });
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind as WagerTransactionKind,
      money: money(record.amount),
      referenceExternalTransactionId: nullToUndefined(record.referenceExternalTransactionId),
      createdAt: record.createdAt,
      status: record.status as WagerTransactionStatus,
      referenceTransactionId: nullToUndefined(record.referenceTransactionId),
      failureCode: nullToUndefined(record.failureCode) as FailureCode | undefined,
      balanceAfter: record.balanceAfter == null ? undefined : money(record.balanceAfter),
      processedAt: nullToUndefined(record.processedAt),
      referenceAttempts: record.referenceAttempts,
      nextReferenceCheckAt: nullToUndefined(record.nextReferenceCheckAt),
    });
  },

  toNewRecord(transaction: WagerTransaction): WagerTransactionRecord {
    const record = Object.assign(new WagerTransactionRecord(), {
      id: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      idempotencyKey: transaction.idempotencyKey,
      payloadHash: transaction.payloadHash,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      amount: transaction.money.amount,
      currency: transaction.money.currency,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      createdAt: transaction.createdAt,
      updatedAt: transaction.createdAt,
    });
    return WagerTransactionMapper.applyState(transaction, record);
  },

  applyState(transaction: WagerTransaction, target: WagerTransactionRecord): WagerTransactionRecord {
    return Object.assign(target, {
      referenceTransactionId: transaction.referenceTransactionId ?? null,
      status: transaction.status,
      failureCode: transaction.failureCode ?? null,
      balanceAfter: transaction.balanceAfter?.amount ?? null,
      referenceAttempts: transaction.referenceAttempts,
      nextReferenceCheckAt: transaction.nextReferenceCheckAt ?? null,
      processedAt: transaction.processedAt ?? null,
    });
  },
};
