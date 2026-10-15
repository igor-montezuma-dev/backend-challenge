import type { SQSClient } from "@aws-sdk/client-sqs";
import type { DiagnosticContext } from "../../../shared/application/diagnostic-context";
import {
  QueueConsumer,
  type QueueConsumerObserver,
  type QueueConsumerOptions,
} from "../../messaging/application/queue-consumer";
import type { MessageQueue } from "../../messaging/application/ports/message-queue.port";
import { SqsMessageQueue } from "../../messaging/infrastructure/sqs/sqs-message-queue";
import type { ProcessWagerTransaction } from "../application/use-cases/process-wager-transaction.use-case";
import {
  type WagerMessageObserver,
  WagerTransactionMessageHandler,
} from "../presentation/messaging/wager-transaction-message.handler";

export interface WagerQueueConsumerDependencies {
  processWager: ProcessWagerTransaction;
  sqs: SQSClient;
  queueUrl: string;
  deadLetterQueueUrl: string;
  consumerName: string;
  options: QueueConsumerOptions;
  observer?: QueueConsumerObserver;
  businessObserver?: WagerMessageObserver;
  decorateQueue?: (queue: MessageQueue) => MessageQueue;
  diagnostics?: DiagnosticContext;
}

export function createWagerQueueConsumer(deps: WagerQueueConsumerDependencies): QueueConsumer {
  const queue = new SqsMessageQueue(deps.sqs, deps.queueUrl, deps.deadLetterQueueUrl);
  return new QueueConsumer(
    deps.decorateQueue ? deps.decorateQueue(queue) : queue,
    new WagerTransactionMessageHandler(deps.processWager, deps.consumerName, deps.businessObserver, deps.diagnostics),
    deps.options,
    deps.observer,
  );
}
