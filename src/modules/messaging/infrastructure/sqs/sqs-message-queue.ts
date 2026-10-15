import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import type {
  MessageQueue,
  ReceiveOptions,
  ReceivedMessage,
} from "../../application/ports/message-queue.port";

const DEAD_LETTER_GROUP = "dead-letter";
const FAILURE_REASON_MAX_LENGTH = 256;

export class SqsMessageQueue implements MessageQueue {
  constructor(
    private readonly client: SQSClient,
    private readonly queueUrl: string,
    private readonly deadLetterQueueUrl: string,
  ) {}

  async receive(options: ReceiveOptions, signal: AbortSignal): Promise<ReceivedMessage[]> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: options.maxMessages,
        WaitTimeSeconds: options.waitTimeSeconds,
        VisibilityTimeout: options.visibilityTimeoutSeconds,
        MessageSystemAttributeNames: ["ApproximateReceiveCount", "MessageGroupId"],
      }),
      { abortSignal: signal },
    );
    return (response.Messages ?? []).map(toReceivedMessage);
  }

  async acknowledge(message: ReceivedMessage): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.queueUrl, ReceiptHandle: message.receiptHandle }));
  }

  async retryLater(message: ReceivedMessage, delaySeconds: number): Promise<void> {
    await this.changeVisibility(message, delaySeconds);
  }

  async release(message: ReceivedMessage): Promise<void> {
    await this.changeVisibility(message, 0);
  }

  async deadLetter(message: ReceivedMessage, reason: string): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.deadLetterQueueUrl,
        MessageBody: message.body,
        MessageGroupId: message.groupId ?? DEAD_LETTER_GROUP,
        MessageDeduplicationId: message.id,
        MessageAttributes: {
          failureReason: { DataType: "String", StringValue: reason.slice(0, FAILURE_REASON_MAX_LENGTH) },
          originalMessageId: { DataType: "String", StringValue: message.id },
        },
      }),
    );
    await this.acknowledge(message);
  }

  private async changeVisibility(message: ReceivedMessage, seconds: number): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: message.receiptHandle,
        VisibilityTimeout: seconds,
      }),
    );
  }
}

function toReceivedMessage(message: Message): ReceivedMessage {
  return {
    id: message.MessageId ?? "",
    receiptHandle: message.ReceiptHandle ?? "",
    body: message.Body ?? "",
    receiveCount: Number.parseInt(message.Attributes?.ApproximateReceiveCount ?? "1", 10),
    groupId: message.Attributes?.MessageGroupId,
  };
}
