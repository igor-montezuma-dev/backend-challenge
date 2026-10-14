import type { Clock } from "../../../shared/application/clock";
import type { UnitOfWork } from "../../../shared/application/unit-of-work.port";
import { ValidationError } from "../../../shared/domain/domain-error";
import { Money, type MoneyProps } from "../../../shared/domain/money";
import type { IdGenerator } from "../../../shared/domain/uuid";
import { WalletBalanceChanged } from "../../wagering/domain/events";
import { sha256Hex } from "../../wagering/domain/payload-hash";
import { WagerTransaction } from "../../wagering/domain/wager-transaction";
import { Wallet } from "../domain/wallet";

export interface OpenWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
}

/** providerId reservado para transações internas (nunca aceito na API). */
export const INTERNAL_PROVIDER_ID = "internal";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Abre a wallet. Saldo inicial > 0 gera, na MESMA transação SQL:
 *   wallet (v1) + transação OPENING (PROCESSED) + lançamento CREDIT + evento.
 * Wallet duplicada (player + moeda) → ConflictError WALLET_ALREADY_EXISTS,
 * garantido pela unique constraint, não por uma checagem prévia.
 */
export class OpenWallet {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  async execute(input: unknown, correlationId: string): Promise<Wallet> {
    const command = parse(input);

    return this.uow.run(async (scope) => {
      const now = this.clock.now();
      const walletId = this.ids.next();
      const openingTxId = this.ids.next();
      const { wallet, openingEntry } = Wallet.open({
        id: walletId,
        playerId: command.playerId,
        initialBalance: command.initialBalance,
        opening: { transactionId: openingTxId, ledgerEntryId: this.ids.next(), at: now },
      });

      await scope.insertWallet(wallet);

      if (openingEntry) {
        const externalId = `opening:${walletId}`;
        const opening = WagerTransaction.opening({
          id: openingTxId,
          providerId: INTERNAL_PROVIDER_ID,
          externalTransactionId: externalId,
          idempotencyKey: `${INTERNAL_PROVIDER_ID}:${externalId}`,
          payloadHash: sha256Hex(JSON.stringify({ walletId, initialBalance: command.initialBalance.toJSON() })),
          walletId,
          playerId: command.playerId,
          roundId: "opening",
          gameId: "internal",
          money: command.initialBalance,
          createdAt: now,
        });
        await scope.insertTransaction(opening);
        await scope.appendLedgerEntry(openingEntry);
        await scope.enqueueEvents([
          WalletBalanceChanged.from(wallet, openingEntry, {
            nextEventId: () => this.ids.next(),
            correlationId,
            occurredAt: now,
          }),
        ]);
      }
      return wallet;
    });
  }
}

function parse(input: unknown): { playerId: string; initialBalance: Money } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("payload must be a JSON object");
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.playerId !== "string" || !UUID.test(raw.playerId)) {
    throw new ValidationError("playerId must be a UUID", "playerId");
  }
  return {
    playerId: raw.playerId.toLowerCase(),
    initialBalance: Money.from(raw.initialBalance as MoneyProps),
  };
}
