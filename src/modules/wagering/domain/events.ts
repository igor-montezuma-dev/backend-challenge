import { type EventContext, IntegrationEvent } from "../../../shared/domain/integration-event";
import type { MoneyProps } from "../../../shared/domain/money";
import type { Wallet } from "../../wallets/domain/wallet";
import type { LedgerDirection, WalletLedgerEntry } from "../../wallets/domain/wallet-ledger-entry";
import type { FailureCode } from "./failure-code";
import type { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction";

/** Campos comuns aos eventos de transação. */
interface WagerTransactionEventData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
}

function transactionData(tx: WagerTransaction): WagerTransactionEventData {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    ...(tx.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: tx.referenceExternalTransactionId }
      : {}),
  };
}

/**
 * Eventos de transação particionam pela wallet: tudo o que acontece numa
 * wallet sai na ordem em que foi confirmado (MessageGroupId do SQS FIFO).
 */
abstract class WagerTransactionEvent<T extends { walletId: string }> extends IntegrationEvent<T> {
  override get partitionKey(): string {
    return this.data.walletId;
  }
}

// -----------------------------------------------------------------------------

export interface WagerTransactionProcessedData extends WagerTransactionEventData {
  status: WagerTransactionStatus.Processed;
  referenceTransactionId?: string;
  balanceAfter: MoneyProps;
  processedAt: string;
}

/** Qualquer transação aplicada, inclusive LOSS (que não move saldo). */
export class WagerTransactionProcessed extends WagerTransactionEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    if (!tx.balanceAfter || !tx.processedAt) {
      throw new Error(`transaction ${tx.id} is not processed`);
    }
    return new WagerTransactionProcessed(
      IntegrationEvent.propsFrom(tx.id, ctx, {
        ...transactionData(tx),
        status: tx.status as WagerTransactionStatus.Processed,
        ...(tx.referenceTransactionId !== undefined ? { referenceTransactionId: tx.referenceTransactionId } : {}),
        balanceAfter: tx.balanceAfter.toJSON(),
        processedAt: tx.processedAt.toISOString(),
      }),
    );
  }
}

// -----------------------------------------------------------------------------

export interface WagerTransactionRejectedData extends WagerTransactionEventData {
  status: WagerTransactionStatus.Rejected;
  failureCode: FailureCode;
}

export class WagerTransactionRejected extends WagerTransactionEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    if (!tx.failureCode) throw new Error(`transaction ${tx.id} is not rejected`);
    return new WagerTransactionRejected(
      IntegrationEvent.propsFrom(tx.id, ctx, {
        ...transactionData(tx),
        status: tx.status as WagerTransactionStatus.Rejected,
        failureCode: tx.failureCode,
      }),
    );
  }
}

// -----------------------------------------------------------------------------

export interface WagerTransactionPendingReferenceData extends WagerTransactionEventData {
  status: WagerTransactionStatus.PendingReference;
  referenceExternalTransactionId: string;
  nextCheckAt: string;
}

/** Emitido quando a transação passa a aguardar a referência (uma vez). */
export class WagerTransactionPendingReference extends WagerTransactionEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    if (tx.referenceExternalTransactionId === undefined || !tx.nextReferenceCheckAt) {
      throw new Error(`transaction ${tx.id} is not pending reference`);
    }
    return new WagerTransactionPendingReference(
      IntegrationEvent.propsFrom(tx.id, ctx, {
        ...transactionData(tx),
        status: tx.status as WagerTransactionStatus.PendingReference,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        nextCheckAt: tx.nextReferenceCheckAt.toISOString(),
      }),
    );
  }
}

// -----------------------------------------------------------------------------

export interface WalletBalanceChangedData {
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  walletVersion: number;
}

/** Somente quando o saldo muda. walletVersion permite ao consumidor ordenar/deduplicar. */
export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
  readonly eventType = "WalletBalanceChanged";
  readonly version = 1;

  static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
    if (entry.walletId !== wallet.id) {
      throw new Error(`ledger entry ${entry.id} does not belong to wallet ${wallet.id}`);
    }
    return new WalletBalanceChanged(
      IntegrationEvent.propsFrom(wallet.id, ctx, {
        walletId: wallet.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        walletVersion: entry.walletVersion,
      }),
    );
  }
}
