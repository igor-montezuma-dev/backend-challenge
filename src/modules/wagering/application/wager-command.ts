import { ValidationError } from "../../../shared/domain/domain-error";
import { Money, type MoneyProps } from "../../../shared/domain/money";
import { type WagerPayload, wagerPayloadHash } from "../domain/payload-hash";
import { SUBMITTABLE_KINDS, type WagerTransactionKind } from "../domain/wager-transaction";

/**
 * Comando de submissão — mesmo formato para HTTP e SQS (`data` da mensagem).
 * Chega como `unknown` vindo do transporte e é validado aqui, uma única vez,
 * para os dois canais.
 */
export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string | undefined;
}

export interface ParsedWagerCommand extends WagerPayload {
  idempotencyKey: string;
  payloadHash: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseWagerCommand(input: unknown): ParsedWagerCommand {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("payload must be a JSON object");
  }
  const raw = input as Record<string, unknown>;

  const str = (field: string, max: number): string => {
    const value = raw[field];
    if (typeof value !== "string" || value.trim() === "" || value.length > max) {
      throw new ValidationError(`${field} must be a non-empty string up to ${max} characters`, field);
    }
    return value;
  };
  const uuid = (field: string): string => {
    const value = str(field, 36);
    if (!UUID.test(value)) throw new ValidationError(`${field} must be a UUID`, field);
    return value.toLowerCase();
  };

  const kind = str("kind", 16);
  if (!SUBMITTABLE_KINDS.includes(kind as WagerTransactionKind)) {
    throw new ValidationError(`kind must be one of ${SUBMITTABLE_KINDS.join(", ")}`, "kind");
  }

  const reference = raw.referenceExternalTransactionId;
  if (reference !== undefined && reference !== null && (typeof reference !== "string" || reference.trim() === "")) {
    throw new ValidationError("referenceExternalTransactionId must be a non-empty string", "referenceExternalTransactionId");
  }

  const payload: WagerPayload = {
    providerId: str("providerId", 128),
    externalTransactionId: str("externalTransactionId", 256),
    playerId: uuid("playerId"),
    walletId: uuid("walletId"),
    roundId: str("roundId", 256),
    gameId: str("gameId", 256),
    kind: kind as WagerTransactionKind,
    money: Money.from(raw.money as MoneyProps),
    referenceExternalTransactionId: typeof reference === "string" ? reference : undefined,
  };

  return {
    ...payload,
    idempotencyKey: str("idempotencyKey", 512),
    payloadHash: wagerPayloadHash(payload),
  };
}

/** Chave padrão recomendada pelo desafio. */
export const defaultIdempotencyKey = (providerId: string, externalTransactionId: string): string =>
  `${providerId}:${externalTransactionId}`;
