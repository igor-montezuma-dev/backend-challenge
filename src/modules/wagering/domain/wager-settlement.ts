import type { Money } from "../../../shared/domain/money";
import type { Wallet } from "../../wallets/domain/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../../wallets/domain/wallet-ledger-entry";
import { FailureCode } from "./failure-code";
import type { ReferenceRetryPolicy } from "./reference-retry-policy";
import { type WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction";

export interface SettlementInput {
  /** Em PENDING ou PENDING_REFERENCE. */
  transaction: WagerTransaction;
  /** Já carregada com lock (SELECT ... FOR UPDATE) pelo caso de uso. */
  wallet: Wallet;
  /** Resolvida por (providerId, referenceExternalTransactionId); undefined se ausente. */
  reference: WagerTransaction | undefined;
  /** Já existe REFUND/ROLLBACK PROCESSED para esta referência? (consultado sob o mesmo lock) */
  referenceAlreadyReversed: boolean;
  ledgerEntryId: string;
  now: Date;
  retryPolicy: ReferenceRetryPolicy;
}

export type SettlementOutcome =
  | { kind: "processed"; entry: WalletLedgerEntry | undefined; balanceBefore: Money }
  | { kind: "rejected"; code: FailureCode }
  | { kind: "pending_reference" };

/**
 * Serviço de domínio que aplica as regras da seção 7 sobre uma transação.
 * Muta `transaction` e `wallet` de forma consistente e devolve o desfecho para
 * o caso de uso persistir (transação, lançamento, saldo e eventos juntos).
 *
 * Ordem das regras — a primeira violação decide o failureCode:
 *  1. wallet pertence ao player                      → WALLET_PLAYER_MISMATCH
 *  2. moeda da operação = moeda da wallet             → CURRENCY_MISMATCH
 *  3. referência (quando informada):
 *     a. ausente ou ainda não finalizada              → PENDING_REFERENCE
 *     b. REJECTED/FAILED                              → REFERENCE_NOT_PROCESSED
 *     c. outro provider/player/wallet/moeda/rodada    → REFERENCE_MISMATCH
 *     d. tipo não permitido para a operação           → INVALID_REFERENCE_KIND
 *     e. reversão com valor diferente da referência   → REVERSAL_AMOUNT_MISMATCH
 *     f. referência já revertida                      → ALREADY_REVERSED
 *  4. LOSS: processada sem lançamento
 *  5. débito sem saldo: BET → INSUFFICIENT_FUNDS; ROLLBACK → REVERSAL_WOULD_OVERDRAW
 *
 * Moeda é checada antes da referência porque é um defeito do próprio payload,
 * detectável sem esperar nada.
 */
export function settleWager(input: SettlementInput): SettlementOutcome {
  const { transaction: tx, wallet, reference, now } = input;

  const reject = (code: FailureCode): SettlementOutcome => {
    // Saldo observado no momento da rejeição: o replay devolve o mesmo valor.
    tx.reject(code, wallet.currency === tx.money.currency ? wallet.balance : undefined);
    return { kind: "rejected", code };
  };

  if (wallet.id !== tx.walletId || wallet.playerId !== tx.playerId) {
    return reject(FailureCode.WalletPlayerMismatch);
  }
  if (!tx.money.hasCurrency(wallet.currency)) {
    return reject(FailureCode.CurrencyMismatch);
  }

  if (tx.hasReference()) {
    if (!reference || isAwaitingSettlement(reference)) {
      tx.markPendingReference(now, input.retryPolicy);
      return { kind: "pending_reference" };
    }
    if (reference.status !== WagerTransactionStatus.Processed) {
      return reject(FailureCode.ReferenceNotProcessed);
    }
    if (!belongsToSameContext(tx, reference)) {
      return reject(FailureCode.ReferenceMismatch);
    }
    if (!tx.canReference(reference)) {
      return reject(FailureCode.InvalidReferenceKind);
    }
    if (tx.isReversal()) {
      if (!tx.money.equals(reference.money)) {
        return reject(FailureCode.ReversalAmountMismatch);
      }
      if (input.referenceAlreadyReversed) {
        return reject(FailureCode.AlreadyReversed);
      }
    }
  }

  const balanceBefore = wallet.balance;

  if (!tx.affectsBalance()) {
    tx.markProcessed(reference?.id, wallet.balance, now);
    return { kind: "processed", entry: undefined, balanceBefore };
  }

  const direction = tx.ledgerDirectionFor(reference);
  const ref = { transactionId: tx.id, ledgerEntryId: input.ledgerEntryId, at: now };

  if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
    return reject(
      tx.kind === WagerTransactionKind.Rollback
        ? FailureCode.ReversalWouldOverdraw
        : FailureCode.InsufficientFunds,
    );
  }

  const entry = direction === LedgerDirection.Debit ? wallet.debit(tx.money, ref) : wallet.credit(tx.money, ref);
  tx.markProcessed(reference?.id, wallet.balance, now);
  return { kind: "processed", entry, balanceBefore };
}

function isAwaitingSettlement(tx: WagerTransaction): boolean {
  return tx.status === WagerTransactionStatus.Pending || tx.status === WagerTransactionStatus.PendingReference;
}

function belongsToSameContext(tx: WagerTransaction, reference: WagerTransaction): boolean {
  return (
    reference.providerId === tx.providerId &&
    reference.playerId === tx.playerId &&
    reference.walletId === tx.walletId &&
    reference.money.currency === tx.money.currency &&
    reference.roundId === tx.roundId
  );
}
