import type { Clock } from "../../../../shared/application/clock";
import { type Correlation, createEventContext } from "../../../../shared/application/event-context";
import type { IdGenerator } from "../../../../shared/application/id-generator";
import { WalletBalanceChanged } from "../../domain/events/wagering-events";
import { openingTransactionFor } from "../../domain/transaction/opening-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { parseOpenWalletCommand } from "../commands/open-wallet.command";
import type { WageringUnitOfWork } from "../ports/wagering-repositories";

export class OpenWallet {
  constructor(
    private readonly unitOfWork: WageringUnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: unknown, correlation: Correlation): Promise<Wallet> {
    const command = parseOpenWalletCommand(input);

    return this.unitOfWork.run(async (repositories) => {
      const now = this.clock.now();
      const openingTransactionId = this.ids.next();
      const wallet = Wallet.open({
        id: this.ids.next(),
        playerId: command.playerId,
        initialBalance: command.initialBalance,
        opening: { transactionId: openingTransactionId, ledgerEntryId: this.ids.next(), at: now },
      });
      const [openingEntry] = wallet.pendingEntries;

      await repositories.wallets.add(wallet);
      if (openingEntry) {
        await repositories.transactions.add(openingTransactionFor(wallet, openingTransactionId, now));
        await repositories.outbox.enqueue([
          WalletBalanceChanged.from(wallet, openingEntry, createEventContext(this.ids, correlation, now)),
        ]);
      }
      return wallet;
    });
  }
}
