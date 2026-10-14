import { InvalidStateTransitionError } from "../../../shared/domain/domain-error";

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  processedAt?: Date | undefined;
}

/**
 * Registro de mensagem recebida. A deduplicação real é a PK
 * (consumer_name, message_id) no banco, gravada na mesma transação SQL do
 * efeito financeiro: se o commit acontece, a mensagem conta como processada;
 * se não acontece, nada aconteceu e a redelivery reprocessa.
 */
export class InboxMessage {
  private constructor(
    readonly messageId: string,
    readonly consumerName: string,
    readonly payloadHash: string,
    readonly receivedAt: Date,
    private _processedAt: Date | undefined,
  ) {}

  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(props.messageId, props.consumerName, props.payloadHash, props.receivedAt, undefined);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  markProcessed(at: Date): void {
    if (this.isProcessed()) {
      throw new InvalidStateTransitionError(`inbox message ${this.messageId} already processed`);
    }
    this._processedAt = at;
  }

  /** Mesmo messageId com conteúdo diferente: produtor com bug ou colisão de id. */
  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }
}
