import { EntitySchema } from "@mikro-orm/core";
import { Columns } from "../../../../shared/infrastructure/database/columns";

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  amount!: string;
  currency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  balanceAfter?: string | null;
  referenceAttempts!: number;
  nextReferenceCheckAt?: Date | null;
  createdAt!: Date;
  updatedAt!: Date;
  processedAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string" },
    externalTransactionId: { type: "string" },
    idempotencyKey: { type: "string" },
    payloadHash: Columns.sha256,
    walletId: { type: "uuid" },
    playerId: { type: "uuid" },
    roundId: { type: "string" },
    gameId: { type: "string" },
    kind: { type: "string" },
    amount: Columns.money,
    currency: Columns.currency,
    referenceExternalTransactionId: { type: "string", nullable: true },
    referenceTransactionId: { type: "uuid", nullable: true },
    status: { type: "string" },
    failureCode: { type: "string", nullable: true },
    balanceAfter: Columns.nullableMoney,
    referenceAttempts: { type: "integer" },
    nextReferenceCheckAt: Columns.nullableTimestamptz,
    createdAt: Columns.timestamptz,
    updatedAt: Columns.timestamptz,
    processedAt: Columns.nullableTimestamptz,
  },
});
