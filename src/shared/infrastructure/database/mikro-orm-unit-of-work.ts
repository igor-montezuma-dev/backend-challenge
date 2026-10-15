import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { TransientInfrastructureError } from "../../application/errors";
import type { UnitOfWork } from "../../application/unit-of-work.port";
import { isTransientDatabaseError, uniqueViolationConstraint } from "./database-errors";

export interface UnitOfWorkPolicy {
  lockTimeoutMs: number;
  maxAttempts: number;
  retryOnUniqueViolationOf: ReadonlySet<string>;
  translateUniqueViolation: Readonly<Record<string, () => Error>>;
}

export type UnitOfWorkRetryReason = "unique_race" | "transient";

export interface UnitOfWorkObserver {
  onRetry(reason: UnitOfWorkRetryReason, attempt: number, error: unknown): void;
  onGiveUp(error: unknown, attempts: number): void;
}

const NO_OBSERVER: UnitOfWorkObserver = { onRetry: () => {}, onGiveUp: () => {} };
const BACKOFF_BASE_MS = 25;

export class MikroOrmUnitOfWork<Repositories> implements UnitOfWork<Repositories> {
  constructor(
    private readonly orm: MikroORM,
    private readonly repositoriesFor: (em: EntityManager) => Repositories,
    private readonly policy: UnitOfWorkPolicy,
    private readonly observer: UnitOfWorkObserver = NO_OBSERVER,
  ) {}

  async run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.runOnce(work);
      } catch (error) {
        const retry = this.decide(error, attempt);
        if (retry === "rethrow") {
          if (isTransientDatabaseError(error)) this.observer.onGiveUp(error, attempt);
          throw this.translate(error);
        }
        this.observer.onRetry(retry, attempt, error);
        if (retry === "transient") await sleep(BACKOFF_BASE_MS * 2 ** attempt);
      }
    }
  }

  private runOnce<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
    return this.orm.em.fork({ clear: true }).transactional(async (em) => {
      await em.execute(`SET LOCAL lock_timeout = '${Math.floor(this.policy.lockTimeoutMs)}ms'`);
      return work(this.repositoriesFor(em));
    });
  }

  private decide(error: unknown, attempt: number): UnitOfWorkRetryReason | "rethrow" {
    if (attempt >= this.policy.maxAttempts) return "rethrow";
    const constraint = uniqueViolationConstraint(error);
    if (constraint !== undefined && this.policy.retryOnUniqueViolationOf.has(constraint)) return "unique_race";
    if (isTransientDatabaseError(error)) return "transient";
    return "rethrow";
  }

  private translate(error: unknown): unknown {
    const constraint = uniqueViolationConstraint(error);
    const translator = constraint !== undefined ? this.policy.translateUniqueViolation[constraint] : undefined;
    if (translator) return translator();
    if (isTransientDatabaseError(error)) {
      return new TransientInfrastructureError("database temporarily unavailable", 1, error);
    }
    return error;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
