import { PLAYER_ID_EXAMPLE, WALLET_ID_EXAMPLE } from "./examples";

const BET_EXTERNAL_ID = "transaction-123";

const base = {
  providerId: "provider-a",
  playerId: PLAYER_ID_EXAMPLE,
  walletId: WALLET_ID_EXAMPLE,
  roundId: "round-987",
  gameId: "fortune-chimp",
};

const example = (summary: string, externalTransactionId: string, kind: string, amount: string, reference?: string) => ({
  summary,
  value: {
    ...base,
    externalTransactionId,
    kind,
    money: { amount, currency: "BRL" },
    ...(reference !== undefined ? { referenceExternalTransactionId: reference } : {}),
  },
});

export const SUBMIT_WAGER_EXAMPLES = {
  bet: example("BET de 25.00", BET_EXTERNAL_ID, "BET", "25.00"),
  win: example("WIN referenciando a BET", "transaction-124", "WIN", "60.00", BET_EXTERNAL_ID),
  loss: example("LOSS (sem efeito no saldo)", "transaction-125", "LOSS", "0.00"),
  refund: example("REFUND da BET", "transaction-126", "REFUND", "25.00", BET_EXTERNAL_ID),
  rollback: example("ROLLBACK da BET", "transaction-127", "ROLLBACK", "25.00", BET_EXTERNAL_ID),
};
