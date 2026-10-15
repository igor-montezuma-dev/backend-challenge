import { GetQueueAttributesCommand, SQSClient } from "@aws-sdk/client-sqs";

export interface SqsConnection {
  region: string;
  endpoint: string | undefined;
}

export const SQS_CLIENT = Symbol("SQS_CLIENT");

export function createSqsClient({ region, endpoint }: SqsConnection): SQSClient {
  return new SQSClient({ region, ...(endpoint ? { endpoint } : {}), maxAttempts: 3 });
}

export async function pingQueue(client: SQSClient, queueUrl: string): Promise<void> {
  await client.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }));
}

export async function approximateQueueDepth(client: SQSClient, queueUrl: string): Promise<number> {
  const { Attributes } = await client.send(
    new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: ["ApproximateNumberOfMessages", "ApproximateNumberOfMessagesNotVisible"],
    }),
  );
  return Number(Attributes?.ApproximateNumberOfMessages ?? 0) + Number(Attributes?.ApproximateNumberOfMessagesNotVisible ?? 0);
}
