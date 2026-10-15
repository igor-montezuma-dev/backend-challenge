import type { LoggerService } from "@nestjs/common";
import { Counter, Histogram, type Registry } from "prom-client";
import type { DiagnosticContext } from "../../../../shared/application/diagnostic-context";
import { isLockTimeout } from "../../../../shared/infrastructure/database/database-errors";
import type { UnitOfWorkObserver } from "../../../../shared/infrastructure/database/mikro-orm-unit-of-work";
import { errorCode, sampledGauge, seconds } from "../../../../shared/infrastructure/observability/gauges";
import type { PendingReferenceQueue } from "../../application/ports/pending-reference-queue.port";
import type { ReconciliationObserver } from "../../application/use-cases/reconcile-wallet.use-case";
import type { WagerProcessingObserver } from "../../application/use-cases/process-wager-transaction.use-case";
import type { PendingReferenceSweeperObserver } from "../../application/workers/pending-reference-sweeper";
import type { WagerMessageObserver } from "../../presentation/messaging/wager-transaction-message.handler";

export interface WageringTelemetry {
  wager: WagerProcessingObserver;
  unitOfWork: UnitOfWorkObserver;
  sweeper: PendingReferenceSweeperObserver;
  businessMessages: WagerMessageObserver;
  reconciliation: ReconciliationObserver;
}

export interface WageringTelemetryDependencies {
  registry: Registry;
  logger: LoggerService;
  diagnostics: DiagnosticContext;
  pendingReferences: PendingReferenceQueue;
}

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export function wageringTelemetry({ registry, logger, diagnostics, pendingReferences }: WageringTelemetryDependencies): WageringTelemetry {
  const registers = [registry];
  const transactions = new Counter({
    name: "wagering_transactions_total",
    help: "Transações novas por tipo, status final e canal de entrada",
    labelNames: ["kind", "status", "channel"] as const,
    registers,
  });
  const duplicates = new Counter({
    name: "wagering_duplicates_detected_total",
    help: "Requisições ou mensagens reconhecidas como repetição idempotente",
    labelNames: ["channel"] as const,
    registers,
  });
  const failures = new Counter({
    name: "wagering_transaction_errors_total",
    help: "Submissões que terminaram em erro (validação, conflito, infraestrutura)",
    labelNames: ["channel", "code"] as const,
    registers,
  });
  const latency = new Histogram({
    name: "wagering_transaction_duration_seconds",
    help: "Latência de processamento de uma submissão",
    labelNames: ["channel", "result"] as const,
    buckets: LATENCY_BUCKETS,
    registers,
  });
  const retries = new Counter({
    name: "wagering_db_retries_total",
    help: "Retentativas da unidade de trabalho por motivo",
    labelNames: ["reason"] as const,
    registers,
  });
  const lockConflicts = new Counter({
    name: "wagering_lock_conflicts_total",
    help: "Esperas por lock de wallet que excederam lock_timeout",
    labelNames: ["outcome"] as const,
    registers,
  });
  const resolutions = new Counter({
    name: "wagering_pending_reference_resolutions_total",
    help: "Reavaliações de PENDING_REFERENCE pelo worker, por resultado",
    labelNames: ["result"] as const,
    registers,
  });
  const divergences = new Counter({
    name: "wagering_reconciliation_divergences_total",
    help: "Reconciliações em que saldo armazenado difere do ledger",
    registers,
  });
  sampledGauge(registry, {
    name: "wagering_pending_references",
    help: "Transações aguardando referência (waiting = todas, due = já vencidas)",
    labelNames: ["state"] as const,
    sample: async () => {
      const backlog = await pendingReferences.backlog();
      return [
        { labels: { state: "waiting" }, value: backlog.waiting },
        { labels: { state: "due" }, value: backlog.due },
      ];
    },
  });

  return {
    wager: {
      onCompleted: ({ transaction, idempotentReplay }, channel, durationMs) => {
        diagnostics.annotate({ transactionId: transaction.id, walletId: transaction.walletId, providerId: transaction.providerId });
        if (idempotentReplay) duplicates.inc({ channel });
        else transactions.inc({ kind: transaction.kind, status: transaction.status, channel });
        latency.observe({ channel, result: idempotentReplay ? "replay" : transaction.status }, seconds(durationMs));
      },
      onFailed: (error, channel, durationMs) => {
        failures.inc({ channel, code: errorCode(error) });
        latency.observe({ channel, result: "error" }, seconds(durationMs));
      },
    },
    unitOfWork: {
      onRetry: (reason, attempt, error) => {
        retries.inc({ reason });
        if (isLockTimeout(error)) lockConflicts.inc({ outcome: "retried" });
        logger.warn({ msg: "unit of work retry", reason, attempt, code: errorCode(error) }, "UnitOfWork");
      },
      onGiveUp: (error, attempts) => {
        if (isLockTimeout(error)) lockConflicts.inc({ outcome: "gave_up" });
        logger.error({ msg: "unit of work gave up", attempts, error: String(error) }, undefined, "UnitOfWork");
      },
    },
    sweeper: {
      onResult: (transactionId, result) => {
        const label = result.kind === "settled" ? result.outcome : result.kind;
        resolutions.inc({ result: label });
        if (result.kind !== "skipped" && label !== "pending_reference") {
          logger.log({ msg: "pending reference resolved", transactionId, result: label }, "PendingReferenceSweeper");
        }
      },
      onFailure: (transactionId, error) => {
        resolutions.inc({ result: "error" });
        logger.warn({ msg: "pending reference re-evaluation failed", transactionId, error: String(error) }, "PendingReferenceSweeper");
      },
      onLoopError: (error) =>
        logger.error({ msg: "pending reference sweeper loop error", error: String(error) }, undefined, "PendingReferenceSweeper"),
    },
    businessMessages: {
      onBusinessFailure: (envelope, error) =>
        logger.warn({ msg: "wager message rejected by business rule", messageId: envelope.messageId, code: error.code }, "WagerQueueConsumer"),
    },
    reconciliation: {
      onDivergence: (report) => {
        divergences.inc();
        logger.error(
          {
            msg: "wallet reconciliation divergence",
            walletId: report.walletId,
            storedBalance: report.storedBalance.amount,
            calculatedBalance: report.calculatedBalance.amount,
            difference: report.difference.amount,
            walletVersion: report.walletVersion,
            lastEntryVersion: report.lastEntryVersion,
          },
          undefined,
          "Reconciliation",
        );
      },
    },
  };
}
