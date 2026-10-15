import { SendMessageBatchCommand, type SendMessageBatchRequestEntry, type SQSClient } from "@aws-sdk/client-sqs";
import type { EventPublisher, PublishResult } from "../../application/ports/event-publisher.port";
import type { OutboxMessage } from "../../domain/outbox-message";

const SQS_MAX_BATCH_ENTRIES = 10;

export class SqsEventPublisher implements EventPublisher {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
  ) {}

  async publishInOrder(messages: readonly OutboxMessage[]): Promise<PublishResult> {
    for (let start = 0; start < messages.length; start += SQS_MAX_BATCH_ENTRIES) {
      const chunk = messages.slice(start, start + SQS_MAX_BATCH_ENTRIES);
      let accepted: number;
      try {
        accepted = await this.sendChunk(chunk);
      } catch (error) {
        return { kind: "partial", publishedCount: start, error };
      }
      if (accepted < chunk.length) {
        return { kind: "partial", publishedCount: start + accepted, error: new Error(`SQS rejected entry ${chunk[accepted]!.id}`) };
      }
    }
    return { kind: "published" };
  }

  private async sendChunk(chunk: readonly OutboxMessage[]): Promise<number> {
    const { Failed = [] } = await this.client.send(
      new SendMessageBatchCommand({ QueueUrl: this.queueUrl, Entries: chunk.map(toEntry) }),
    );
    if (Failed.length === 0) return chunk.length;
    const failedIds = new Set(Failed.map((failure) => failure.Id));
    const firstFailure = chunk.findIndex((message) => failedIds.has(message.id));
    return firstFailure === -1 ? chunk.length : firstFailure;
  }
}

function toEntry(message: OutboxMessage): SendMessageBatchRequestEntry {
  return {
    Id: message.id,
    MessageBody: JSON.stringify(message.payload),
    MessageGroupId: message.partitionKey,
    MessageDeduplicationId: message.id,
    MessageAttributes: {
      eventType: { DataType: "String", StringValue: message.eventType },
      eventId: { DataType: "String", StringValue: message.id },
    },
  };
}
