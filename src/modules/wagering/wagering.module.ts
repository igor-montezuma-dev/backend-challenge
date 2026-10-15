import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { MikroORM } from "@mikro-orm/postgresql";
import { type FactoryProvider, type InjectionToken, Logger, Module } from "@nestjs/common";
import type { Registry } from "prom-client";
import { APP_CONFIG, type AppConfig } from "../../config/app.config";
import { CLOCK, type Clock } from "../../shared/application/clock";
import { DIAGNOSTIC_CONTEXT, type DiagnosticContext } from "../../shared/application/diagnostic-context";
import { ID_GENERATOR, type IdGenerator } from "../../shared/application/id-generator";
import { ManagedWorker } from "../../shared/infrastructure/background-worker";
import { METRICS_REGISTRY } from "../../shared/infrastructure/observability/metrics-registry";
import { queueConsumerTelemetry } from "../messaging/infrastructure/observability/messaging-telemetry";
import { MESSAGING_ENTITIES } from "../messaging/infrastructure/persistence/messaging.entities";
import { SQS_CLIENT, approximateQueueDepth } from "../messaging/infrastructure/sqs/sqs-client.factory";
import { TRANSACTION_READ_MODEL } from "./application/ports/transaction-read-model.port";
import { WALLET_READ_MODEL } from "./application/ports/wallet-read-model.port";
import { OpenWallet } from "./application/use-cases/open-wallet.use-case";
import { ProcessWagerTransaction } from "./application/use-cases/process-wager-transaction.use-case";
import { ReconcileWallet } from "./application/use-cases/reconcile-wallet.use-case";
import { SettlePendingReference } from "./application/use-cases/settle-pending-reference.use-case";
import { PendingReferenceSweeper } from "./application/workers/pending-reference-sweeper";
import { DEFAULT_REFERENCE_RETRY_POLICY } from "./domain/transaction/reference-retry-policy";
import { type WageringTelemetry, wageringTelemetry } from "./infrastructure/observability/wagering-telemetry";
import { SqlPendingReferenceQueue } from "./infrastructure/persistence/sql-pending-reference.queue";
import { WAGERING_ENTITIES } from "./infrastructure/persistence/wagering.entities";
import { createWagerQueueConsumer } from "./infrastructure/wager-queue-consumer.factory";
import { type WageringApplication, composeWagering } from "./infrastructure/wagering.composition";
import { WagerTransactionsController } from "./presentation/http/wager-transactions.controller";
import { WalletsController } from "./presentation/http/wallets.controller";

const WAGERING_APPLICATION = Symbol("WAGERING_APPLICATION");
const WAGERING_TELEMETRY = Symbol("WAGERING_TELEMETRY");
const PENDING_REFERENCE_QUEUE = Symbol("PENDING_REFERENCE_QUEUE");
const WAGER_QUEUE_CONSUMER_WORKER = Symbol("WAGER_QUEUE_CONSUMER_WORKER");
const PENDING_REFERENCE_WORKER = Symbol("PENDING_REFERENCE_WORKER");
const ERROR_BACKOFF_MS = 1_000;

const logger = new Logger();

const fromApplication = <K extends keyof WageringApplication>(provide: InjectionToken, key: K): FactoryProvider => ({
  provide,
  inject: [WAGERING_APPLICATION],
  useFactory: (application: WageringApplication) => application[key],
});

@Module({
  imports: [MikroOrmModule.forFeature([...WAGERING_ENTITIES, ...MESSAGING_ENTITIES])],
  controllers: [WalletsController, WagerTransactionsController],
  providers: [
    {
      provide: PENDING_REFERENCE_QUEUE,
      inject: [MikroORM],
      useFactory: (orm: MikroORM) => new SqlPendingReferenceQueue(orm),
    },
    {
      provide: WAGERING_TELEMETRY,
      inject: [METRICS_REGISTRY, DIAGNOSTIC_CONTEXT, PENDING_REFERENCE_QUEUE],
      useFactory: (registry: Registry, diagnostics: DiagnosticContext, pendingReferences: SqlPendingReferenceQueue) =>
        wageringTelemetry({ registry, logger, diagnostics, pendingReferences }),
    },
    {
      provide: WAGERING_APPLICATION,
      inject: [MikroORM, ID_GENERATOR, CLOCK, APP_CONFIG, WAGERING_TELEMETRY],
      useFactory: (orm: MikroORM, ids: IdGenerator, clock: Clock, config: AppConfig, telemetry: WageringTelemetry) =>
        composeWagering({
          orm,
          ids,
          clock,
          settings: { ...config.wagering, referenceRetryPolicy: DEFAULT_REFERENCE_RETRY_POLICY },
          reconciliationObserver: telemetry.reconciliation,
          unitOfWorkObserver: telemetry.unitOfWork,
          wagerObserver: telemetry.wager,
        }),
    },
    fromApplication(OpenWallet, "openWallet"),
    fromApplication(ProcessWagerTransaction, "processWager"),
    fromApplication(SettlePendingReference, "settlePendingReference"),
    fromApplication(ReconcileWallet, "reconcileWallet"),
    fromApplication(WALLET_READ_MODEL, "walletReadModel"),
    fromApplication(TRANSACTION_READ_MODEL, "transactionReadModel"),
    {
      provide: WAGER_QUEUE_CONSUMER_WORKER,
      inject: [ProcessWagerTransaction, SQS_CLIENT, APP_CONFIG, WAGERING_TELEMETRY, METRICS_REGISTRY, DIAGNOSTIC_CONTEXT],
      useFactory: (
        processWager: ProcessWagerTransaction,
        sqs: SQSClient,
        config: AppConfig,
        telemetry: WageringTelemetry,
        registry: Registry,
        diagnostics: DiagnosticContext,
      ) => {
        const { consumer } = config;
        const worker = createWagerQueueConsumer({
          processWager,
          sqs,
          queueUrl: config.sqs.wagerQueueUrl,
          deadLetterQueueUrl: config.sqs.wagerDeadLetterQueueUrl,
          consumerName: consumer.name,
          options: {
            maxMessages: consumer.maxMessages,
            waitTimeSeconds: consumer.waitTimeSeconds,
            visibilityTimeoutSeconds: consumer.visibilityTimeoutSeconds,
            maxRetryDelaySeconds: consumer.maxRetryDelaySeconds,
            shutdownGraceMs: consumer.shutdownGraceMs,
            errorBackoffMs: ERROR_BACKOFF_MS,
          },
          observer: queueConsumerTelemetry(registry, logger, {
            queue: consumer.name,
            deadLetterDepth: () => approximateQueueDepth(sqs, config.sqs.wagerDeadLetterQueueUrl),
          }),
          businessObserver: telemetry.businessMessages,
          diagnostics,
        });
        return new ManagedWorker("WagerQueueConsumer", worker, consumer.enabled);
      },
    },
    {
      provide: PENDING_REFERENCE_WORKER,
      inject: [PENDING_REFERENCE_QUEUE, SettlePendingReference, APP_CONFIG, WAGERING_TELEMETRY, DIAGNOSTIC_CONTEXT],
      useFactory: (
        queue: SqlPendingReferenceQueue,
        settle: SettlePendingReference,
        config: AppConfig,
        telemetry: WageringTelemetry,
        diagnostics: DiagnosticContext,
      ) => {
        const { enabled, ...options } = config.pendingReferences;
        const sweeper = new PendingReferenceSweeper(queue, settle, options, telemetry.sweeper, diagnostics);
        return new ManagedWorker("PendingReferenceSweeper", sweeper, enabled);
      },
    },
  ],
  exports: [ProcessWagerTransaction, SettlePendingReference],
})
export class WageringModule {}
