import { EntitySchema } from "@mikro-orm/core";
import { Columns } from "../../../../shared/infrastructure/database/columns";

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  walletVersion!: number;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: "wallet_ledger_entries",
  properties: {
    id: { type: "uuid", primary: true },
    walletId: { type: "uuid" },
    transactionId: { type: "uuid" },
    walletVersion: { type: "integer" },
    direction: { type: "string" },
    amount: Columns.money,
    currency: Columns.currency,
    balanceBefore: Columns.money,
    balanceAfter: Columns.money,
    createdAt: Columns.timestamptz,
  },
});
