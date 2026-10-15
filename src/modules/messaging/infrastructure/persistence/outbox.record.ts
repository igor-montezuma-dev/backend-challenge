import { EntitySchema } from "@mikro-orm/core";
import { Columns } from "../../../../shared/infrastructure/database/columns";

export class OutboxRecord {
  id!: string;
  aggregateId!: string;
  partitionKey!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date;
  lockedBy?: string | null;
  lockedUntil?: Date | null;
  lastError?: string | null;
  publishedAt?: Date | null;
  createdAt?: Date;
  position?: string;
}

export const OutboxSchema = new EntitySchema<OutboxRecord>({
  class: OutboxRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "string" },
    partitionKey: { type: "string" },
    eventType: { type: "string" },
    payload: { type: "json", columnType: "jsonb" },
    occurredAt: Columns.timestamptz,
    attempts: { type: "integer" },
    nextAttemptAt: { ...Columns.timestamptz, defaultRaw: "now()" },
    lockedBy: { type: "string", nullable: true },
    lockedUntil: Columns.nullableTimestamptz,
    lastError: { type: "string", nullable: true },
    publishedAt: Columns.nullableTimestamptz,
    createdAt: { ...Columns.timestamptz, defaultRaw: "now()" },
    position: { type: "bigint", persist: false, nullable: true },
  },
});
