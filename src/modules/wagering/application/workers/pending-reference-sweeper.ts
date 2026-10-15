import { type BackgroundWorker, PollingLoop } from "../../../../shared/application/background-worker";
import { type DiagnosticContext, NO_DIAGNOSTIC_CONTEXT } from "../../../../shared/application/diagnostic-context";
import type { PendingReferenceQueue } from "../ports/pending-reference-queue.port";
import type { PendingSettlementResult, SettlePendingReference } from "../use-cases/settle-pending-reference.use-case";

export interface PendingReferenceSweeperOptions {
  batchSize: number;
  leaseMs: number;
  pollIntervalMs: number;
}

export interface SweepReport {
  claimed: number;
  settled: number;
  expired: number;
  skipped: number;
  failed: number;
}

export interface PendingReferenceSweeperObserver {
  onResult(transactionId: string, result: PendingSettlementResult): void;
  onFailure(transactionId: string, error: unknown): void;
  onLoopError(error: unknown): void;
}

const SILENT: PendingReferenceSweeperObserver = { onResult: () => {}, onFailure: () => {}, onLoopError: () => {} };

export class PendingReferenceSweeper implements BackgroundWorker {
  private readonly loop: PollingLoop;

  constructor(
    private readonly queue: PendingReferenceQueue,
    private readonly settlePendingReference: SettlePendingReference,
    private readonly options: PendingReferenceSweeperOptions,
    private readonly observer: PendingReferenceSweeperObserver = SILENT,
    private readonly diagnostics: DiagnosticContext = NO_DIAGNOSTIC_CONTEXT,
  ) {
    this.loop = new PollingLoop(async () => (await this.sweepOnce()).claimed > 0, {
      intervalMs: options.pollIntervalMs,
      onError: (error) => observer.onLoopError(error),
    });
  }

  start(): void {
    this.loop.start();
  }

  stop(): Promise<void> {
    return this.loop.stop();
  }

  async sweepOnce(): Promise<SweepReport> {
    const claimed = await this.queue.claimDue(this.options.batchSize, this.options.leaseMs);
    const results = await Promise.all(claimed.map((transactionId) => this.settle(transactionId)));
    return results.reduce<SweepReport>(
      (report, kind) => ({ ...report, [kind]: report[kind] + 1 }),
      { claimed: claimed.length, settled: 0, expired: 0, skipped: 0, failed: 0 },
    );
  }

  private settle(transactionId: string): Promise<"settled" | "expired" | "skipped" | "failed"> {
    return this.diagnostics.run({ transactionId }, async () => {
      try {
        const result = await this.settlePendingReference.execute(transactionId);
        this.observer.onResult(transactionId, result);
        return result.kind;
      } catch (error) {
        this.observer.onFailure(transactionId, error);
        return "failed";
      }
    });
  }
}
