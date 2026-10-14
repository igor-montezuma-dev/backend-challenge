import type { Clock } from "../../../shared/application/clock";
import { ConflictError, NotFoundError } from "../../../shared/application/errors";
import type { TransactionScope, UnitOfWork } from "../../../shared/application/unit-of-work.port";
import type { EventContext } from "../../../shared/domain/integration-event";
import type { IdGenerator } from "../../../shared/domain/uuid";
import { InboxMessage } from "../../messaging/domain/inbox-message";
import type { ReferenceRetryPolicy } from "../domain/reference-retry-policy";
import { settleWager } from "../domain/wager-settlement";
import { WagerTransaction } from "../domain/wager-transaction";
import { type ParsedWagerCommand, parseWagerCommand } from "./wager-command";
import { eventsForOutcome } from "./wager-events";

/** De onde veio a operação. HTTP e SQS usam o mesmo caso de uso. */
export interface WagerOrigin {
  correlationId: string;
  causationId?: string;
  /** Presente quando a entrada é a fila: deduplicação pela inbox. */
  inbox?: { consumerName: string; messageId: string; payloadHash: string };
}

export interface WagerResult {
  transaction: WagerTransaction;
  /** A operação já existia: devolvemos o resultado original, sem novo efeito. */
  idempotentReplay: boolean;
}

export class IdempotencyConflictError extends ConflictError {
  constructor(key: string) {
    super("IDEMPOTENCY_KEY_CONFLICT", `idempotency key "${key}" was already used with a different payload`);
  }
}

export class ExternalIdConflictError extends ConflictError {
  constructor(providerId: string, externalId: string) {
    super(
      "EXTERNAL_TRANSACTION_ID_CONFLICT",
      `transaction ${providerId}/${externalId} already exists under a different idempotency key`,
    );
  }
}

export class WalletNotFoundError extends NotFoundError {
  constructor(walletId: string) {
    super("WALLET_NOT_FOUND", `wallet ${walletId} not found`);
  }
}

/**
 * Processa uma operação de aposta, exatamente uma vez em efeito.
 *
 * Tudo acontece numa única transação SQL, com a linha da wallet travada
 * (SELECT ... FOR UPDATE). O lock serializa todas as operações da mesma wallet
 * entre todas as instâncias; wallets diferentes seguem em paralelo.
 *
 *   1. [SQS] inbox já registrada?            → duplicata: replay
 *   2. idempotency key já existe?            → replay (mesmo hash) ou 409
 *   3. trava a wallet                        → 404 se não existir
 *   4. relê a key SOB O LOCK                 → fecha a corrida entre 1-2 e 3
 *   5. id externo usado com outra key?       → 409
 *   6. resolve referência e reversão prévia  (consistentes: mesma wallet travada)
 *   7. settleWager (regras de negócio puras)
 *   8. grava transação, lançamento, saldo, eventos (outbox) e inbox
 *   9. COMMIT — só então o evento existe para o publisher
 *
 * Se duas instâncias concorrem com a mesma key em wallets diferentes (payloads
 * divergentes), a unique constraint dispara e o UnitOfWork repete do zero:
 * no passo 2 a segunda instância encontra a linha da primeira e devolve 409.
 */
export class ProcessWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly retryPolicy: ReferenceRetryPolicy,
  ) {}

  /** `input` é o payload cru do transporte; a validação é feita aqui. */
  async execute(input: unknown, origin: WagerOrigin): Promise<WagerResult> {
    const command = parseWagerCommand(input);

    return this.uow.run(async (scope) => {
      // Mesmo messageId já confirmado: redelivery do SQS. Nada a gravar.
      const seen = origin.inbox
        ? await scope.findInboxMessage(origin.inbox.consumerName, origin.inbox.messageId)
        : undefined;
      if (seen) {
        const original = await scope.findTransactionByIdempotencyKey(command.idempotencyKey);
        if (original) return this.replay(original, command);
      }
      const inbox = seen ? undefined : origin.inbox;

      const existing = await scope.findTransactionByIdempotencyKey(command.idempotencyKey);
      if (existing) return this.replayAndAcknowledge(scope, existing, command, inbox);

      const wallet = await scope.lockWallet(command.walletId);
      if (!wallet) throw new WalletNotFoundError(command.walletId);

      const raced = await scope.findTransactionByIdempotencyKey(command.idempotencyKey);
      if (raced) return this.replayAndAcknowledge(scope, raced, command, inbox);

      if (await scope.findTransactionByExternalId(command.providerId, command.externalTransactionId)) {
        throw new ExternalIdConflictError(command.providerId, command.externalTransactionId);
      }

      const now = this.clock.now();
      const tx = WagerTransaction.create({
        id: this.ids.next(),
        createdAt: now,
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        idempotencyKey: command.idempotencyKey,
        payloadHash: command.payloadHash,
        walletId: command.walletId,
        playerId: command.playerId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: command.money,
        referenceExternalTransactionId: command.referenceExternalTransactionId,
      });

      const reference = tx.hasReference()
        ? await scope.findTransactionByExternalId(tx.providerId, tx.referenceExternalTransactionId!)
        : undefined;
      const referenceAlreadyReversed =
        reference !== undefined && tx.isReversal() ? await scope.hasProcessedReversal(reference.id) : false;

      const outcome = settleWager({
        transaction: tx,
        wallet,
        reference,
        referenceAlreadyReversed,
        ledgerEntryId: this.ids.next(),
        now,
        retryPolicy: this.retryPolicy,
      });

      await scope.insertTransaction(tx);
      if (outcome.kind === "processed" && outcome.entry) {
        await scope.appendLedgerEntry(outcome.entry);
        await scope.saveWallet(wallet);
      }
      if (outcome.kind === "processed") {
        // Quem chegou antes e aguardava esta transação é reavaliado já.
        await scope.expediteTransactionsAwaiting(tx.providerId, tx.externalTransactionId, now);
      }
      await scope.enqueueEvents(eventsForOutcome(outcome, tx, wallet, this.eventContext(origin, now)));
      await this.acknowledge(scope, inbox, now);

      return { transaction: tx, idempotentReplay: false };
    });
  }

  private replay(original: WagerTransaction, command: ParsedWagerCommand): WagerResult {
    if (!original.matchesPayload(command.payloadHash)) {
      throw new IdempotencyConflictError(command.idempotencyKey);
    }
    return { transaction: original, idempotentReplay: true };
  }

  /** Replay vindo de uma mensagem nova (outro messageId): registra a inbox também. */
  private async replayAndAcknowledge(
    scope: TransactionScope,
    original: WagerTransaction,
    command: ParsedWagerCommand,
    inbox: WagerOrigin["inbox"],
  ): Promise<WagerResult> {
    const result = this.replay(original, command);
    await this.acknowledge(scope, inbox, this.clock.now());
    return result;
  }

  /** Registra a mensagem na inbox, na mesma transação do efeito. */
  private async acknowledge(scope: TransactionScope, inbox: WagerOrigin["inbox"], now: Date): Promise<void> {
    if (!inbox) return;
    const message = InboxMessage.receive({ ...inbox, receivedAt: now });
    message.markProcessed(now);
    await scope.recordInboxMessage(message);
  }

  private eventContext(origin: WagerOrigin, now: Date): EventContext {
    return {
      nextEventId: () => this.ids.next(),
      correlationId: origin.correlationId,
      ...(origin.causationId !== undefined ? { causationId: origin.causationId } : {}),
      occurredAt: now,
    };
  }
}
