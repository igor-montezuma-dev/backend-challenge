export enum FailureCode {
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  ReversalWouldOverdraw = "REVERSAL_WOULD_OVERDRAW",

  CurrencyMismatch = "CURRENCY_MISMATCH",
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",

  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  ReferenceMismatch = "REFERENCE_MISMATCH",
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  ReversalAmountMismatch = "REVERSAL_AMOUNT_MISMATCH",
  AlreadyReversed = "ALREADY_REVERSED",

  ProcessingFailed = "PROCESSING_FAILED",
}

export type ProviderAction = "do-not-retry" | "fix-and-resend" | "retry-later";

export interface FailureCodeInfo {
  readonly description: string;
  readonly providerAction: ProviderAction;
}

export const FAILURE_CODES: Readonly<Record<FailureCode, FailureCodeInfo>> = Object.freeze({
  [FailureCode.InsufficientFunds]: {
    description: "BET maior que o saldo disponível",
    providerAction: "do-not-retry",
  },
  [FailureCode.ReversalWouldOverdraw]: {
    description: "ROLLBACK de crédito (WIN/REFUND) deixaria o saldo negativo — exige tratamento operacional",
    providerAction: "do-not-retry",
  },
  [FailureCode.CurrencyMismatch]: {
    description: "moeda da operação difere da moeda da wallet",
    providerAction: "fix-and-resend",
  },
  [FailureCode.WalletPlayerMismatch]: {
    description: "a wallet informada não pertence ao playerId informado",
    providerAction: "fix-and-resend",
  },
  [FailureCode.ReferenceNotFound]: {
    description: "a transação referenciada não chegou dentro do prazo de espera",
    providerAction: "do-not-retry",
  },
  [FailureCode.ReferenceNotProcessed]: {
    description: "a transação referenciada existe, mas foi rejeitada ou falhou",
    providerAction: "do-not-retry",
  },
  [FailureCode.ReferenceMismatch]: {
    description: "a referência pertence a outro player, wallet, moeda ou rodada",
    providerAction: "fix-and-resend",
  },
  [FailureCode.InvalidReferenceKind]: {
    description: "tipo de referência inválido (REFUND só referencia BET; ROLLBACK: BET, WIN ou REFUND; WIN/LOSS: BET)",
    providerAction: "fix-and-resend",
  },
  [FailureCode.ReversalAmountMismatch]: {
    description: "valor da reversão difere do valor da referência (reversão parcial fora de escopo)",
    providerAction: "fix-and-resend",
  },
  [FailureCode.AlreadyReversed]: {
    description: "a referência já foi revertida por um REFUND ou ROLLBACK",
    providerAction: "do-not-retry",
  },
  [FailureCode.ProcessingFailed]: {
    description: "erro permanente de processamento; a operação ficou registrada como FAILED para auditoria",
    providerAction: "do-not-retry",
  },
});
