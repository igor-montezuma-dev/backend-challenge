import {
  CreateQueueCommand,
  DeleteMessageCommand,
  DeleteQueueCommand,
  GetQueueAttributesCommand,
  type Message,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";

process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";

export const SQS_TEST_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? process.env.SQS_ENDPOINT ?? "http://localhost:4566";

export function testSqsClient(): SQSClient {
  return new SQSClient({ region: "us-east-1", endpoint: SQS_TEST_ENDPOINT, maxAttempts: 2 });
}

export interface TestQueues {
  client: SQSClient;
  wagerQueueUrl: string;
  deadLetterQueueUrl: string;
  eventsQueueUrl: string;
  destroy(): Promise<void>;
}

export async function createTestQueues(options: { maxReceiveCount?: number; visibilityTimeoutSeconds?: number } = {}): Promise<TestQueues> {
  const client = testSqsClient();
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const create = async (name: string, attributes: Record<string, string>) =>
    (await client.send(new CreateQueueCommand({ QueueName: `${name}-${suffix}.fifo`, Attributes: { FifoQueue: "true", ...attributes } })))
      .QueueUrl!;

  const deadLetterQueueUrl = await create("wager-dlq", {});
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: deadLetterQueueUrl, AttributeNames: ["QueueArn"] }),
  );
  const wagerQueueUrl = await create("wager", {
    VisibilityTimeout: String(options.visibilityTimeoutSeconds ?? 30),
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes!.QueueArn, maxReceiveCount: String(options.maxReceiveCount ?? 5) }),
  });
  const eventsQueueUrl = await create("events", {});

  return {
    client,
    wagerQueueUrl,
    deadLetterQueueUrl,
    eventsQueueUrl,
    destroy: async () => {
      for (const QueueUrl of [wagerQueueUrl, deadLetterQueueUrl, eventsQueueUrl]) {
        await client.send(new DeleteQueueCommand({ QueueUrl })).catch(() => {});
      }
      client.destroy();
    },
  };
}

export interface WagerMessage {
  messageId: string;
  data: Record<string, unknown>;
}

export async function sendWagerMessage(
  client: SQSClient,
  queueUrl: string,
  { messageId, data }: WagerMessage,
  options: { deduplicationId?: string; groupId?: string; rawBody?: string } = {},
): Promise<void> {
  const body = options.rawBody ?? JSON.stringify({ messageId, type: "WagerTransactionRequested", occurredAt: new Date().toISOString(), data });
  await client.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: body,
      MessageGroupId: options.groupId ?? String(data.walletId ?? "test"),
      MessageDeduplicationId: options.deduplicationId ?? `${messageId}-${crypto.randomUUID()}`,
    }),
  );
}

export async function drain(client: SQSClient, queueUrl: string, waitSeconds = 1): Promise<Message[]> {
  const all: Message[] = [];
  for (;;) {
    const { Messages = [] } = await client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: waitSeconds,
        VisibilityTimeout: 30,
        MessageAttributeNames: ["All"],
        MessageSystemAttributeNames: ["MessageGroupId"],
      }),
    );
    if (Messages.length === 0) return all;
    for (const message of Messages) {
      await client.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle }));
    }
    all.push(...Messages);
  }
}

export async function visibleCount(client: SQSClient, queueUrl: string): Promise<number> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["ApproximateNumberOfMessages"] }),
  );
  return Number(Attributes?.ApproximateNumberOfMessages ?? 0);
}

export async function eventually<T>(probe: () => Promise<T>, accept: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (accept(value) || Date.now() > deadline) return value;
    await Bun.sleep(100);
  }
}
