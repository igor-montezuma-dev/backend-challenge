/**
 * Envelope de evento de integração (seção 11 do desafio).
 *
 * `eventType` e `version` pertencem ao tipo (subclasse), nunca a uma string
 * solta no call site. `data` é JSON puro: dinheiro trafega como MoneyProps.
 */
export interface IntegrationEventProps<T> {
  eventId: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
  data: T;
}

/** Contexto comum de quem emite eventos num mesmo caso de uso. */
export interface EventContext {
  /** Gera o eventId de cada evento emitido. */
  nextEventId: () => string;
  correlationId: string;
  causationId?: string;
  occurredAt: Date;
}

export interface IntegrationEventEnvelope<T> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  correlationId: string;
  causationId?: string;
  occurredAt: string;
  version: number;
  data: T;
}

export abstract class IntegrationEvent<T> {
  abstract readonly eventType: string;
  abstract readonly version: number;

  readonly eventId: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
  readonly data: Readonly<T>;

  protected constructor(props: IntegrationEventProps<T>) {
    this.eventId = props.eventId;
    this.aggregateId = props.aggregateId;
    this.correlationId = props.correlationId;
    if (props.causationId !== undefined) this.causationId = props.causationId;
    this.occurredAt = props.occurredAt;
    this.data = Object.freeze(structuredClone(props.data));
  }

  /**
   * Chave de ordenação no broker (MessageGroupId do SQS FIFO). Por padrão o
   * agregado; eventos de transação sobrescrevem com a walletId para que tudo
   * de uma wallet saia na ordem em que foi confirmado.
   */
  get partitionKey(): string {
    return this.aggregateId;
  }

  toJSON(): IntegrationEventEnvelope<T> {
    return {
      eventId: this.eventId,
      eventType: this.eventType,
      aggregateId: this.aggregateId,
      correlationId: this.correlationId,
      ...(this.causationId !== undefined ? { causationId: this.causationId } : {}),
      occurredAt: this.occurredAt.toISOString(),
      version: this.version,
      data: structuredClone(this.data) as T,
    };
  }

  protected static propsFrom<T>(aggregateId: string, ctx: EventContext, data: T): IntegrationEventProps<T> {
    return {
      eventId: ctx.nextEventId(),
      aggregateId,
      correlationId: ctx.correlationId,
      ...(ctx.causationId !== undefined ? { causationId: ctx.causationId } : {}),
      occurredAt: ctx.occurredAt,
      data,
    };
  }
}
