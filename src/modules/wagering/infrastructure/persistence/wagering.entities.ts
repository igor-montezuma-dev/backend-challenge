import { LedgerEntrySchema } from "./ledger-entry.record";
import { WagerTransactionSchema } from "./wager-transaction.record";
import { WalletSchema } from "./wallet.record";

export const WAGERING_ENTITIES = [WalletSchema, WagerTransactionSchema, LedgerEntrySchema];
