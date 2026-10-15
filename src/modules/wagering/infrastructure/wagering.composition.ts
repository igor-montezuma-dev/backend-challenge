import type { MikroORM } from "@mikro-orm/postgresql";
import type { Clock } from "../../../shared/application/clock";
import type { IdGenerator } from "../../../shared/application/id-generator";
import {
  MikroOrmUnitOfWork,
  type UnitOfWorkObserver,
} from "../../../shared/infrastructure/database/mikro-orm-unit-of-work";
import { MikroOrmInboxRepository } from "../../messaging/infrastructure/persistence/mikro-orm-inbox.repository";
import { MikroOrmOutboxRepository } from "../../messaging/infrastructure/persistence/mikro-orm-outbox.repository";
import { WalletAlreadyExistsError } from "../application/errors";
import type { WageringRepositories, WageringUnitOfWork } from "../application/ports/wagering-repositories";
import { ReferenceResolver } from "../application/services/reference-resolver";
import { SettlementRecorder } from "../application/services/settlement-recorder";
import { OpenWallet } from "../application/use-cases/open-wallet.use-case";
import {
  ProcessWagerTransaction,
  type WagerProcessingObserver,
} from "../application/use-cases/process-wager-transaction.use-case";
import { type ReconciliationObserver, ReconcileWallet } from "../application/use-cases/reconcile-wallet.use-case";
import { SettlePendingReference } from "../application/use-cases/settle-pending-reference.use-case";
import { WagerSettlementService } from "../domain/settlement/wager-settlement.service";
import type { ReferenceRetryPolicy } from "../domain/transaction/reference-retry-policy";
import { MikroOrmTransactionReadModel } from "./persistence/mikro-orm-transaction.read-model";
import { MikroOrmWagerTransactionRepository } from "./persistence/mikro-orm-wager-transaction.repository";
import { MikroOrmWalletReadModel } from "./persistence/mikro-orm-wallet.read-model";
import { MikroOrmWalletRepository } from "./persistence/mikro-orm-wallet.repository";

export interface WageringSettings {
  lockTimeoutMs: number;
  maxTransactionAttempts: number;
  referenceRetryPolicy: ReferenceRetryPolicy;
}

export interface WageringDependencies {
  orm: MikroORM;
  ids: IdGenerator;
  clock: Clock;
  settings: WageringSettings;
  reconciliationObserver: ReconciliationObserver;
  unitOfWorkObserver?: UnitOfWorkObserver;
  wagerObserver?: WagerProcessingObserver;
  decorateUnitOfWork?: (unitOfWork: WageringUnitOfWork) => WageringUnitOfWork;
}

export interface WageringApplication {
  openWallet: OpenWallet;
  processWager: ProcessWagerTransaction;
  settlePendingReference: SettlePendingReference;
  reconcileWallet: ReconcileWallet;
  walletReadModel: MikroOrmWalletReadModel;
  transactionReadModel: MikroOrmTransactionReadModel;
}

const UNIQUE_CONSTRAINTS_RACED_BY_CONCURRENT_WRITERS = new Set([
  "uq_wager_tx_idempotency_key",
  "uq_wager_tx_provider_external",
  "pk_inbox_messages",
]);

export function createWageringUnitOfWork(deps: WageringDependencies): WageringUnitOfWork {
  const unitOfWork = new MikroOrmUnitOfWork<WageringRepositories>(
    deps.orm,
    (em) => ({
      wallets: new MikroOrmWalletRepository(em),
      transactions: new MikroOrmWagerTransactionRepository(em),
      inbox: new MikroOrmInboxRepository(em),
      outbox: new MikroOrmOutboxRepository(em),
    }),
    {
      lockTimeoutMs: deps.settings.lockTimeoutMs,
      maxAttempts: deps.settings.maxTransactionAttempts,
      retryOnUniqueViolationOf: UNIQUE_CONSTRAINTS_RACED_BY_CONCURRENT_WRITERS,
      translateUniqueViolation: { uq_wallets_player_currency: () => new WalletAlreadyExistsError() },
    },
    deps.unitOfWorkObserver,
  );
  return deps.decorateUnitOfWork ? deps.decorateUnitOfWork(unitOfWork) : unitOfWork;
}

export function composeWagering(deps: WageringDependencies): WageringApplication {
  const unitOfWork = createWageringUnitOfWork(deps);
  const settlement = new WagerSettlementService(deps.settings.referenceRetryPolicy);
  const references = new ReferenceResolver();
  const recorder = new SettlementRecorder();
  const walletReadModel = new MikroOrmWalletReadModel(deps.orm);

  return {
    openWallet: new OpenWallet(unitOfWork, deps.ids, deps.clock),
    processWager: new ProcessWagerTransaction(
      unitOfWork,
      settlement,
      references,
      recorder,
      deps.ids,
      deps.clock,
      deps.wagerObserver,
    ),
    settlePendingReference: new SettlePendingReference(
      unitOfWork,
      settlement,
      references,
      recorder,
      deps.settings.referenceRetryPolicy,
      deps.ids,
      deps.clock,
    ),
    reconcileWallet: new ReconcileWallet(walletReadModel, deps.clock, deps.reconciliationObserver),
    walletReadModel,
    transactionReadModel: new MikroOrmTransactionReadModel(deps.orm),
  };
}
