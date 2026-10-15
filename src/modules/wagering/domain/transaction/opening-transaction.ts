import { fingerprint } from "../../../../shared/domain/fingerprint";
import type { Wallet } from "../wallet/wallet";
import { WagerTransaction } from "./wager-transaction";

export const INTERNAL_PROVIDER_ID = "internal";

export function openingTransactionFor(wallet: Wallet, id: string, at: Date): WagerTransaction {
  const externalTransactionId = `opening:${wallet.id}`;
  return WagerTransaction.opening({
    id,
    providerId: INTERNAL_PROVIDER_ID,
    externalTransactionId,
    idempotencyKey: `${INTERNAL_PROVIDER_ID}:${externalTransactionId}`,
    payloadHash: fingerprint({ walletId: wallet.id, initialBalance: { ...wallet.balance.toJSON() } }),
    walletId: wallet.id,
    playerId: wallet.playerId,
    roundId: "opening",
    gameId: INTERNAL_PROVIDER_ID,
    money: wallet.balance,
    createdAt: at,
  });
}
