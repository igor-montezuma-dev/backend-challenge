import type { Clock } from "../../../../shared/application/clock";
import { type Correlation, createEventContext } from "../../../../shared/application/event-context";
import type { IdGenerator } from "../../../../shared/application/id-generator";
import { InboxMessage } from "../../../messaging/domain/inbox-message";
import type { WagerSettlementService } from "../../domain/settlement/wager-settlement.service";
import { WagerTransaction } from "../../domain/transaction/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import { type SubmitWagerCommand, parseSubmitWagerCommand } from "../commands/submit-wager.command";
import { ExternalIdConflictError, IdempotencyConflictError, ProviderMismatchError, WalletNotFoundError } from "../errors";
import type { WageringRepositories, WageringUnitOfWork } from "../ports/wagering-repositories";
import type { ReferenceResolver } from "../services/reference-resolver";
import type { SettlementRecorder } from "../services/settlement-recorder";

export interface InboxDelivery {
  consumerName: string;
  messageId: string;
  payloadHash: string;
}

export interface WagerOrigin extends Correlation {
  inbox?: InboxDelivery;
  actingProviderId?: string;
}

export interface WagerResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

export type WagerChannel = "http" | "queue";

export interface WagerProcessingObserver {
  onCompleted(result: WagerResult, channel: WagerChannel, durationMs: number): void;
  onFailed(error: unknown, channel: WagerChannel, durationMs: number): void;
}

const SILENT: WagerProcessingObserver = { onCompleted: () => {}, onFailed: () => {} };

export class ProcessWagerTransaction {
  constructor(
    private readonly unitOfWork: WageringUnitOfWork,
    private readonly settlement: WagerSettlementService,
    private readonly references: ReferenceResolver,
    private readonly recorder: SettlementRecorder,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly observer: WagerProcessingObserver = SILENT,
  ) {}

  async execute(input: unknown, origin: WagerOrigin): Promise<WagerResult> {
    const channel: WagerChannel = origin.inbox ? "queue" : "http";
    const startedAt = performance.now();
    try {
      const result = await this.process(input, origin);
      this.observer.onCompleted(result, channel, performance.now() - startedAt);
      return result;
    } catch (error) {
      this.observer.onFailed(error, channel, performance.now() - startedAt);
      throw error;
    }
  }

  private async process(input: unknown, origin: WagerOrigin): Promise<WagerResult> {
    const command = parseSubmitWagerCommand(input);
    if (origin.actingProviderId !== undefined && origin.actingProviderId !== command.providerId) {
      throw new ProviderMismatchError(origin.actingProviderId, command.providerId);
    }

    return this.unitOfWork.run(async (repositories) => {
      const delivery = await this.unseenDelivery(repositories, origin);

      const existing = await repositories.transactions.findByIdempotencyKey(command.idempotencyKey);
      if (existing) return this.replay(repositories, existing, command, delivery);

      const wallet = await repositories.wallets.lockById(command.walletId);
      if (!wallet) throw new WalletNotFoundError(command.walletId);

      const racedWhileWaitingForLock = await repositories.transactions.findByIdempotencyKey(command.idempotencyKey);
      if (racedWhileWaitingForLock) return this.replay(repositories, racedWhileWaitingForLock, command, delivery);

      await this.assertExternalIdIsAvailable(repositories, command);
      return this.settleNewTransaction(repositories, command, wallet, origin, delivery);
    });
  }

  private async settleNewTransaction(
    repositories: WageringRepositories,
    command: SubmitWagerCommand,
    wallet: Wallet,
    origin: WagerOrigin,
    delivery: InboxDelivery | undefined,
  ): Promise<WagerResult> {
    const now = this.clock.now();
    const transaction = WagerTransaction.create({ ...command, id: this.ids.next(), createdAt: now });
    const references = await this.references.resolve(repositories.transactions, transaction);
    const outcome = this.settlement.settle({ transaction, wallet, ...references, ledgerEntryId: this.ids.next(), now });

    await this.recorder.record(repositories, {
      transaction,
      wallet,
      outcome,
      isNewTransaction: true,
      events: createEventContext(this.ids, origin, now),
    });
    await this.acknowledge(repositories, delivery, now);
    return { transaction, idempotentReplay: false };
  }

  private async replay(
    repositories: WageringRepositories,
    original: WagerTransaction,
    command: SubmitWagerCommand,
    delivery: InboxDelivery | undefined,
  ): Promise<WagerResult> {
    if (!original.matchesPayload(command.payloadHash)) throw new IdempotencyConflictError(command.idempotencyKey);
    await this.acknowledge(repositories, delivery, this.clock.now());
    return { transaction: original, idempotentReplay: true };
  }

  private async assertExternalIdIsAvailable(repositories: WageringRepositories, command: SubmitWagerCommand): Promise<void> {
    const taken = await repositories.transactions.findByExternalId(command.providerId, command.externalTransactionId);
    if (taken) throw new ExternalIdConflictError(command.providerId, command.externalTransactionId);
  }

  private async unseenDelivery(repositories: WageringRepositories, origin: WagerOrigin): Promise<InboxDelivery | undefined> {
    if (!origin.inbox) return undefined;
    const seen = await repositories.inbox.find(origin.inbox.consumerName, origin.inbox.messageId);
    return seen ? undefined : origin.inbox;
  }

  private async acknowledge(
    repositories: WageringRepositories,
    delivery: InboxDelivery | undefined,
    at: Date,
  ): Promise<void> {
    if (!delivery) return;
    const message = InboxMessage.receive({ ...delivery, receivedAt: at });
    message.markProcessed(at);
    await repositories.inbox.add(message);
  }
}
