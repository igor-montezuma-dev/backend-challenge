/**
 * Base dos erros de domínio. `code` é estável e legível por máquina; a camada
 * de apresentação mapeia o código para HTTP, nunca a mensagem.
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Entrada que viola o contrato (formato, faixa, campos obrigatórios). */
export class ValidationError extends DomainError {
  readonly code = "VALIDATION_ERROR";

  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

/**
 * Tentativa de transição a partir de um estado terminal. É erro de programação,
 * não caminho de negócio: se acontecer, há bug no fluxo.
 */
export class InvalidStateTransitionError extends DomainError {
  readonly code = "INVALID_STATE_TRANSITION";

  constructor(message: string) {
    super(message);
  }
}
