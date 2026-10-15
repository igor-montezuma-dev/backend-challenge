import type { UnitOfWork } from "../../../../shared/application/unit-of-work.port";
import type { InboxRepository } from "../../../messaging/domain/inbox.repository";
import type { OutboxRepository } from "../../../messaging/domain/outbox.repository";
import type { WagerTransactionRepository } from "../../domain/transaction/wager-transaction.repository";
import type { WalletRepository } from "../../domain/wallet/wallet.repository";

export interface WageringRepositories {
  wallets: WalletRepository;
  transactions: WagerTransactionRepository;
  inbox: InboxRepository;
  outbox: OutboxRepository;
}

export type WageringUnitOfWork = UnitOfWork<WageringRepositories>;
