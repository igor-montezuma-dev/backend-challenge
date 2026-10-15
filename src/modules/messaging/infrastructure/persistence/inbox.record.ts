import { EntitySchema } from "@mikro-orm/core";
import { Columns } from "../../../../shared/infrastructure/database/columns";

export class InboxRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxSchema = new EntitySchema<InboxRecord>({
  class: InboxRecord,
  tableName: "inbox_messages",
  properties: {
    consumerName: { type: "string", primary: true },
    messageId: { type: "string", primary: true },
    payloadHash: Columns.sha256,
    receivedAt: Columns.timestamptz,
    processedAt: Columns.nullableTimestamptz,
  },
});
