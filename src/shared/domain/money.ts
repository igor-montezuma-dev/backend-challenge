import { DomainError, ValidationError } from "./domain-error";

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

export class Money {
  static readonly SCALE = 2;
  private static readonly FACTOR = 100n;

  static readonly MAX_MINOR_UNITS = 10n ** 19n - 1n;

  private static readonly AMOUNT_PATTERN = /^(0|[1-9]\d{0,16})(?:\.(\d{1,2}))?$/;
  private static readonly CURRENCY_PATTERN = /^[A-Z]{3}$/;

  private constructor(
    private readonly minorUnits: bigint,
    readonly currency: string,
  ) {}

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
