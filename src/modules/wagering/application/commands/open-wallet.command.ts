import { Guard } from "../../../../shared/domain/guard";
import { Money, type MoneyProps } from "../../../../shared/domain/money";

const OPEN_WALLET_FIELDS = ["playerId", "initialBalance"] as const;

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
}

export function parseOpenWalletCommand(input: unknown): OpenWalletCommand {
  const raw = Guard.knownFields(Guard.object(input), OPEN_WALLET_FIELDS);
  return {
    playerId: Guard.uuid(raw.playerId, "playerId"),
    initialBalance: Money.from(raw.initialBalance as MoneyProps),
  };
}
