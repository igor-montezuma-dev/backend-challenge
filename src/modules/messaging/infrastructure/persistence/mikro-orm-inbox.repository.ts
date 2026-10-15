import type { EntityManager } from "@mikro-orm/postgresql";
import { nullToUndefined } from "../../../../shared/infrastructure/database/columns";
import { InboxMessage } from "../../domain/inbox-message";
import type { InboxRepository } from "../../domain/inbox.repository";
import { InboxRecord } from "./inbox.record";

export class MikroOrmInboxRepository implements InboxRepository {
  constructor(private readonly em: EntityManager) {}

  async find(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const record = await this.em.findOne(InboxRecord, { consumerName, messageId });
    return record ? toDomain(record) : undefined;
  }

  async add(message: InboxMessage): Promise<void> {
    this.em.persist(toRecord(message));
  }
}

function toDomain(record: InboxRecord): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: record.messageId,
    consumerName: record.consumerName,
    payloadHash: record.payloadHash,
    receivedAt: record.receivedAt,
    processedAt: nullToUndefined(record.processedAt),
  });
}

function toRecord(message: InboxMessage): InboxRecord {
  return Object.assign(new InboxRecord(), {
    consumerName: message.consumerName,
    messageId: message.messageId,
    payloadHash: message.payloadHash,
    receivedAt: message.receivedAt,
    processedAt: message.processedAt ?? null,
  });
}
