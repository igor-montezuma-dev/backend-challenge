import type { Clock } from "../../../shared/application/clock";
import type { UnitOfWork } from "../../../shared/application/unit-of-work.port";
import type { IdGenerator } from "../../../shared/domain/uuid";
import { WagerTransactionRejected } from "../domain/events";
import { FailureCode } from "../domain/failure-code";
import type { ReferenceRetryPolicy } from "../domain/reference-retry-policy";
import { type SettlementOutcome, settleWager } from "../domain/wager-settlement";
import { type WagerTransaction, WagerTransactionStatus } from "../domain/wager-transaction";
import { eventsForOutcome } from "./wager-events";

export type PendingSettlementResult =
  | { kind: "skipped"; reason: "not_found" | "not_pending" }
  | { kind: "settled"; transaction: WagerTransaction; outcome: SettlementOutcome["kind"] }
  | { kind: "expired"; transaction: WagerTransaction };

/**
 * Reavalia uma transação PENDING_REFERENCE (chamado pelo worker agendado).
 *
 * Ordem de locks igual à do fluxo principal — primeiro a wallet — para que
 * nunca haja deadlock entre worker e requisições. A transação é relida SOB o
 * lock: se outra instância já a finalizou, não fazemos nada.
 *
 * Esgotado o limite (tentativas ou TTL) sem a referência estar disponível:
 * REJECTED com REFERENCE_NOT_FOUND e evento WagerTransactionRejected.
 */
export class SettlePendingReference {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly retryPolicy: ReferenceRetryPolicy,
  ) {}

  async execute(transactionId: string, correlationId: string = transactionId): Promise<PendingSettlementResult> {
    return this.uow.run(async (scope) => {
      const peek = await scope.findTransactionById(transactionId);
      if (!peek) return { kind: "skipped", reason: "not_found" };
      if (peek.status !== WagerTransactionStatus.PendingReference) return { kind: "skipped", reason: "not_pending" };

      const wallet = await scope.lockWallet(peek.walletId);
      const tx = await scope.findTransactionById(transactionId);
      if (!wallet || !tx || tx.status !== WagerTransactionStatus.PendingReference) {
        return { kind: "skipped", reason: "not_pending" };
      }

      const now = this.clock.now();
      const ctx = { nextEventId: () => this.ids.next(), correlationId, causationId: tx.id, occurredAt: now };

      const reference = await scope.findTransactionByExternalId(tx.providerId, tx.referenceExternalTransactionId!);
      const referenceAlreadyReversed =
        reference !== undefined && tx.isReversal() ? await scope.hasProcessedReversal(reference.id) : false;

      const outcome = settleWager({
        transaction: tx,
        wallet,
        reference,
        referenceAlreadyReversed,
        ledgerEntryId: this.ids.next(),
        now,
        retryPolicy: this.retryPolicy,
      });

      if (outcome.kind === "pending_reference" && tx.isReferenceWaitExhausted(now, this.retryPolicy)) {
        tx.reject(FailureCode.ReferenceNotFound, wallet.balance);
        await scope.updateTransaction(tx);
        await scope.enqueueEvents([WagerTransactionRejected.from(tx, ctx)]);
        return { kind: "expired", transaction: tx };
      }

      await scope.updateTransaction(tx);
      if (outcome.kind === "processed" && outcome.entry) {
        await scope.appendLedgerEntry(outcome.entry);
        await scope.saveWallet(wallet);
      }
      if (outcome.kind === "processed") {
        // Encadeamento: um ROLLBACK de REFUND pode estar esperando este REFUND.
        await scope.expediteTransactionsAwaiting(tx.providerId, tx.externalTransactionId, now);
      }
      await scope.enqueueEvents(eventsForOutcome(outcome, tx, wallet, ctx, { announcePending: false }));
      return { kind: "settled", transaction: tx, outcome: outcome.kind };
    });
  }
}
