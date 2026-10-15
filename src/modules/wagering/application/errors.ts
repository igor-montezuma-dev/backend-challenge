import { ConflictError, ForbiddenError, NotFoundError } from "../../../shared/application/errors";

export class WalletNotFoundError extends NotFoundError {
  constructor(walletId: string) {
    super("WALLET_NOT_FOUND", `wallet ${walletId} not found`);
  }
}

export class TransactionNotFoundError extends NotFoundError {
  constructor() {
    super("TRANSACTION_NOT_FOUND", "transaction not found");
  }
}

export class WalletAlreadyExistsError extends ConflictError {
  constructor() {
    super("WALLET_ALREADY_EXISTS", "a wallet already exists for this player and currency");
  }
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

export class ProviderMismatchError extends ForbiddenError {
  constructor(authenticated: string, requested: string) {
    super("PROVIDER_MISMATCH", `authenticated provider "${authenticated}" cannot act as provider "${requested}"`);
  }
}
