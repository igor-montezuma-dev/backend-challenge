import { FAILURE_CODES } from "../../domain/transaction/failure-code";
import { type WagerTransaction, WagerTransactionStatus } from "../../domain/transaction/wager-transaction";
import type { WagerResult } from "../../application/use-cases/process-wager-transaction.use-case";

const STATUS_CODE_BY_TRANSACTION_STATUS: Readonly<Record<WagerTransactionStatus, number>> = {
  [WagerTransactionStatus.Processed]: 201,
  [WagerTransactionStatus.PendingReference]: 202,
  [WagerTransactionStatus.Pending]: 202,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.Failed]: 500,
};

const REPLAYED_PROCESSED_STATUS_CODE = 200;

export const TransactionPresenter = {
  httpStatus({ transaction, idempotentReplay }: WagerResult): number {
    if (idempotentReplay && transaction.status === WagerTransactionStatus.Processed) {
      return REPLAYED_PROCESSED_STATUS_CODE;
    }
    return STATUS_CODE_BY_TRANSACTION_STATUS[transaction.status];
  },

  submission({ transaction, idempotentReplay }: WagerResult) {
    return {
      transactionId: transaction.id,
      status: transaction.status,
      balance: transaction.balanceAfter?.toJSON() ?? null,
      idempotentReplay,
      ...(transaction.failureCode !== undefined
        ? {
            failureCode: transaction.failureCode,
            providerAction: FAILURE_CODES[transaction.failureCode].providerAction,
          }
        : {}),
    };
  },

  detail: (transaction: WagerTransaction) => ({
    id: transaction.id,
    providerId: transaction.providerId,
    externalTransactionId: transaction.externalTransactionId,
    walletId: transaction.walletId,
    playerId: transaction.playerId,
    roundId: transaction.roundId,
    gameId: transaction.gameId,
    kind: transaction.kind,
    money: transaction.money.toJSON(),
    referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
    referenceTransactionId: transaction.referenceTransactionId ?? null,
    status: transaction.status,
    failureCode: transaction.failureCode ?? null,
    balanceAfter: transaction.balanceAfter?.toJSON() ?? null,
    createdAt: transaction.createdAt.toISOString(),
    processedAt: transaction.processedAt?.toISOString() ?? null,
  }),
};
