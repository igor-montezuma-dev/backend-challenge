import { Counter, Histogram, type Registry } from "prom-client";
import type { LoggerService } from "@nestjs/common";
import { errorCode, sampledGauge, seconds } from "../../../../shared/infrastructure/observability/gauges";
import type { OutboxRelayObserver } from "../../application/outbox-relay";
import type { OutboxStore } from "../../application/ports/outbox-store.port";
import type { QueueConsumerObserver } from "../../application/queue-consumer";

export function outboxTelemetry(registry: Registry, logger: LoggerService, store: OutboxStore): OutboxRelayObserver {
  const events = new Counter({
    name: "wagering_outbox_events_total",
    help: "Eventos da outbox processados pelo relay, por resultado",
    labelNames: ["result", "event_type"] as const,
    registers: [registry],
  });
  sampledGauge(registry, {
    name: "wagering_outbox_pending_events",
    help: "Eventos confirmados ainda não publicados",
    sample: async () => [{ value: (await store.pendingStats()).pending }],
  });
  sampledGauge(registry, {
    name: "wagering_outbox_lag_seconds",
    help: "Idade do evento pendente mais antigo (atraso da outbox)",
    sample: async () => [{ value: seconds((await store.pendingStats()).oldestPendingAgeMs) }],
  });

  return {
    onPublished: (message) => events.inc({ result: "published", event_type: message.eventType }),
    onFailed: (message, error) => {
      events.inc({ result: "failed", event_type: message.eventType });
      logger.warn(
        { msg: "outbox publish failed", eventId: message.id, eventType: message.eventType, attempts: message.attempts, error: String(error) },
        "OutboxRelay",
      );
    },
    onLoopError: (error) => logger.error({ msg: "outbox relay loop error", code: errorCode(error), error: String(error) }, undefined, "OutboxRelay"),
  };
}

export interface QueueTelemetryOptions {
  queue: string;
  deadLetterDepth?: () => Promise<number>;
}

export function queueConsumerTelemetry(registry: Registry, logger: LoggerService, options: QueueTelemetryOptions): QueueConsumerObserver {
  const messages = new Counter({
    name: "wagering_queue_messages_total",
    help: "Mensagens consumidas por decisão (ack, retry, dead_letter)",
    labelNames: ["queue", "disposition"] as const,
    registers: [registry],
  });
  const duration = new Histogram({
    name: "wagering_queue_message_duration_seconds",
    help: "Tempo de processamento de uma mensagem até a decisão",
    labelNames: ["queue", "disposition"] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });
  const receiveErrors = new Counter({
    name: "wagering_queue_receive_errors_total",
    help: "Falhas ao receber mensagens do broker",
    labelNames: ["queue"] as const,
    registers: [registry],
  });
  const { deadLetterDepth } = options;
  if (deadLetterDepth) {
    sampledGauge(registry, {
      name: "wagering_dead_letter_queue_messages",
      help: "Mensagens aguardando na DLQ (aproximado, inclui redrive automático)",
      labelNames: ["queue"] as const,
      sample: async () => [{ labels: { queue: options.queue }, value: await deadLetterDepth() }],
    });
  }

  return {
    onDisposition: (message, disposition, durationMs) => {
      const labels = { queue: options.queue, disposition: disposition.kind };
      messages.inc(labels);
      duration.observe(labels, seconds(durationMs));
      if (disposition.kind === "ack") return;
      logger.warn(
        {
          msg: disposition.kind === "dead_letter" ? "message sent to dead-letter queue" : "message scheduled for retry",
          messageId: message.id,
          groupId: message.groupId,
          receiveCount: message.receiveCount,
          reason: disposition.reason,
          durationMs: Math.round(durationMs),
        },
        "QueueConsumer",
      );
    },
    onReceiveError: (error) => {
      receiveErrors.inc({ queue: options.queue });
      logger.error({ msg: "failed to receive messages", error: String(error) }, undefined, "QueueConsumer");
    },
  };
}
