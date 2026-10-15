import { Guard } from "../../../../shared/domain/guard";
import { Money, type MoneyProps } from "../../../../shared/domain/money";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: Money;
}

export function parseOpenWalletCommand(input: unknown): OpenWalletCommand {
  const raw = Guard.object(input);
  return {
    playerId: Guard.uuid(raw.playerId, "playerId"),
    initialBalance: Money.from(raw.initialBalance as MoneyProps),
  };
}
