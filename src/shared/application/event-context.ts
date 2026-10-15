import type { EventContext } from "../domain/integration-event";
import type { IdGenerator } from "./id-generator";

export interface Correlation {
  correlationId: string;
  causationId?: string;
}

export function createEventContext(ids: IdGenerator, correlation: Correlation, occurredAt: Date): EventContext {
  return {
    nextEventId: () => ids.next(),
    correlationId: correlation.correlationId,
    ...(correlation.causationId !== undefined ? { causationId: correlation.causationId } : {}),
    occurredAt,
  };
}
