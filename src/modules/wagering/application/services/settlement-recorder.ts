import type { EventContext, IntegrationEvent } from "../../../../shared/domain/integration-event";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../../domain/events/wagering-events";
import type { SettlementOutcome } from "../../domain/settlement/wager-settlement.service";
import type { WagerTransaction } from "../../domain/transaction/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import type { WageringRepositories } from "../ports/wagering-repositories";

export interface SettlementRecord {
  transaction: WagerTransaction;
  wallet: Wallet;
  outcome: SettlementOutcome;
  isNewTransaction: boolean;
  events: EventContext;
}

export class SettlementRecorder {
  async record(repositories: WageringRepositories, record: SettlementRecord): Promise<void> {
    const { transaction, wallet, outcome } = record;

    if (record.isNewTransaction) await repositories.transactions.add(transaction);
    else await repositories.transactions.save(transaction);

    if (outcome.kind === "processed") {
      await repositories.wallets.save(wallet);
      await repositories.transactions.expediteAwaitingReference(transaction.providerId, transaction.externalTransactionId);
    }

    await repositories.outbox.enqueue(this.eventsFor(record));
  }

  private eventsFor({ transaction, wallet, outcome, isNewTransaction, events }: SettlementRecord): IntegrationEvent<unknown>[] {
    switch (outcome.kind) {
      case "processed":
        return outcome.entry
          ? [WagerTransactionProcessed.from(transaction, events), WalletBalanceChanged.from(wallet, outcome.entry, events)]
          : [WagerTransactionProcessed.from(transaction, events)];
      case "rejected":
        return [WagerTransactionRejected.from(transaction, events)];
      case "pending_reference":
        return isNewTransaction ? [WagerTransactionPendingReference.from(transaction, events)] : [];
    }
  }
}
