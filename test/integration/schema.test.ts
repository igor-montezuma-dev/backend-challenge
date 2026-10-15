import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { createTestDatabase, migrateDown, migrateUp, pgError } from "../support/database";

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let sql: SQL;

beforeAll(async () => {
  db = await createTestDatabase();
  sql = db.sql;
  await migrateUp(sql);
});

afterAll(async () => {
  await db.drop();
});

const uuid = (): string => crypto.randomUUID();
const hash = (): string => new Bun.CryptoHasher("sha256").update(uuid()).digest("hex");

type TxRow = {
  id: string;
  wallet_id: string;
  kind: string;
  amount: string;
  currency: string;
  status: string;
  reference_external_transaction_id?: string | null;
  reference_transaction_id?: string | null;
  failure_code?: string | null;
  balance_after?: string | null;
  processed_at?: Date | null;
  next_reference_check_at?: Date | null;
  provider_id?: string;
  external_transaction_id?: string;
  idempotency_key?: string;
};

async function insertTx(q: SQL, row: TxRow): Promise<void> {
  const provider = row.provider_id ?? "provider-a";
  const external = row.external_transaction_id ?? `ext-${uuid()}`;
  await q`
    INSERT INTO wager_transactions (
      id, provider_id, external_transaction_id, idempotency_key, payload_hash,
      wallet_id, player_id, round_id, game_id, kind, amount, currency,
      reference_external_transaction_id, reference_transaction_id, status,
      failure_code, balance_after, processed_at, next_reference_check_at
    ) VALUES (
      ${row.id}, ${provider}, ${external}, ${row.idempotency_key ?? `${provider}:${external}`}, ${hash()},
      ${row.wallet_id}, ${uuid()}, 'round-1', 'game-1', ${row.kind}, ${row.amount}, ${row.currency},
      ${row.reference_external_transaction_id ?? null}, ${row.reference_transaction_id ?? null}, ${row.status},
      ${row.failure_code ?? null}, ${row.balance_after ?? null}, ${row.processed_at ?? null},
      ${row.next_reference_check_at ?? null}
    )`;
}

async function openWallet(balance = "100.00", currency = "BRL"): Promise<string> {
  const walletId = uuid();
  await sql.begin(async (tx) => {
    await tx`INSERT INTO wallets (id, player_id, currency, balance, version)
             VALUES (${walletId}, ${uuid()}, ${currency}, ${balance}, 1)`;
    if (balance !== "0.00") {
      const openingId = uuid();
      await insertTx(tx, {
        id: openingId, wallet_id: walletId, kind: "OPENING", amount: balance, currency,
        status: "PROCESSED", balance_after: balance, processed_at: new Date(),
        provider_id: "internal",
      });
      await tx`INSERT INTO wallet_ledger_entries
                 (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
               VALUES (${uuid()}, ${walletId}, ${openingId}, 1, 'CREDIT', ${balance}, ${currency}, '0.00', ${balance})`;
    }
  });
  return walletId;
}

async function applyMovement(
  q: SQL,
  walletId: string,
  kind: "BET" | "WIN" | "REFUND" | "ROLLBACK",
  amount: string,
  extra: Partial<TxRow> = {},
): Promise<string> {
  const [w] = await q`SELECT balance, version, currency FROM wallets WHERE id = ${walletId} FOR UPDATE`;
  const direction = kind === "BET" ? "DEBIT" : "CREDIT";
  const [{ after }] = await q`
    SELECT (CASE WHEN ${direction} = 'DEBIT' THEN ${w.balance}::numeric - ${amount}::numeric
                 ELSE ${w.balance}::numeric + ${amount}::numeric END)::numeric(19,2)::text AS after`;
  const txId = uuid();
  await insertTx(q, {
    id: txId, wallet_id: walletId, kind, amount, currency: w.currency, status: "PROCESSED",
    balance_after: after, processed_at: new Date(), ...extra,
  });
  await q`INSERT INTO wallet_ledger_entries
            (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
          VALUES (${uuid()}, ${walletId}, ${txId}, ${w.version + 1}, ${direction}, ${amount}, ${w.currency}, ${w.balance}, ${after})`;
  await q`UPDATE wallets SET balance = ${after}, version = version + 1, updated_at = now() WHERE id = ${walletId}`;
  return txId;
}

const walletRow = async (id: string) =>
  (await sql`SELECT balance::text AS balance, version FROM wallets WHERE id = ${id}`)[0] as { balance: string; version: number };

const ledgerSum = async (walletId: string): Promise<string> =>
  (await sql`
    SELECT COALESCE(SUM(CASE direction WHEN 'CREDIT' THEN amount ELSE -amount END), 0)::numeric(19,2)::text AS total
      FROM wallet_ledger_entries WHERE wallet_id = ${walletId}`)[0].total;

describe("migrations", () => {
  test("up → down → up é reversível e deixa o banco limpo", async () => {
    const tmp = await createTestDatabase();
    try {
      await migrateUp(tmp.sql);
      await migrateDown(tmp.sql);
      const [{ n }] = await tmp.sql`
        SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'`;
      expect(n).toBe(0);
      const [{ f }] = await tmp.sql`
        SELECT count(*)::int AS f FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
         WHERE ns.nspname = 'public'`;
      expect(f).toBe(0);
      await migrateUp(tmp.sql);
    } finally {
      await tmp.drop();
    }
  });
});

describe("wallets", () => {
  test("abertura correta: wallet, OPENING e ledger consistentes", async () => {
    const id = await openWallet("100.00");
    expect(await walletRow(id)).toEqual({ balance: "100.00", version: 1 });
    expect(await ledgerSum(id)).toBe("100.00");
  });

  test("wallet com saldo zero não exige lançamento", async () => {
    const id = await openWallet("0.00");
    expect(await walletRow(id)).toEqual({ balance: "0.00", version: 1 });
  });

  test("saldo negativo é recusado pelo CHECK", async () => {
    const id = await openWallet("10.00");
    const err = await pgError(() => sql`UPDATE wallets SET balance = -1, version = 2 WHERE id = ${id}`);
    expect(err.constraint).toBe("ck_wallets_balance_non_negative");
  });

  test("no máximo uma wallet por player + moeda", async () => {
    const player = uuid();
    await sql`INSERT INTO wallets (id, player_id, currency, balance, version) VALUES (${uuid()}, ${player}, 'BRL', 0, 1)`;
    const err = await pgError(() =>
      sql`INSERT INTO wallets (id, player_id, currency, balance, version) VALUES (${uuid()}, ${player}, 'BRL', 0, 1)`);
    expect(err.constraint).toBe("uq_wallets_player_currency");
    await sql`INSERT INTO wallets (id, player_id, currency, balance, version) VALUES (${uuid()}, ${player}, 'USD', 0, 1)`;
  });

  test("saldo sem lançamento correspondente falha no COMMIT", async () => {
    const id = await openWallet("100.00");
    const err = await pgError(() =>
      sql.begin(async (tx) => {
        await tx`UPDATE wallets SET balance = 999, version = 2 WHERE id = ${id}`;
      }));
    expect(err.constraint).toBe("wallet_ledger_mismatch");
    expect(await walletRow(id)).toEqual({ balance: "100.00", version: 1 });
  });

  test("version só incrementa de 1 em 1 e só quando o saldo muda", async () => {
    const id = await openWallet("100.00");
    expect((await pgError(() => sql`UPDATE wallets SET version = 2 WHERE id = ${id}`)).constraint)
      .toBe("wallet_version");
    expect((await pgError(() => sql`UPDATE wallets SET balance = 50, version = 3 WHERE id = ${id}`)).constraint)
      .toBe("wallet_version");
  });

  test("wallet não pode ser excluída nem trocar de dono/moeda", async () => {
    const id = await openWallet("0.00");
    expect((await pgError(() => sql`DELETE FROM wallets WHERE id = ${id}`)).constraint).toBe("wallet_no_delete");
    expect((await pgError(() => sql`UPDATE wallets SET currency = 'USD' WHERE id = ${id}`)).constraint)
      .toBe("wallet_identity_immutable");
  });
});

describe("ledger", () => {
  test("movimento correto mantém wallet == soma do ledger", async () => {
    const id = await openWallet("100.00");
    await sql.begin((tx) => applyMovement(tx, id, "BET", "25.00"));
    await sql.begin((tx) => applyMovement(tx, id, "WIN", "40.50"));
    expect(await walletRow(id)).toEqual({ balance: "115.50", version: 3 });
    expect(await ledgerSum(id)).toBe("115.50");
  });

  test("é append-only: UPDATE, DELETE e TRUNCATE são recusados", async () => {
    const id = await openWallet("100.00");
    expect((await pgError(() => sql`UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ${id}`)).constraint)
      .toBe("ledger_immutable");
    expect((await pgError(() => sql`DELETE FROM wallet_ledger_entries WHERE wallet_id = ${id}`)).constraint)
      .toBe("ledger_immutable");
    expect((await pgError(() => sql`TRUNCATE wallet_ledger_entries CASCADE`)).constraint)
      .toBe("ledger_immutable");
  });

  test("aritmética do lançamento é verificada", async () => {
    const id = await openWallet("100.00");
    const err = await pgError(() =>
      sql.begin(async (tx) => {
        const txId = uuid();
        await insertTx(tx, { id: txId, wallet_id: id, kind: "BET", amount: "10.00", currency: "BRL",
          status: "PROCESSED", balance_after: "80.00", processed_at: new Date() });
        await tx`INSERT INTO wallet_ledger_entries
                   (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
                 VALUES (${uuid()}, ${id}, ${txId}, 2, 'DEBIT', '10.00', 'BRL', '100.00', '80.00')`;
      }));
    expect(err.constraint).toBe("ck_ledger_arithmetic");
  });

  test("cadeia quebrada (balance_before ≠ saldo anterior) é recusada", async () => {
    const id = await openWallet("100.00");
    const err = await pgError(() =>
      sql.begin(async (tx) => {
        const txId = uuid();
        await insertTx(tx, { id: txId, wallet_id: id, kind: "WIN", amount: "10.00", currency: "BRL",
          status: "PROCESSED", balance_after: "510.00", processed_at: new Date() });
        await tx`INSERT INTO wallet_ledger_entries
                   (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
                 VALUES (${uuid()}, ${id}, ${txId}, 2, 'CREDIT', '10.00', 'BRL', '500.00', '510.00')`;
      }));
    expect(err.constraint).toBe("ledger_chain");
  });

  test("moeda do lançamento precisa ser a da wallet", async () => {
    const id = await openWallet("100.00", "BRL");
    const err = await pgError(() =>
      sql.begin(async (tx) => {
        const txId = uuid();
        await insertTx(tx, { id: txId, wallet_id: id, kind: "WIN", amount: "10.00", currency: "USD",
          status: "PROCESSED", balance_after: "110.00", processed_at: new Date() });
        await tx`INSERT INTO wallet_ledger_entries
                   (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
                 VALUES (${uuid()}, ${id}, ${txId}, 2, 'CREDIT', '10.00', 'USD', '100.00', '110.00')`;
      }));
    expect(err.constraint).toBe("fk_ledger_wallet");
  });

  test("lost update: duas escritas a partir do mesmo saldo colidem na versão", async () => {
    const id = await openWallet("100.00");
    const attempt = (amount: string) =>
      sql.begin(async (tx) => {
        const txId = uuid();
        const after = (100 - Number(amount)).toFixed(2);
        await insertTx(tx, { id: txId, wallet_id: id, kind: "BET", amount, currency: "BRL",
          status: "PROCESSED", balance_after: after, processed_at: new Date() });
        await tx`INSERT INTO wallet_ledger_entries
                   (id, wallet_id, transaction_id, wallet_version, direction, amount, currency, balance_before, balance_after)
                 VALUES (${uuid()}, ${id}, ${txId}, 2, 'DEBIT', ${amount}, 'BRL', '100.00', ${after})`;
        await tx`UPDATE wallets SET balance = ${after}, version = 2 WHERE id = ${id} AND version = 1`;
      });
    const results = await Promise.allSettled([attempt("80.00"), attempt("80.00")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await walletRow(id)).toEqual({ balance: "20.00", version: 2 });
    expect(await ledgerSum(id)).toBe("20.00");
  });
});

describe("wager_transactions", () => {
  test("idempotency key é única", async () => {
    const id = await openWallet("0.00");
    const base = { wallet_id: id, kind: "LOSS", amount: "0.00", currency: "BRL", status: "PENDING", idempotency_key: `k-${uuid()}` };
    await insertTx(sql, { ...base, id: uuid() });
    const err = await pgError(() => insertTx(sql, { ...base, id: uuid() }));
    expect(err.constraint).toBe("uq_wager_tx_idempotency_key");
  });

  test("(provider, external id) é único mesmo com outra idempotency key", async () => {
    const id = await openWallet("0.00");
    const ext = `ext-${uuid()}`;
    await insertTx(sql, { id: uuid(), wallet_id: id, kind: "LOSS", amount: "0.00", currency: "BRL", status: "PENDING", external_transaction_id: ext, idempotency_key: uuid() });
    const err = await pgError(() =>
      insertTx(sql, { id: uuid(), wallet_id: id, kind: "LOSS", amount: "0.00", currency: "BRL", status: "PENDING", external_transaction_id: ext, idempotency_key: uuid() }));
    expect(err.constraint).toBe("uq_wager_tx_provider_external");
  });

  test("REFUND/ROLLBACK exigem referência; BET não aceita valor zero", async () => {
    const id = await openWallet("0.00");
    expect((await pgError(() => insertTx(sql, { id: uuid(), wallet_id: id, kind: "REFUND", amount: "1.00", currency: "BRL", status: "PENDING" }))).constraint)
      .toBe("ck_wager_tx_reference_required");
    expect((await pgError(() => insertTx(sql, { id: uuid(), wallet_id: id, kind: "BET", amount: "0.00", currency: "BRL", status: "PENDING" }))).constraint)
      .toBe("ck_wager_tx_amount");
  });

  test("REJECTED exige failure_code; PROCESSED exige processed_at e saldo", async () => {
    const id = await openWallet("0.00");
    expect((await pgError(() => insertTx(sql, { id: uuid(), wallet_id: id, kind: "BET", amount: "1.00", currency: "BRL", status: "REJECTED" }))).constraint)
      .toBe("ck_wager_tx_failure_code");
    expect((await pgError(() => insertTx(sql, { id: uuid(), wallet_id: id, kind: "LOSS", amount: "0.00", currency: "BRL", status: "PROCESSED", balance_after: "0.00" }))).constraint)
      .toBe("ck_wager_tx_processed_at");
  });

  test("estado terminal é final e campos de negócio são imutáveis", async () => {
    const id = await openWallet("0.00");
    const rejected = uuid();
    await insertTx(sql, { id: rejected, wallet_id: id, kind: "BET", amount: "5.00", currency: "BRL",
      status: "REJECTED", failure_code: "INSUFFICIENT_FUNDS", balance_after: "0.00" });
    expect((await pgError(() => sql`UPDATE wager_transactions SET status = 'PENDING_REFERENCE', next_reference_check_at = now(), failure_code = NULL WHERE id = ${rejected}`)).constraint)
      .toBe("wager_tx_terminal");

    const pending = uuid();
    await insertTx(sql, { id: pending, wallet_id: id, kind: "BET", amount: "5.00", currency: "BRL", status: "PENDING" });
    expect((await pgError(() => sql`UPDATE wager_transactions SET amount = 1 WHERE id = ${pending}`)).constraint)
      .toBe("wager_tx_immutable");
    expect((await pgError(() => sql`DELETE FROM wager_transactions WHERE id = ${pending}`)).constraint)
      .toBe("wager_tx_no_delete");
  });

  test("PROCESSED sem lançamento falha no COMMIT (exceto LOSS)", async () => {
    const id = await openWallet("100.00");
    const err = await pgError(() =>
      insertTx(sql, { id: uuid(), wallet_id: id, kind: "BET", amount: "5.00", currency: "BRL",
        status: "PROCESSED", balance_after: "95.00", processed_at: new Date() }));
    expect(err.constraint).toBe("transaction_ledger_mismatch");

    await insertTx(sql, { id: uuid(), wallet_id: id, kind: "LOSS", amount: "5.00", currency: "BRL",
      status: "PROCESSED", balance_after: "100.00", processed_at: new Date() });
  });

  test("a mesma referência não pode ser revertida duas vezes", async () => {
    const id = await openWallet("100.00");
    const betExt = `bet-${uuid()}`;
    const betId = await sql.begin((tx) => applyMovement(tx, id, "BET", "30.00", { external_transaction_id: betExt }));
    const reversal = { reference_external_transaction_id: betExt, reference_transaction_id: betId };

    await sql.begin((tx) => applyMovement(tx, id, "REFUND", "30.00", reversal));

    const err = await pgError(() => sql.begin((tx) => applyMovement(tx, id, "REFUND", "30.00", reversal)));
    expect(err.constraint).toBe("uq_wager_tx_single_reversal");
    const err2 = await pgError(() => sql.begin((tx) => applyMovement(tx, id, "ROLLBACK", "30.00", reversal)));
    expect(err2.constraint).toBe("uq_wager_tx_single_reversal");

    await insertTx(sql, { id: uuid(), wallet_id: id, kind: "REFUND", amount: "30.00", currency: "BRL",
      status: "REJECTED", failure_code: "ALREADY_REVERSED", ...reversal });

    expect(await walletRow(id)).toEqual({ balance: "100.00", version: 3 });
    expect(await ledgerSum(id)).toBe("100.00");
  });
});

describe("inbox / outbox", () => {
  test("inbox deduplica por (consumer, messageId)", async () => {
    await sql`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ('wager-consumer', 'msg-1', ${hash()})`;
    const err = await pgError(() =>
      sql`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ('wager-consumer', 'msg-1', ${hash()})`);
    expect(err.constraint).toBe("pk_inbox_messages");
    await sql`INSERT INTO inbox_messages (consumer_name, message_id, payload_hash) VALUES ('other-consumer', 'msg-1', ${hash()})`;
  });

  test("conteúdo do evento é imutável e publicação é irreversível", async () => {
    const id = uuid();
    await sql`INSERT INTO outbox_messages (id, aggregate_id, partition_key, event_type, payload, occurred_at)
              VALUES (${id}, 'agg', 'wallet-1', 'WalletBalanceChanged', ${{ a: 1 }}, now())`;
    expect((await pgError(() => sql`UPDATE outbox_messages SET payload = ${{ a: 2 }} WHERE id = ${id}`)).constraint)
      .toBe("outbox_immutable");
    await sql`UPDATE outbox_messages SET published_at = now() WHERE id = ${id}`;
    expect((await pgError(() => sql`UPDATE outbox_messages SET published_at = NULL WHERE id = ${id}`)).constraint)
      .toBe("outbox_immutable");
  });
});
