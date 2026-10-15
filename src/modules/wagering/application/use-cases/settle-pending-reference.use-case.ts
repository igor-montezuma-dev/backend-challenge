import type { Clock } from "../../../../shared/application/clock";
import { createEventContext } from "../../../../shared/application/event-context";
import type { IdGenerator } from "../../../../shared/application/id-generator";
import type { SettlementOutcome, WagerSettlementService } from "../../domain/settlement/wager-settlement.service";
import { FailureCode } from "../../domain/transaction/failure-code";
import type { ReferenceRetryPolicy } from "../../domain/transaction/reference-retry-policy";
import { type WagerTransaction, WagerTransactionStatus } from "../../domain/transaction/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WageringRepositories, WageringUnitOfWork } from "../ports/wagering-repositories";
import type { ReferenceResolver } from "../services/reference-resolver";
import type { SettlementRecorder } from "../services/settlement-recorder";

export type PendingSettlementResult =
  | { kind: "skipped"; reason: "not_found" | "not_pending" }
  | { kind: "settled"; transaction: WagerTransaction; outcome: SettlementOutcome["kind"] }
  | { kind: "expired"; transaction: WagerTransaction };

export class SettlePendingReference {
  constructor(
    private readonly unitOfWork: WageringUnitOfWork,
    private readonly settlement: WagerSettlementService,
    private readonly references: ReferenceResolver,
    private readonly recorder: SettlementRecorder,
    private readonly retryPolicy: ReferenceRetryPolicy,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(transactionId: string, correlationId: string = transactionId): Promise<PendingSettlementResult> {
    return this.unitOfWork.run(async (repositories) => {
      const candidate = await repositories.transactions.findById(transactionId);
      if (!candidate) return { kind: "skipped", reason: "not_found" };
      if (!isPendingReference(candidate)) return { kind: "skipped", reason: "not_pending" };

      const wallet = await repositories.wallets.lockById(candidate.walletId);
      const transaction = await repositories.transactions.findById(transactionId);
      if (!wallet || !transaction || !isPendingReference(transaction)) return { kind: "skipped", reason: "not_pending" };

      return this.reevaluate(repositories, transaction, wallet, correlationId);
    });
  }

  private async reevaluate(
    repositories: WageringRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    correlationId: string,
  ): Promise<PendingSettlementResult> {
    const now = this.clock.now();
    const references = await this.references.resolve(repositories.transactions, transaction);
    let outcome = this.settlement.settle({ transaction, wallet, ...references, ledgerEntryId: this.ids.next(), now });

    const expired = outcome.kind === "pending_reference" && transaction.isReferenceWaitExhausted(now, this.retryPolicy);
    if (expired) {
      transaction.reject(FailureCode.ReferenceNotFound, wallet.balance);
      outcome = { kind: "rejected", code: FailureCode.ReferenceNotFound };
    }

    await this.recorder.record(repositories, {
      transaction,
      wallet,
      outcome,
      isNewTransaction: false,
      events: createEventContext(this.ids, { correlationId, causationId: transaction.id }, now),
    });
    return expired ? { kind: "expired", transaction } : { kind: "settled", transaction, outcome: outcome.kind };
  }
}

const isPendingReference = (transaction: WagerTransaction): boolean =>
  transaction.status === WagerTransactionStatus.PendingReference;
