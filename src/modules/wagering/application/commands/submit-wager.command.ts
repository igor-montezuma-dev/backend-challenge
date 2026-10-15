import { Guard } from "../../../../shared/domain/guard";
import { Money, type MoneyProps } from "../../../../shared/domain/money";
import { type WagerPayload, wagerPayloadHash } from "../../domain/transaction/wager-payload";
import { FIELD_LIMITS, SUBMITTABLE_KINDS } from "../../domain/transaction/wager-transaction";

export interface SubmitWagerCommand extends WagerPayload {
  idempotencyKey: string;
  payloadHash: string;
}

export const WAGER_PAYLOAD_FIELDS = [
  "providerId",
  "externalTransactionId",
  "playerId",
  "walletId",
  "roundId",
  "gameId",
  "kind",
  "money",
  "referenceExternalTransactionId",
] as const satisfies readonly (keyof WagerPayload)[];

const SUBMISSION_FIELDS = [...WAGER_PAYLOAD_FIELDS, "idempotencyKey"] as const;

export function parseSubmitWagerCommand(input: unknown): SubmitWagerCommand {
  const raw = Guard.knownFields(Guard.object(input), SUBMISSION_FIELDS);
  const payload: WagerPayload = {
    providerId: Guard.text(raw.providerId, "providerId", FIELD_LIMITS.providerId),
    externalTransactionId: Guard.text(raw.externalTransactionId, "externalTransactionId", FIELD_LIMITS.externalTransactionId),
    playerId: Guard.uuid(raw.playerId, "playerId"),
    walletId: Guard.uuid(raw.walletId, "walletId"),
    roundId: Guard.text(raw.roundId, "roundId", FIELD_LIMITS.roundId),
    gameId: Guard.text(raw.gameId, "gameId", FIELD_LIMITS.gameId),
    kind: Guard.oneOf(raw.kind, "kind", SUBMITTABLE_KINDS),
    money: Money.from(raw.money as MoneyProps),
    referenceExternalTransactionId: Guard.optionalText(
      raw.referenceExternalTransactionId,
      "referenceExternalTransactionId",
      FIELD_LIMITS.externalTransactionId,
    ),
  };
  return {
    ...payload,
    idempotencyKey: Guard.text(raw.idempotencyKey, "idempotencyKey", FIELD_LIMITS.idempotencyKey),
    payloadHash: wagerPayloadHash(payload),
  };
}
