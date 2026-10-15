import type { Money } from "../../../../shared/domain/money";
import { FailureCode } from "../transaction/failure-code";
import type { ReferenceRetryPolicy } from "../transaction/reference-retry-policy";
import { type WagerTransaction, WagerTransactionKind } from "../transaction/wager-transaction";
import type { Wallet } from "../wallet/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../wallet/wallet-ledger-entry";
import { type ReferenceContext, ReferencePolicy } from "./reference-policy";

export interface SettlementRequest extends ReferenceContext {
  transaction: WagerTransaction;
  wallet: Wallet;
  ledgerEntryId: string;
  now: Date;
}

export type SettlementOutcome =
  | { kind: "processed"; entry: WalletLedgerEntry | undefined; balanceBefore: Money }
  | { kind: "rejected"; code: FailureCode }
  | { kind: "pending_reference" };

export class WagerSettlementService {
  constructor(private readonly retryPolicy: ReferenceRetryPolicy) {}

  settle(request: SettlementRequest): SettlementOutcome {
    const { transaction, wallet, now } = request;

    const walletViolation = this.walletViolation(transaction, wallet);
    if (walletViolation) return this.reject(request, walletViolation);

    const verdict = ReferencePolicy.evaluate(transaction, request);
    switch (verdict.kind) {
      case "await":
        transaction.markPendingReference(now, this.retryPolicy);
        return { kind: "pending_reference" };
      case "ineligible":
        return this.reject(request, verdict.code);
      case "eligible":
        return this.apply(request, verdict.reference);
      case "not_applicable":
        return this.apply(request, undefined);
    }
  }

  private walletViolation(transaction: WagerTransaction, wallet: Wallet): FailureCode | undefined {
    if (wallet.id !== transaction.walletId || !wallet.belongsTo(transaction.playerId)) {
      return FailureCode.WalletPlayerMismatch;
    }
    if (!transaction.money.hasCurrency(wallet.currency)) return FailureCode.CurrencyMismatch;
    return undefined;
  }

  private apply(request: SettlementRequest, reference: WagerTransaction | undefined): SettlementOutcome {
    const { transaction, wallet, now } = request;
    const balanceBefore = wallet.balance;

    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, wallet.balance, now);
      return { kind: "processed", entry: undefined, balanceBefore };
    }

    const direction = transaction.ledgerDirectionFor(reference);
    if (direction === LedgerDirection.Debit && !wallet.canDebit(transaction.money)) {
      return this.reject(request, this.overdraftCode(transaction));
    }

    const entry = wallet.move(direction, transaction.money, {
      transactionId: transaction.id,
      ledgerEntryId: request.ledgerEntryId,
      at: now,
    });
    transaction.markProcessed(reference?.id, wallet.balance, now);
    return { kind: "processed", entry, balanceBefore };
  }

  private overdraftCode(transaction: WagerTransaction): FailureCode {
    return transaction.kind === WagerTransactionKind.Rollback
      ? FailureCode.ReversalWouldOverdraw
      : FailureCode.InsufficientFunds;
  }

  private reject({ transaction, wallet }: SettlementRequest, code: FailureCode): SettlementOutcome {
    const observedBalance = transaction.money.hasCurrency(wallet.currency) ? wallet.balance : undefined;
    transaction.reject(code, observedBalance);
    return { kind: "rejected", code };
  }
}
