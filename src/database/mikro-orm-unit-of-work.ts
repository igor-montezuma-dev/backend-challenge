import { type EntityManager, LockMode, MikroORM } from "@mikro-orm/postgresql";
import type { IntegrationEvent } from "../shared/domain/integration-event";
import { ConflictError, TransientInfrastructureError } from "../shared/application/errors";
import type { TransactionScope, UnitOfWork } from "../shared/application/unit-of-work.port";
import type { InboxMessage } from "../modules/messaging/domain/inbox-message";
import { OutboxMessage } from "../modules/messaging/domain/outbox-message";
import {
  type WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../modules/wagering/domain/wager-transaction";
import type { Wallet } from "../modules/wallets/domain/wallet";
import type { WalletLedgerEntry } from "../modules/wallets/domain/wallet-ledger-entry";
import { isTransientDatabaseError, uniqueViolationConstraint } from "./database-errors";
import {
  applyTransactionState,
  inboxToDomain,
  inboxToRecord,
  ledgerEntryToRecord,
  outboxToRecord,
  transactionToDomain,
  transactionToRecord,
  walletToDomain,
  walletToRecord,
} from "./mappers";
import { InboxRecord, WagerTransactionRecord, WalletRecord } from "./records";

export interface UnitOfWorkOptions {
  /** Tempo máximo esperando o lock de uma wallet antes de desistir (503). */
  lockTimeoutMs: number;
  /** Re-execuções após corrida em unicidade, deadlock ou serialização. */
  maxAttempts: number;
}

export const DEFAULT_UNIT_OF_WORK_OPTIONS: UnitOfWorkOptions = { lockTimeoutMs: 5_000, maxAttempts: 4 };

/**
 * Unicidades que podem colidir por CORRIDA entre instâncias: a outra
 * instância inseriu a mesma chave entre a nossa leitura e a nossa escrita.
 * Repetir o trabalho do zero resolve — a nova leitura enxerga a linha
 * confirmada e o caso de uso devolve replay ou conflito.
 */
const RACE_CONSTRAINTS = new Set([
  "uq_wager_tx_idempotency_key",
  "uq_wager_tx_provider_external",
  "pk_inbox_messages",
]);

/** Unicidades que significam conflito de negócio — repetir não muda nada. */
const CONFLICT_CONSTRAINTS: Record<string, { code: string; message: string }> = {
  uq_wallets_player_currency: {
    code: "WALLET_ALREADY_EXISTS",
    message: "a wallet already exists for this player and currency",
  },
};

export interface UnitOfWorkObserver {
  onRetry?(reason: "unique_race" | "transient", attempt: number, error: unknown): void;
}

export class MikroOrmUnitOfWork implements UnitOfWork {
  constructor(
    private readonly orm: MikroORM,
    private readonly options: UnitOfWorkOptions = DEFAULT_UNIT_OF_WORK_OPTIONS,
    private readonly observer: UnitOfWorkObserver = {},
  ) {}

  async run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      // Fork novo a cada tentativa: identity map limpo, nada de estado da
      // tentativa anterior vaza para a próxima.
      const em = this.orm.em.fork({ clear: true });
      try {
        return await em.transactional(async (txEm) => {
          // SET LOCAL vale só para esta transação.
          await txEm.execute(`SET LOCAL lock_timeout = '${Math.floor(this.options.lockTimeoutMs)}ms'`);
          return work(new MikroOrmTransactionScope(txEm));
        });
      } catch (error) {
        const constraint = uniqueViolationConstraint(error);
        if (constraint && CONFLICT_CONSTRAINTS[constraint]) {
          const c = CONFLICT_CONSTRAINTS[constraint];
          throw new ConflictError(c.code, c.message);
        }
        const canRetry = attempt < this.options.maxAttempts;
        if (constraint && RACE_CONSTRAINTS.has(constraint) && canRetry) {
          this.observer.onRetry?.("unique_race", attempt, error);
          continue;
        }
        if (isTransientDatabaseError(error)) {
          if (canRetry) {
            this.observer.onRetry?.("transient", attempt, error);
            await sleep(25 * 2 ** attempt);
            continue;
          }
          throw new TransientInfrastructureError("database temporarily unavailable", 1, error);
        }
        throw error;
      }
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REVERSAL_KINDS = [WagerTransactionKind.Refund, WagerTransactionKind.Rollback];

/**
 * Implementação do escopo transacional. Cada escrita faz flush imediato: as
 * FKs são imediatas (wallet → transação → lançamento), então a ordem dos
 * INSERTs importa e fica explícita aqui, sem depender da ordenação do UoW.
 */
class MikroOrmTransactionScope implements TransactionScope {
  constructor(private readonly em: EntityManager) {}

  // --- wallets ----------------------------------------------------------------

  async lockWallet(walletId: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id: walletId },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? walletToDomain(record) : undefined;
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    this.em.persist(walletToRecord(wallet));
    await this.em.flush();
  }

  async saveWallet(wallet: Wallet): Promise<void> {
    // A wallet foi carregada por lockWallet: o registro está no identity map
    // e o flush gera UPDATE só das colunas alteradas (balance, version, updated_at).
    const record = this.em.getUnitOfWork().getById<WalletRecord>(WalletRecord.name, wallet.id);
    if (!record) {
      throw new Error(`wallet ${wallet.id} must be locked (lockWallet) before being saved`);
    }
    walletToRecord(wallet, record);
    await this.em.flush();
  }

  // --- transações -------------------------------------------------------------

  async findTransactionByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, { idempotencyKey });
    return r ? transactionToDomain(r) : undefined;
  }

  async findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return r ? transactionToDomain(r) : undefined;
  }

  async findTransactionById(id: string): Promise<WagerTransaction | undefined> {
    const r = await this.em.findOne(WagerTransactionRecord, { id }, { refresh: true });
    return r ? transactionToDomain(r) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      kind: { $in: REVERSAL_KINDS },
      status: WagerTransactionStatus.Processed,
    });
    return count > 0;
  }

  async insertTransaction(tx: WagerTransaction): Promise<void> {
    this.em.persist(transactionToRecord(tx));
    await this.em.flush();
  }

  async updateTransaction(tx: WagerTransaction): Promise<void> {
    const record =
      this.em.getUnitOfWork().getById<WagerTransactionRecord>(WagerTransactionRecord.name, tx.id) ??
      (await this.em.findOneOrFail(WagerTransactionRecord, { id: tx.id }));
    applyTransactionState(tx, record);
    await this.em.flush();
  }

  async expediteTransactionsAwaiting(providerId: string, externalTransactionId: string, at: Date): Promise<number> {
    return this.em.nativeUpdate(
      WagerTransactionRecord,
      {
        providerId,
        referenceExternalTransactionId: externalTransactionId,
        status: WagerTransactionStatus.PendingReference,
        nextReferenceCheckAt: { $gt: at },
      },
      { nextReferenceCheckAt: at },
    );
  }

  // --- ledger -----------------------------------------------------------------

  async appendLedgerEntry(entry: WalletLedgerEntry): Promise<void> {
    this.em.persist(ledgerEntryToRecord(entry));
    await this.em.flush();
  }

  // --- inbox / outbox -----------------------------------------------------------

  async findInboxMessage(consumerName: string, messageId: string): Promise<InboxMessage | undefined> {
    const r = await this.em.findOne(InboxRecord, { consumerName, messageId });
    return r ? inboxToDomain(r) : undefined;
  }

  async recordInboxMessage(message: InboxMessage): Promise<void> {
    this.em.persist(inboxToRecord(message));
    await this.em.flush();
  }

  async enqueueEvents(events: readonly IntegrationEvent<unknown>[]): Promise<void> {
    if (events.length === 0) return;
    for (const event of events) this.em.persist(outboxToRecord(OutboxMessage.enqueue(event)));
    await this.em.flush();
  }
}
