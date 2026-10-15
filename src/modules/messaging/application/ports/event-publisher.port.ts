import type { OutboxMessage } from "../../domain/outbox-message";

export type PublishResult =
  | { kind: "published" }
  | { kind: "partial"; publishedCount: number; error: unknown };

export interface EventPublisher {
  publishInOrder(messages: readonly OutboxMessage[]): Promise<PublishResult>;
}

export function sequentialPublisher(publish: (message: OutboxMessage) => Promise<void>): EventPublisher {
  return {
    async publishInOrder(messages) {
      for (const [index, message] of messages.entries()) {
        try {
          await publish(message);
        } catch (error) {
          return { kind: "partial", publishedCount: index, error };
        }
      }
      return { kind: "published" };
    },
  };
}
