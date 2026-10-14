import type { IntegrationEvent } from "../domain/integration-event";
import type { InboxMessage } from "../../modules/messaging/domain/inbox-message";
import type { WagerTransaction } from "../../modules/wagering/domain/wager-transaction";
import type { Wallet } from "../../modules/wallets/domain/wallet";
import type { WalletLedgerEntry } from "../../modules/wallets/domain/wallet-ledger-entry";

/**
 * Operações disponíveis DENTRO de uma transação SQL. Tudo o que é gravado por
 * um mesmo `work` é confirmado junto (wallet, transação, ledger, inbox, outbox)
 * ou descartado junto.
 */
export interface TransactionScope {
  // --- wallets
  /**
   * SELECT ... FOR UPDATE. Serializa todas as operações da MESMA wallet entre
   * todas as instâncias; wallets diferentes não se bloqueiam.
   */
  lockWallet(walletId: string): Promise<Wallet | undefined>;
  insertWallet(wallet: Wallet): Promise<void>;
  /** Grava saldo e version; exige que a wallet tenha sido travada antes. */
  saveWallet(wallet: Wallet): Promise<void>;

  // --- transações
  findTransactionByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | undefined>;
  findTransactionByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  findTransactionById(id: string): Promise<WagerTransaction | undefined>;
  /** Já existe REFUND/ROLLBACK PROCESSED para esta referência? */
  hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  insertTransaction(tx: WagerTransaction): Promise<void>;
  updateTransaction(tx: WagerTransaction): Promise<void>;
  /**
   * Antecipa a próxima checagem das transações que aguardavam esta referência
   * (o worker as reprocessa assim que possível, sem esperar o backoff).
   */
  expediteTransactionsAwaiting(providerId: string, externalTransactionId: string, at: Date): Promise<number>;

  // --- ledger
  appendLedgerEntry(entry: WalletLedgerEntry): Promise<void>;

  // --- inbox / outbox
  findInboxMessage(consumerName: string, messageId: string): Promise<InboxMessage | undefined>;
  recordInboxMessage(message: InboxMessage): Promise<void>;
  enqueueEvents(events: readonly IntegrationEvent<unknown>[]): Promise<void>;
}

export interface UnitOfWork {
  /**
   * Executa `work` numa transação SQL. Se o banco recusar por violação de
   * unicidade concorrente (duas instâncias inserindo a mesma chave ao mesmo
   * tempo), a transação é desfeita e `work` roda de novo do zero — na nova
   * execução, a leitura enxerga a linha que a outra instância confirmou.
   */
  run<T>(work: (scope: TransactionScope) => Promise<T>): Promise<T>;
}

export const UNIT_OF_WORK = Symbol("UNIT_OF_WORK");
