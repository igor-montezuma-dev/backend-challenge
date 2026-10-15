export interface ReceivedMessage {
  readonly id: string;
  readonly receiptHandle: string;
  readonly body: string;
  readonly receiveCount: number;
  readonly groupId: string | undefined;
}

export interface ReceiveOptions {
  maxMessages: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
}

export interface MessageQueue {
  receive(options: ReceiveOptions, signal: AbortSignal): Promise<ReceivedMessage[]>;
  acknowledge(message: ReceivedMessage): Promise<void>;
  retryLater(message: ReceivedMessage, delaySeconds: number): Promise<void>;
  release(message: ReceivedMessage): Promise<void>;
  deadLetter(message: ReceivedMessage, reason: string): Promise<void>;
}

export type MessageDisposition =
  | { kind: "ack" }
  | { kind: "retry"; reason: string }
  | { kind: "dead_letter"; reason: string };

export interface MessageHandler {
  handle(message: ReceivedMessage): Promise<MessageDisposition>;
}
