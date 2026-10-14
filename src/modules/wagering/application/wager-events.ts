import type { EventContext, IntegrationEvent } from "../../../shared/domain/integration-event";
import type { Wallet } from "../../wallets/domain/wallet";
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from "../domain/events";
import type { SettlementOutcome } from "../domain/wager-settlement";
import type { WagerTransaction } from "../domain/wager-transaction";

/** Eventos de integração correspondentes a um desfecho de liquidação. */
export function eventsForOutcome(
  outcome: SettlementOutcome,
  tx: WagerTransaction,
  wallet: Wallet,
  ctx: EventContext,
  options: { announcePending: boolean } = { announcePending: true },
): IntegrationEvent<unknown>[] {
  switch (outcome.kind) {
    case "processed": {
      const events: IntegrationEvent<unknown>[] = [WagerTransactionProcessed.from(tx, ctx)];
      if (outcome.entry) events.push(WalletBalanceChanged.from(wallet, outcome.entry, ctx));
      return events;
    }
    case "rejected":
      return [WagerTransactionRejected.from(tx, ctx)];
    case "pending_reference":
      // Anunciado uma vez, quando a transação passa a aguardar — não a cada retry.
      return options.announcePending ? [WagerTransactionPendingReference.from(tx, ctx)] : [];
  }
}
