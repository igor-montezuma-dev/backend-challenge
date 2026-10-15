import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, Money } from "../../src/shared/domain/money";
import { ValidationError } from "../../src/shared/domain/domain-error";
import { InsufficientFundsError, Wallet } from "../../src/modules/wagering/domain/wallet/wallet";
import { LedgerDirection, WalletLedgerEntry } from "../../src/modules/wagering/domain/wallet/wallet-ledger-entry";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });
const at = new Date("2026-10-13T12:00:00Z");
let seq = 0;
const ref = () => ({ transactionId: `tx-${++seq}`, ledgerEntryId: `le-${seq}`, at });

function open(balance: string): Wallet {
  return Wallet.open({ id: "w-1", playerId: "p-1", initialBalance: brl(balance), opening: ref() });
}

function replay(entries: WalletLedgerEntry[], currency = "BRL"): Money {
  return entries.reduce((acc, e) => acc.add(e.signedAmount()), Money.zero(currency));
}

describe("Wallet.open", () => {
  test("version 1 e lançamento de abertura quando saldo > 0", () => {
    const wallet = Wallet.open({
      id: "w-1", playerId: "p-1", initialBalance: brl("100.00"), opening: ref(),
    });
    const [openingEntry] = wallet.pendingEntries;
    expect(wallet.version).toBe(1);
    expect(wallet.balance.amount).toBe("100.00");
    expect(wallet.currency).toBe("BRL");
    expect(openingEntry).toBeDefined();
    expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry!.walletVersion).toBe(1);
    expect(openingEntry!.balanceBefore.amount).toBe("0.00");
    expect(openingEntry!.balanceAfter.amount).toBe("100.00");
  });

  test("saldo zero não gera lançamento", () => {
    const wallet = Wallet.open({
      id: "w-1", playerId: "p-1", initialBalance: Money.zero("BRL"), opening: ref(),
    });
    const [openingEntry] = wallet.pendingEntries;
    expect(wallet.version).toBe(1);
    expect(openingEntry).toBeUndefined();
  });
});

describe("Wallet — lançamentos pendentes do aggregate", () => {
  test("cada movimento fica pendente até o repositório persistir o aggregate", () => {
    const wallet = Wallet.open({ id: "w-1", playerId: "p-1", initialBalance: brl("100.00"), opening: ref() });
    wallet.debit(brl("10.00"), ref());
    wallet.credit(brl("5.00"), ref());

    expect(wallet.pendingEntries.map((e) => e.walletVersion)).toEqual([1, 2, 3]);
    const pulled = wallet.pullPendingEntries();
    expect(pulled).toHaveLength(3);
    expect(wallet.pendingEntries).toHaveLength(0);
    expect(replay(pulled).equals(wallet.balance)).toBe(true);
  });

  test("movimento recusado não deixa lançamento pendente", () => {
    const wallet = open("10.00");
    wallet.pullPendingEntries();
    expect(() => wallet.debit(brl("10.01"), ref())).toThrow(InsufficientFundsError);
    expect(wallet.pendingEntries).toHaveLength(0);
  });
});

describe("Wallet — débito e crédito", () => {
  test("debit/credit movem saldo, incrementam version e devolvem o lançamento", () => {
    const wallet = Wallet.open({ id: "w-1", playerId: "p-1", initialBalance: brl("100.00"), opening: ref() });
    const [openingEntry] = wallet.pendingEntries;
    const e1 = wallet.debit(brl("25.00"), ref());
    const e2 = wallet.credit(brl("40.50"), ref());

    expect(wallet.balance.amount).toBe("115.50");
    expect(wallet.version).toBe(3);
    expect(e1).toMatchObject({ direction: LedgerDirection.Debit, walletVersion: 2 });
    expect(e1.balanceBefore.amount).toBe("100.00");
    expect(e1.balanceAfter.amount).toBe("75.00");
    expect(e2).toMatchObject({ direction: LedgerDirection.Credit, walletVersion: 3 });
    expect(replay([openingEntry!, e1, e2]).equals(wallet.balance)).toBe(true);
  });

  test("débito de todo o saldo é permitido (saldo zero)", () => {
    const wallet = open("80.00");
    wallet.debit(brl("80.00"), ref());
    expect(wallet.balance.isZero()).toBe(true);
  });

  test("saldo insuficiente: lança e não altera estado", () => {
    const wallet = open("100.00");
    wallet.debit(brl("80.00"), ref());
    expect(() => wallet.debit(brl("80.00"), ref())).toThrow(InsufficientFundsError);
    expect(wallet.balance.amount).toBe("20.00");
    expect(wallet.version).toBe(2);
  });

  test("moeda diferente da wallet é rejeitada sem alterar estado", () => {
    const wallet = open("100.00");
    const usd = Money.from({ amount: "1.00", currency: "USD" });
    expect(() => wallet.credit(usd, ref())).toThrow(CurrencyMismatchError);
    expect(() => wallet.debit(usd, ref())).toThrow(CurrencyMismatchError);
    expect(wallet.version).toBe(1);
  });

  test("movimento zero não é permitido (version só muda quando o saldo muda)", () => {
    const wallet = open("100.00");
    expect(() => wallet.credit(Money.zero("BRL"), ref())).toThrow(ValidationError);
    expect(wallet.version).toBe(1);
  });

  test("rehydrate reconstrói sem revalidar", () => {
    const w = Wallet.rehydrate({
      id: "w-9", playerId: "p-9", currency: "BRL", balance: brl("5.00"), version: 7, createdAt: at, updatedAt: at,
    });
    expect(w.version).toBe(7);
    expect(w.balance.amount).toBe("5.00");
  });
});

describe("WalletLedgerEntry", () => {
  const base = {
    id: "le", walletId: "w", transactionId: "t", walletVersion: 2, createdAt: at,
    direction: LedgerDirection.Debit, money: brl("10.00"), balanceBefore: brl("100.00"), balanceAfter: brl("90.00"),
  };

  test("create valida a aritmética", () => {
    expect(WalletLedgerEntry.create(base).isBalanced()).toBe(true);
    expect(() => WalletLedgerEntry.create({ ...base, balanceAfter: brl("80.00") })).toThrow();
    expect(() => WalletLedgerEntry.create({ ...base, direction: LedgerDirection.Credit })).toThrow();
  });

  test("create recusa valor não positivo e saldo negativo", () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: Money.zero("BRL"), balanceAfter: brl("100.00") })).toThrow();
    expect(() =>
      WalletLedgerEntry.create({ ...base, balanceBefore: brl("5.00"), balanceAfter: brl("5.00").subtract(brl("10.00")) }),
    ).toThrow();
  });

  test("create recusa moedas misturadas", () => {
    expect(() => WalletLedgerEntry.create({ ...base, money: Money.from({ amount: "10.00", currency: "USD" }) })).toThrow(
      CurrencyMismatchError,
    );
  });

  test("é estruturalmente imutável", () => {
    const entry = WalletLedgerEntry.create(base);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(() => {
      (entry as unknown as { walletVersion: number }).walletVersion = 99;
    }).toThrow();
  });
});
