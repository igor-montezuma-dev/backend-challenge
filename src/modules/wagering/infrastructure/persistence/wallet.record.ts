import { EntitySchema } from "@mikro-orm/core";
import { Columns } from "../../../../shared/infrastructure/database/columns";

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "uuid" },
    currency: Columns.currency,
    balance: Columns.money,
    version: { type: "integer" },
    createdAt: Columns.timestamptz,
    updatedAt: Columns.timestamptz,
  },
});
