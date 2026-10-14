import { DomainError, ValidationError } from "./domain-error";

/** Contrato de entrada/saída: { "amount": "25.00", "currency": "BRL" } */
export interface MoneyProps {
  amount: string;
  currency: string;
}

export class InvalidMoneyError extends ValidationError {
  constructor(message: string) {
    super(message, "money");
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = "CURRENCY_MISMATCH";

  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`currency mismatch: expected ${expected}, got ${actual}`);
  }
}

/**
 * Valor monetário exato e imutável.
 *
 * Representação: inteiro de unidades mínimas (centavos) em `bigint`. O desafio
 * fixa a escala em 2 casas e rejeita entradas com mais casas, então nenhuma
 * operação produz fração de centavo e não existe arredondamento — soma e
 * subtração de inteiros são exatas. `number` nunca participa: o tipo `bigint`
 * não se mistura com `number` sem conversão explícita (2500n + 1 é erro).
 *
 * Simplificação documentada: todas as moedas usam escala 2. Moedas com outra
 * escala (JPY = 0, BHD = 3) exigiriam uma tabela de escalas por moeda.
 */
export class Money {
  static readonly SCALE = 2;
  private static readonly FACTOR = 100n;

  /**
   * Limite de numeric(19,2): 17 dígitos inteiros + 2 decimais. Qualquer valor
   * fora disso não seria persistível; rejeitamos no domínio, não no banco.
   */
  static readonly MAX_MINOR_UNITS = 10n ** 19n - 1n;

  /** Sem sinal, sem notação científica, sem zeros à esquerda, até 2 casas. */
  private static readonly AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})(?:\.(\d{1,2}))?$/;
  private static readonly CURRENCY_PATTERN = /^[A-Z]{3}$/;

  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {}

  /**
   * Parse do contrato de entrada. Rejeita: tipos não-string, string vazia,
   * NaN, Infinity, notação científica, sinal (+/-), espaços, zeros à esquerda,
   * mais de 2 casas decimais e valores acima do limite de numeric(19,2).
   * Aceita "25", "25.5" e "25.50", e sempre serializa com 2 casas.
   */
  static from(props: MoneyProps): Money {
    if (props === null || typeof props !== "object") {
      throw new InvalidMoneyError("money must be an object { amount, currency }");
    }
    const currency = Money.parseCurrency(props.currency);
    const { amount } = props;
    if (typeof amount !== "string") {
      throw new InvalidMoneyError("amount must be a decimal string, e.g. \"25.00\"");
    }
    const match = Money.AMOUNT_PATTERN.exec(amount);
    if (!match) {
      throw new InvalidMoneyError(
        `invalid amount "${amount}": expected a non-negative decimal with at most 2 decimal places`,
      );
    }
    const integerPart = match[1] ?? "0";
    const fractionPart = (match[2] ?? "").padEnd(Money.SCALE, "0");
    return new Money(BigInt(integerPart + fractionPart), currency);
  }

  static zero(currency: string): Money {
    return new Money(0n, Money.parseCurrency(currency));
  }

  /** Construção a partir de unidades mínimas (uso interno e testes). */
  static ofMinorUnits(minorUnits: bigint, currency: string): Money {
    return Money.checked(minorUnits, Money.parseCurrency(currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.checked(this.minorUnits + other.minorUnits, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.checked(this.minorUnits - other.minorUnits, this.currency);
  }

  negate(): Money {
    return new Money(-this.minorUnits, this.currency);
  }

  isZero(): boolean {
    return this.minorUnits === 0n;
  }

  isPositive(): boolean {
    return this.minorUnits > 0n;
  }

  isNegative(): boolean {
    return this.minorUnits < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.minorUnits < other.minorUnits;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.minorUnits === other.minorUnits;
  }

  hasCurrency(currency: string): boolean {
    return this.currency === currency;
  }

  /** "25.00", "-0.05", "1000.00" — sempre 2 casas, sem notação científica. */
  get amount(): string {
    const negative = this.minorUnits < 0n;
    const abs = negative ? -this.minorUnits : this.minorUnits;
    const integer = abs / Money.FACTOR;
    const fraction = (abs % Money.FACTOR).toString().padStart(Money.SCALE, "0");
    return `${negative ? "-" : ""}${integer}.${fraction}`;
  }

  toJSON(): MoneyProps {
    return { amount: this.amount, currency: this.currency };
  }

  toString(): string {
    return `${this.amount} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (other.currency !== this.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }

  private static checked(minorUnits: bigint, currency: string): Money {
    const abs = minorUnits < 0n ? -minorUnits : minorUnits;
    if (abs > Money.MAX_MINOR_UNITS) {
      throw new InvalidMoneyError("amount exceeds the supported range of numeric(19,2)");
    }
    return new Money(minorUnits, currency);
  }

  private static parseCurrency(currency: unknown): string {
    if (typeof currency !== "string" || !Money.CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`invalid currency "${String(currency)}": expected ISO-4217 code, e.g. "BRL"`);
    }
    return currency;
  }
}
