export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends DomainError {
  readonly code = "VALIDATION_ERROR";

  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

export class InvalidStateTransitionError extends DomainError {
  readonly code = "INVALID_STATE_TRANSITION";

  constructor(message: string) {
    super(message);
  }
}
