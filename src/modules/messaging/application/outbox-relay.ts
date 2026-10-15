import { type BackgroundWorker, PollingLoop } from "../../../shared/application/background-worker";
import type { Clock } from "../../../shared/application/clock";
import type { OutboxMessage, OutboxRetryPolicy } from "../domain/outbox-message";
import type { EventPublisher, PublishResult } from "./ports/event-publisher.port";
import type { ClaimedOutboxMessage, OutboxStore } from "./ports/outbox-store.port";

export interface OutboxRelayOptions {
  owner: string;
  batchSize: number;
  leaseMs: number;
  pollIntervalMs: number;
  retryPolicy: OutboxRetryPolicy;
}

export interface RelayReport {
  published: number;
  failed: number;
  deferred: number;
}

export interface OutboxRelayObserver {
  onPublished(message: OutboxMessage): void;
  onFailed(message: OutboxMessage, error: unknown): void;
  onLoopError(error: unknown): void;
}

const SILENT: OutboxRelayObserver = { onPublished: () => {}, onFailed: () => {}, onLoopError: () => {} };
const EMPTY_REPORT: RelayReport = { published: 0, failed: 0, deferred: 0 };

export class OutboxRelay implements BackgroundWorker {
  private readonly loop: PollingLoop;

  constructor(
    private readonly store: OutboxStore,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly options: OutboxRelayOptions,
    private readonly observer: OutboxRelayObserver = SILENT,
  ) {
    this.loop = new PollingLoop(
      async () => {
        const report = await this.relayOnce();
        return report.published + report.failed > 0;
      },
      { intervalMs: options.pollIntervalMs, onError: (error) => observer.onLoopError(error) },
    );
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  async relayOnce(): Promise<RelayReport> {
    const claimed = await this.store.claimDue(this.options.owner, this.options.batchSize, this.options.leaseMs);
    const reports = await Promise.all(byPartitionInOrder(claimed).map((partition) => this.relayPartition(partition)));
    return reports.reduce(sumReports, EMPTY_REPORT);
  }

  private async relayPartition(partition: ClaimedOutboxMessage[]): Promise<RelayReport> {
    const [head] = partition;
    const messages = partition.map((claimed) => claimed.message);
    if (!head || (await this.store.hasEarlierUnpublished(head.message.partitionKey, head.position))) {
      await this.store.release(messages, this.options.owner);
      return { ...EMPTY_REPORT, deferred: messages.length };
    }

    const result = await this.publisher
      .publishInOrder(messages)
      .catch((error: unknown): PublishResult => ({ kind: "partial", publishedCount: 0, error }));
    const publishedCount = result.kind === "published" ? messages.length : result.publishedCount;
    await this.recordPublished(messages.slice(0, publishedCount));
    if (result.kind === "published") return { ...EMPTY_REPORT, published: publishedCount };

    const failed = messages[publishedCount]!;
    await this.handleFailure(failed, result.error);
    const blocked = messages.slice(publishedCount + 1);
    await this.store.release(blocked, this.options.owner);
    return { published: publishedCount, failed: 1, deferred: blocked.length };
  }

  private async recordPublished(messages: readonly OutboxMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const at = this.clock.now();
    for (const message of messages) message.markPublished(at);
    await this.store.markPublished(messages);
    for (const message of messages) this.observer.onPublished(message);
  }

  private async handleFailure(message: OutboxMessage, error: unknown): Promise<void> {
    this.observer.onFailed(message, error);
    if (!message.isPending()) return;
    const now = this.clock.now();
    message.scheduleRetry(now, error instanceof Error ? error.message : String(error), this.options.retryPolicy);
    await this.store.reschedule(message, message.nextAttemptAt!.getTime() - now.getTime());
  }
}

function byPartitionInOrder(claimed: readonly ClaimedOutboxMessage[]): ClaimedOutboxMessage[][] {
  const partitions = new Map<string, ClaimedOutboxMessage[]>();
  for (const item of claimed) {
    const key = item.message.partitionKey;
    partitions.set(key, [...(partitions.get(key) ?? []), item]);
  }
  return [...partitions.values()].map((items) => items.sort((a, b) => (a.position < b.position ? -1 : 1)));
}

const sumReports = (a: RelayReport, b: RelayReport): RelayReport => ({
  published: a.published + b.published,
  failed: a.failed + b.failed,
  deferred: a.deferred + b.deferred,
});
