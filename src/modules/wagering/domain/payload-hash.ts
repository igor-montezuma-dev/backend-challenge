import { createHash } from "node:crypto";
import type { Money } from "../../../shared/domain/money";
import type { WagerTransactionKind } from "./wager-transaction";

/** Subconjunto de campos de negócio que identifica a operação. */
export interface WagerPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string | undefined;
}

/**
 * payloadHash = hex(SHA-256(JSON canônico do payload de negócio)).
 *
 * JSON canônico:
 *  - chaves ordenadas lexicograficamente em todos os níveis;
 *  - sem espaços;
 *  - money normalizado pelo Money ("25" e "25.00" geram o mesmo hash);
 *  - campos opcionais ausentes são omitidos (nunca serializados como null).
 *
 * Fora do hash: o header Idempotency-Key, messageId, occurredAt e qualquer
 * metadado de transporte — a mesma operação via HTTP ou via SQS tem o mesmo hash.
 */
export function wagerPayloadHash(payload: WagerPayload): string {
  const canonical = canonicalJson({
    providerId: payload.providerId,
    externalTransactionId: payload.externalTransactionId,
    playerId: payload.playerId,
    walletId: payload.walletId,
    roundId: payload.roundId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: { amount: payload.money.amount, currency: payload.money.currency },
    ...(payload.referenceExternalTransactionId !== undefined
      ? { referenceExternalTransactionId: payload.referenceExternalTransactionId }
      : {}),
  });
  return sha256Hex(canonical);
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json | undefined };

export function canonicalJson(value: Json): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k] as Json)}`).join(",")}}`;
}
