import type { EntityManager } from "@mikro-orm/postgresql";
import type { IntegrationEvent } from "../../../../shared/domain/integration-event";
import { OutboxMessage } from "../../domain/outbox-message";
import type { OutboxRepository } from "../../domain/outbox.repository";
import { OutboxRecord } from "./outbox.record";

export class MikroOrmOutboxRepository implements OutboxRepository {
  constructor(private readonly em: EntityManager) {}

  async enqueue(events: readonly IntegrationEvent<unknown>[]): Promise<void> {
    for (const event of events) this.em.persist(toRecord(OutboxMessage.enqueue(event)));
  }
}

function toRecord(message: OutboxMessage): OutboxRecord {
  return Object.assign(new OutboxRecord(), {
    id: message.id,
    aggregateId: message.aggregateId,
    partitionKey: message.partitionKey,
    eventType: message.eventType,
    payload: { ...message.payload },
    occurredAt: message.occurredAt,
    attempts: message.attempts,
  });
}
