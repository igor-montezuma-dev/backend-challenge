export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class NotFoundError extends ApplicationError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class ConflictError extends ApplicationError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class TransientInfrastructureError extends ApplicationError {
  readonly code = "TRANSIENT_INFRASTRUCTURE_ERROR";

  constructor(
    message: string,
    readonly retryAfterSeconds = 1,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export class ForbiddenError extends ApplicationError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
