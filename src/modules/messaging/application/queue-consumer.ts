import type {
  MessageDisposition,
  MessageHandler,
  MessageQueue,
  ReceivedMessage,
} from "./ports/message-queue.port";

export interface QueueConsumerOptions {
  maxMessages: number;
  waitTimeSeconds: number;
  visibilityTimeoutSeconds: number;
  maxRetryDelaySeconds: number;
  shutdownGraceMs: number;
  errorBackoffMs: number;
}

export interface QueueConsumerObserver {
  onDisposition(message: ReceivedMessage, disposition: MessageDisposition, durationMs: number): void;
  onReceiveError(error: unknown): void;
}

const SILENT: QueueConsumerObserver = { onDisposition: () => {}, onReceiveError: () => {} };

export class QueueConsumer {
  private stopping = false;
  private loop: Promise<void> | undefined;
  private receiving: AbortController | undefined;

  constructor(
    private readonly queue: MessageQueue,
    private readonly handler: MessageHandler,
    private readonly options: QueueConsumerOptions,
    private readonly observer: QueueConsumerObserver = SILENT,
  ) {}

  start(): void {
    if (this.loop) return;
    this.stopping = false;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.receiving?.abort();
    if (!this.loop) return;
    await Promise.race([this.loop, sleep(this.options.shutdownGraceMs)]);
    this.loop = undefined;
  }

  async pollOnce(): Promise<number> {
    this.receiving = new AbortController();
    const messages = await this.queue.receive(
      {
        maxMessages: this.options.maxMessages,
        waitTimeSeconds: this.options.waitTimeSeconds,
        visibilityTimeoutSeconds: this.options.visibilityTimeoutSeconds,
      },
      this.receiving.signal,
    );
    await Promise.all(groupInArrivalOrder(messages).map((group) => this.processGroup(group)));
    return messages.length;
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (this.stopping) break;
        this.observer.onReceiveError(error);
        await sleep(this.options.errorBackoffMs);
      }
    }
  }

  private async processGroup(group: ReceivedMessage[]): Promise<void> {
    for (const [index, message] of group.entries()) {
      if (this.stopping) {
        await Promise.all(group.slice(index).map((pending) => this.queue.release(pending)));
        return;
      }
      await this.processOne(message);
    }
  }

  private async processOne(message: ReceivedMessage): Promise<void> {
    const startedAt = performance.now();
    const disposition = await this.handler.handle(message).catch(
      (error: unknown): MessageDisposition => ({ kind: "retry", reason: describe(error) }),
    );
    await this.apply(message, disposition);
    this.observer.onDisposition(message, disposition, performance.now() - startedAt);
  }

  private apply(message: ReceivedMessage, disposition: MessageDisposition): Promise<void> {
    switch (disposition.kind) {
      case "ack":
        return this.queue.acknowledge(message);
      case "retry":
        return this.queue.retryLater(message, this.retryDelaySeconds(message.receiveCount));
      case "dead_letter":
        return this.queue.deadLetter(message, disposition.reason);
    }
  }

  private retryDelaySeconds(receiveCount: number): number {
    return Math.min(2 ** Math.max(receiveCount, 0), this.options.maxRetryDelaySeconds);
  }
}

function groupInArrivalOrder(messages: readonly ReceivedMessage[]): ReceivedMessage[][] {
  const groups = new Map<string, ReceivedMessage[]>();
  for (const message of messages) {
    const key = message.groupId ?? message.id;
    groups.set(key, [...(groups.get(key) ?? []), message]);
  }
  return [...groups.values()];
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
