import { type DiagnosticContext, NO_DIAGNOSTIC_CONTEXT } from "../../../../shared/application/diagnostic-context";
import { ConflictError, NotFoundError, TransientInfrastructureError } from "../../../../shared/application/errors";
import { DomainError } from "../../../../shared/domain/domain-error";
import { type Json, fingerprint } from "../../../../shared/domain/fingerprint";
import { Guard } from "../../../../shared/domain/guard";
import type {
  MessageDisposition,
  MessageHandler,
  ReceivedMessage,
} from "../../../messaging/application/ports/message-queue.port";
import type { ProcessWagerTransaction } from "../../application/use-cases/process-wager-transaction.use-case";

export const WAGER_TRANSACTION_REQUESTED = "WagerTransactionRequested";

const MESSAGE_ID_MAX_LENGTH = 256;

interface WagerTransactionRequested {
  messageId: string;
  data: Record<string, unknown>;
}

export interface WagerMessageObserver {
  onBusinessFailure(envelope: WagerTransactionRequested, error: DomainError | ConflictError | NotFoundError): void;
}

const SILENT: WagerMessageObserver = { onBusinessFailure: () => {} };

export class WagerTransactionMessageHandler implements MessageHandler {
  constructor(
    private readonly processWager: ProcessWagerTransaction,
    private readonly consumerName: string,
    private readonly observer: WagerMessageObserver = SILENT,
    private readonly diagnostics: DiagnosticContext = NO_DIAGNOSTIC_CONTEXT,
  ) {}

  handle(message: ReceivedMessage): Promise<MessageDisposition> {
    const envelope = parseEnvelope(message.body);
    if (envelope instanceof Error) {
      return Promise.resolve({ kind: "dead_letter", reason: `invalid envelope: ${envelope.message}` });
    }
    return this.diagnostics.run(
      {
        correlationId: envelope.messageId,
        messageId: envelope.messageId,
        walletId: textField(envelope.data.walletId),
        providerId: textField(envelope.data.providerId),
        externalTransactionId: textField(envelope.data.externalTransactionId),
      },
      () => this.process(envelope),
    );
  }

  private async process(envelope: WagerTransactionRequested): Promise<MessageDisposition> {
    try {
      await this.processWager.execute(envelope.data, {
        correlationId: envelope.messageId,
        causationId: envelope.messageId,
        inbox: {
          consumerName: this.consumerName,
          messageId: envelope.messageId,
          payloadHash: fingerprint(envelope.data as Json),
        },
      });
      return { kind: "ack" };
    } catch (error) {
      return this.dispositionFor(envelope, error);
    }
  }

  private dispositionFor(envelope: WagerTransactionRequested, error: unknown): MessageDisposition {
    if (error instanceof TransientInfrastructureError) return { kind: "retry", reason: error.message };
    if (error instanceof DomainError) return { kind: "dead_letter", reason: `${error.code}: ${error.message}` };
    if (error instanceof ConflictError || error instanceof NotFoundError) {
      this.observer.onBusinessFailure(envelope, error);
      return { kind: "ack" };
    }
    return { kind: "retry", reason: error instanceof Error ? error.message : String(error) };
  }
}

const textField = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= MESSAGE_ID_MAX_LENGTH ? value : undefined;

function parseEnvelope(body: string): WagerTransactionRequested | Error {
  try {
    const raw = Guard.object(JSON.parse(body), "message");
    Guard.oneOf(raw.type, "type", [WAGER_TRANSACTION_REQUESTED]);
    return {
      messageId: Guard.text(raw.messageId, "messageId", MESSAGE_ID_MAX_LENGTH),
      data: Guard.object(raw.data, "data"),
    };
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}
