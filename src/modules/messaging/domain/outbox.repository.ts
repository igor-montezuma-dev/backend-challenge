import type { IntegrationEvent } from "../../../shared/domain/integration-event";

export interface OutboxRepository {
  enqueue(events: readonly IntegrationEvent<unknown>[]): Promise<void>;
}
