import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError, Money } from "../../src/shared/domain/money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from — entradas válidas e escala fixa", () => {
  test.each([
    ["25.00", "25.00"],
    ["25.5", "25.50"],
    ["25", "25.00"],
    ["0", "0.00"],
    ["0.01", "0.01"],
    ["0.10", "0.10"],
    ["99999999999999999.99", "99999999999999999.99"],
  ])("%p → %p", (input, expected) => {
    expect(brl(input).amount).toBe(expected);
  });

  test("serializa no formato do contrato", () => {
    expect(brl("25").toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(JSON.stringify({ m: brl("1.5") })).toBe('{"m":{"amount":"1.50","currency":"BRL"}}');
    expect(brl("1.5").toString()).toBe("1.50 BRL");
  });
});

describe("Money.from — entradas inválidas", () => {
  test.each([
    ["string vazia", ""],
    ["NaN", "NaN"],
    ["Infinity", "Infinity"],
    ["-Infinity", "-Infinity"],
    ["notação científica", "1e3"],
    ["notação científica com ponto", "2.5E1"],
    ["mais de 2 casas", "10.001"],
    ["mais de 2 casas com zeros", "10.000"],
    ["negativo", "-1.00"],
    ["sinal positivo", "+1.00"],
    ["zero à esquerda", "01.00"],
    ["ponto sem decimais", "1."],
    ["ponto sem inteiro", ".50"],
    ["vírgula decimal", "1,50"],
    ["espaços", " 1.00 "],
    ["separador de milhar", "1_000.00"],
    ["hexadecimal", "0x10"],
    ["acima de numeric(19,2)", "100000000000000000.00"],
  ])("%s (%p)", (_label, amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test.each([
    ["number", 25],
    ["null", null],
    ["undefined", undefined],
    ["float", 0.1],
  ])("amount do tipo %s é rejeitado", (_label, amount) => {
    expect(() => Money.from({ amount: amount as unknown as string, currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test.each(["brl", "BR", "BRLL", "", "R$"])("moeda inválida %p", (currency) => {
    expect(() => Money.from({ amount: "1.00", currency })).toThrow(InvalidMoneyError);
  });
});

describe("Money — aritmética exata", () => {
  test("0.10 + 0.20 = 0.30 (o clássico erro de float não acontece)", () => {
    expect(brl("0.10").add(brl("0.20")).amount).toBe("0.30");
  });

  test("somas repetidas não acumulam erro", () => {
    let total = Money.zero("BRL");
    for (let i = 0; i < 1000; i++) total = total.add(brl("0.01"));
    expect(total.amount).toBe("10.00");
  });

  test("subtract, negate e sinais", () => {
    const r = brl("20.00").subtract(brl("80.00"));
    expect(r.amount).toBe("-60.00");
    expect(r.isNegative()).toBe(true);
    expect(r.negate().amount).toBe("60.00");
    expect(brl("0.05").negate().amount).toBe("-0.05");
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
  });

  test("comparações", () => {
    expect(brl("79.99").isLessThan(brl("80.00"))).toBe(true);
    expect(brl("80.00").isLessThan(brl("80.00"))).toBe(false);
    expect(brl("80").equals(brl("80.00"))).toBe(true);
    expect(brl("80").equals(Money.from({ amount: "80", currency: "USD" }))).toBe(false);
  });

  test("é imutável: operações retornam novas instâncias", () => {
    const a = brl("10.00");
    const b = a.add(brl("5.00"));
    expect(a.amount).toBe("10.00");
    expect(b).not.toBe(a);
  });

  test("overflow além de numeric(19,2) é rejeitado", () => {
    const max = brl("99999999999999999.99");
    expect(() => max.add(brl("0.01"))).toThrow(InvalidMoneyError);
  });
});

describe("Money — conflito de moeda", () => {
  const usd = Money.from({ amount: "10.00", currency: "USD" });

  test.each([
    ["add", () => brl("1.00").add(usd)],
    ["subtract", () => brl("1.00").subtract(usd)],
    ["isLessThan", () => brl("1.00").isLessThan(usd)],
  ])("%s entre moedas diferentes lança CurrencyMismatchError", (_op, fn) => {
    expect(fn).toThrow(CurrencyMismatchError);
  });
});
