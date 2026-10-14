/**
 * Erros da camada de aplicação. Cada classe corresponde a uma categoria que a
 * API e o consumidor SQS tratam de forma distinta (seção 9: o provedor precisa
 * saber, sem ler mensagem, se pode reenviar).
 */
export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Recurso inexistente (wallet ou transação). */
export class NotFoundError extends ApplicationError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Conflito de estado: idempotência divergente, wallet duplicada. */
export class ConflictError extends ApplicationError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Falha transitória de infraestrutura (banco fora, lock timeout, conexão
 * perdida). Nada foi confirmado: reenviar a mesma operação é seguro.
 */
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
