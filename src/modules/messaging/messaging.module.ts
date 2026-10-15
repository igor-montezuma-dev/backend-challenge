import type { SQSClient } from "@aws-sdk/client-sqs";
import { MikroORM } from "@mikro-orm/postgresql";
import { Global, Logger, Module } from "@nestjs/common";
import type { Registry } from "prom-client";
import { APP_CONFIG, type AppConfig } from "../../config/app.config";
import { CLOCK, type Clock } from "../../shared/application/clock";
import { ManagedWorker } from "../../shared/infrastructure/background-worker";
import { METRICS_REGISTRY } from "../../shared/infrastructure/observability/metrics-registry";
import { OutboxRelay } from "./application/outbox-relay";
import { DEFAULT_OUTBOX_RETRY_POLICY } from "./domain/outbox-message";
import { outboxTelemetry } from "./infrastructure/observability/messaging-telemetry";
import { SqlOutboxStore } from "./infrastructure/outbox/sql-outbox.store";
import { SQS_CLIENT, createSqsClient } from "./infrastructure/sqs/sqs-client.factory";
import { SqsEventPublisher } from "./infrastructure/sqs/sqs-event-publisher";

export const OUTBOX_RELAY = Symbol("OUTBOX_RELAY");
const OUTBOX_RELAY_WORKER = Symbol("OUTBOX_RELAY_WORKER");

const logger = new Logger();

@Global()
@Module({
  providers: [
    {
      provide: SQS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => createSqsClient(config.sqs),
    },
    {
      provide: OUTBOX_RELAY,
      inject: [MikroORM, SQS_CLIENT, CLOCK, APP_CONFIG, METRICS_REGISTRY],
      useFactory: (orm: MikroORM, sqs: SQSClient, clock: Clock, config: AppConfig, registry: Registry) => {
        const store = new SqlOutboxStore(orm);
        return new OutboxRelay(
          store,
          new SqsEventPublisher(sqs, config.sqs.eventsQueueUrl),
          clock,
          { owner: config.instanceId, ...config.outbox, retryPolicy: DEFAULT_OUTBOX_RETRY_POLICY },
          outboxTelemetry(registry, logger, store),
        );
      },
    },
    {
      provide: OUTBOX_RELAY_WORKER,
      inject: [OUTBOX_RELAY, APP_CONFIG],
      useFactory: (relay: OutboxRelay, config: AppConfig) => new ManagedWorker("OutboxRelay", relay, config.outbox.enabled),
    },
  ],
  exports: [SQS_CLIENT, OUTBOX_RELAY],
})
export class MessagingModule {}
