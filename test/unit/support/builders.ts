import { Money } from "../../../src/shared/domain/money";
import { Wallet } from "../../../src/modules/wagering/domain/wallet/wallet";
import { wagerPayloadHash } from "../../../src/modules/wagering/domain/transaction/wager-payload";
import {
  type CreateWagerTransactionProps,
  WagerTransaction,
  WagerTransactionKind,
} from "../../../src/modules/wagering/domain/transaction/wager-transaction";

export const T0 = new Date("2026-10-13T12:00:00.000Z");
export const brl = (amount: string): Money => Money.from({ amount, currency: "BRL" });

let seq = 0;
export const nextId = (prefix = "id"): string => `${prefix}-${++seq}`;

export function openWallet(balance = "100.00", overrides: { id?: string; playerId?: string; currency?: string } = {}): Wallet {
  return Wallet.open({
    id: overrides.id ?? "wallet-1",
    playerId: overrides.playerId ?? "player-1",
    initialBalance: Money.from({ amount: balance, currency: overrides.currency ?? "BRL" }),
    opening: { transactionId: nextId("opening"), ledgerEntryId: nextId("le"), at: T0 },
  });
}

export function wagerProps(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): CreateWagerTransactionProps {
  const externalTransactionId = overrides.externalTransactionId ?? nextId("ext");
  const providerId = overrides.providerId ?? "provider-a";
  const base = {
    providerId,
    externalTransactionId,
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: brl(amount),
    referenceExternalTransactionId: undefined as string | undefined,
    ...overrides,
  };
  return {
    id: overrides.id ?? nextId("tx"),
    idempotencyKey: overrides.idempotencyKey ?? `${providerId}:${externalTransactionId}`,
    payloadHash: overrides.payloadHash ?? wagerPayloadHash(base),
    createdAt: overrides.createdAt ?? T0,
    ...base,
  };
}

export function wager(
  kind: WagerTransactionKind,
  amount: string,
  overrides: Partial<CreateWagerTransactionProps> = {},
): WagerTransaction {
  return WagerTransaction.create(wagerProps(kind, amount, overrides));
}

export { WagerTransactionKind as Kind };
