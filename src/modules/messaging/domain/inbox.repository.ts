import type { InboxMessage } from "./inbox-message";

export interface InboxRepository {
  find(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  add(message: InboxMessage): Promise<void>;
}
