CREATE TABLE wallets (
  id          uuid          PRIMARY KEY,
  player_id   uuid          NOT NULL,
  currency    char(3)       NOT NULL,
  balance     numeric(19,2) NOT NULL,
  version     integer       NOT NULL,
  created_at  timestamptz   NOT NULL DEFAULT now(),
  updated_at  timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT ck_wallets_currency_iso   CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_wallets_balance_non_negative CHECK (balance >= 0),
  CONSTRAINT ck_wallets_version_positive     CHECK (version >= 1),
  CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency),
  CONSTRAINT uq_wallets_id_currency     UNIQUE (id, currency)
);

CREATE TABLE wager_transactions (
  id                                uuid          PRIMARY KEY,
  provider_id                       text          NOT NULL,
  external_transaction_id           text          NOT NULL,
  idempotency_key                   text          NOT NULL,
  payload_hash                      char(64)      NOT NULL,
  wallet_id                         uuid          NOT NULL REFERENCES wallets (id),
  player_id                         uuid          NOT NULL,
  round_id                          text          NOT NULL,
  game_id                           text          NOT NULL,
  kind                              text          NOT NULL,
  amount                            numeric(19,2) NOT NULL,
  currency                          char(3)       NOT NULL,
  reference_external_transaction_id text,
  reference_transaction_id          uuid          REFERENCES wager_transactions (id),
  status                            text          NOT NULL,
  failure_code                      text,
  balance_after                     numeric(19,2),
  reference_attempts                integer       NOT NULL DEFAULT 0,
  next_reference_check_at           timestamptz,
  created_at                        timestamptz   NOT NULL DEFAULT now(),
  updated_at                        timestamptz   NOT NULL DEFAULT now(),
  processed_at                      timestamptz,

  CONSTRAINT ck_wager_tx_provider_id_len  CHECK (length(provider_id) BETWEEN 1 AND 128),
  CONSTRAINT ck_wager_tx_external_id_len  CHECK (length(external_transaction_id) BETWEEN 1 AND 256),
  CONSTRAINT ck_wager_tx_idem_key_len     CHECK (length(idempotency_key) BETWEEN 1 AND 512),
  CONSTRAINT ck_wager_tx_payload_hash     CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_wager_tx_round_id_len     CHECK (length(round_id) BETWEEN 1 AND 256),
  CONSTRAINT ck_wager_tx_game_id_len      CHECK (length(game_id) BETWEEN 1 AND 256),
  CONSTRAINT ck_wager_tx_currency_iso     CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT ck_wager_tx_kind CHECK (
    kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')
  ),
  CONSTRAINT ck_wager_tx_status CHECK (
    status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')
  ),
  CONSTRAINT ck_wager_tx_amount CHECK (
    (kind = 'LOSS' AND amount >= 0) OR (kind <> 'LOSS' AND amount > 0)
  ),
  CONSTRAINT ck_wager_tx_reference_required CHECK (
    kind NOT IN ('REFUND', 'ROLLBACK') OR reference_external_transaction_id IS NOT NULL
  ),
  CONSTRAINT ck_wager_tx_opening_no_reference CHECK (
    kind <> 'OPENING' OR reference_external_transaction_id IS NULL
  ),
  CONSTRAINT ck_wager_tx_no_self_reference CHECK (reference_transaction_id <> id),
  CONSTRAINT ck_wager_tx_failure_code CHECK (
    (status IN ('REJECTED', 'FAILED')) = (failure_code IS NOT NULL)
  ),
  CONSTRAINT ck_wager_tx_processed_at CHECK (
    (status = 'PROCESSED') = (processed_at IS NOT NULL)
  ),
  CONSTRAINT ck_wager_tx_processed_has_balance CHECK (
    status <> 'PROCESSED' OR balance_after IS NOT NULL
  ),
  CONSTRAINT ck_wager_tx_balance_after_non_negative CHECK (balance_after >= 0),
  CONSTRAINT ck_wager_tx_pending_ref_scheduled CHECK (
    status <> 'PENDING_REFERENCE' OR next_reference_check_at IS NOT NULL
  ),
  CONSTRAINT ck_wager_tx_reference_attempts CHECK (reference_attempts >= 0),

  CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id),
  CONSTRAINT uq_wager_tx_id_wallet_currency UNIQUE (id, wallet_id, currency)
);

CREATE UNIQUE INDEX uq_wager_tx_single_reversal
  ON wager_transactions (reference_transaction_id)
  WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';

CREATE INDEX ix_wager_tx_pending_reference_due
  ON wager_transactions (next_reference_check_at)
  WHERE status = 'PENDING_REFERENCE';

CREATE INDEX ix_wager_tx_awaiting_reference
  ON wager_transactions (provider_id, reference_external_transaction_id)
  WHERE status = 'PENDING_REFERENCE';

CREATE INDEX ix_wager_tx_wallet_created ON wager_transactions (wallet_id, created_at);

CREATE TABLE wallet_ledger_entries (
  id              uuid          PRIMARY KEY,
  wallet_id       uuid          NOT NULL,
  transaction_id  uuid          NOT NULL,
  wallet_version  integer       NOT NULL,
  direction       text          NOT NULL,
  amount          numeric(19,2) NOT NULL,
  currency        char(3)       NOT NULL,
  balance_before  numeric(19,2) NOT NULL,
  balance_after   numeric(19,2) NOT NULL,
  created_at      timestamptz   NOT NULL DEFAULT now(),

  CONSTRAINT ck_ledger_direction CHECK (direction IN ('DEBIT', 'CREDIT')),
  CONSTRAINT ck_ledger_amount_positive CHECK (amount > 0),
  CONSTRAINT ck_ledger_balances_non_negative CHECK (balance_before >= 0 AND balance_after >= 0),
  CONSTRAINT ck_ledger_version_positive CHECK (wallet_version >= 1),
  CONSTRAINT ck_ledger_arithmetic CHECK (
    (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
    (direction = 'DEBIT'  AND balance_after = balance_before - amount)
  ),
  CONSTRAINT fk_ledger_wallet FOREIGN KEY (wallet_id, currency)
    REFERENCES wallets (id, currency),
  CONSTRAINT fk_ledger_transaction FOREIGN KEY (transaction_id, wallet_id, currency)
    REFERENCES wager_transactions (id, wallet_id, currency),
  CONSTRAINT uq_ledger_transaction_wallet UNIQUE (transaction_id, wallet_id),
  CONSTRAINT uq_ledger_wallet_version UNIQUE (wallet_id, wallet_version)
);

CREATE TABLE inbox_messages (
  consumer_name text        NOT NULL,
  message_id    text        NOT NULL,
  payload_hash  char(64)    NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,

  CONSTRAINT pk_inbox_messages PRIMARY KEY (consumer_name, message_id),
  CONSTRAINT ck_inbox_payload_hash CHECK (payload_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE outbox_messages (
  id               uuid        PRIMARY KEY,
  aggregate_id     text        NOT NULL,
  partition_key    text        NOT NULL,
  event_type       text        NOT NULL,
  payload          jsonb       NOT NULL,
  occurred_at      timestamptz NOT NULL,
  attempts         integer     NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  locked_by        text,
  locked_until     timestamptz,
  last_error       text,
  published_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ck_outbox_attempts CHECK (attempts >= 0),
  CONSTRAINT ck_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX ix_outbox_pending_due
  ON outbox_messages (next_attempt_at, occurred_at)
  WHERE published_at IS NULL;

CREATE FUNCTION wagering_raise(code text, msg text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%', msg USING ERRCODE = 'check_violation', CONSTRAINT = code;
END $$;

CREATE FUNCTION trg_ledger_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM wagering_raise('ledger_immutable',
    format('wallet_ledger_entries is append-only (%s rejected)', TG_OP));
  RETURN NULL;
END $$;

CREATE TRIGGER ledger_no_update_delete
  BEFORE UPDATE OR DELETE ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION trg_ledger_immutable();

CREATE TRIGGER ledger_no_truncate
  BEFORE TRUNCATE ON wallet_ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION trg_ledger_immutable();

CREATE FUNCTION trg_ledger_chain() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev_after numeric(19,2);
BEGIN
  SELECT balance_after INTO prev_after
    FROM wallet_ledger_entries
   WHERE wallet_id = NEW.wallet_id AND wallet_version = NEW.wallet_version - 1;

  IF FOUND THEN
    IF prev_after <> NEW.balance_before THEN
      PERFORM wagering_raise('ledger_chain', format(
        'ledger chain broken for wallet %s at version %s: previous balance_after %s <> balance_before %s',
        NEW.wallet_id, NEW.wallet_version, prev_after, NEW.balance_before));
    END IF;
  ELSIF NOT (NEW.wallet_version IN (1, 2) AND NEW.balance_before = 0) THEN
    PERFORM wagering_raise('ledger_chain', format(
      'ledger chain broken for wallet %s: missing entry for version %s',
      NEW.wallet_id, NEW.wallet_version - 1));
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER ledger_chain
  BEFORE INSERT ON wallet_ledger_entries
  FOR EACH ROW EXECUTE FUNCTION trg_ledger_chain();

CREATE FUNCTION trg_wallet_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM wagering_raise('wallet_no_delete', 'wallets cannot be deleted');
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.version <> 1 THEN
      PERFORM wagering_raise('wallet_version', 'wallet must be created with version 1');
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.player_id <> OLD.player_id
     OR NEW.currency <> OLD.currency OR NEW.created_at <> OLD.created_at THEN
    PERFORM wagering_raise('wallet_identity_immutable',
      'wallet id, player_id, currency and created_at are immutable');
  END IF;

  IF NEW.balance <> OLD.balance AND NEW.version <> OLD.version + 1 THEN
    PERFORM wagering_raise('wallet_version', format(
      'balance changed but version went %s -> %s (expected %s)',
      OLD.version, NEW.version, OLD.version + 1));
  ELSIF NEW.balance = OLD.balance AND NEW.version <> OLD.version THEN
    PERFORM wagering_raise('wallet_version', 'version changed without a balance change');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER wallet_guard
  BEFORE INSERT OR UPDATE OR DELETE ON wallets
  FOR EACH ROW EXECUTE FUNCTION trg_wallet_guard();

CREATE FUNCTION trg_wager_tx_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM wagering_raise('wager_tx_no_delete', 'wager transactions cannot be deleted');
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status NOT IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED') THEN
      PERFORM wagering_raise('wager_tx_transition',
        format('cannot insert a transaction in status %s', NEW.status));
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW.id, NEW.provider_id, NEW.external_transaction_id, NEW.idempotency_key,
      NEW.payload_hash, NEW.wallet_id, NEW.player_id, NEW.round_id, NEW.game_id,
      NEW.kind, NEW.amount, NEW.currency, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.provider_id, OLD.external_transaction_id, OLD.idempotency_key,
      OLD.payload_hash, OLD.wallet_id, OLD.player_id, OLD.round_id, OLD.game_id,
      OLD.kind, OLD.amount, OLD.currency, OLD.created_at)
     OR NEW.reference_external_transaction_id IS DISTINCT FROM OLD.reference_external_transaction_id
  THEN
    PERFORM wagering_raise('wager_tx_immutable', 'business fields of a wager transaction are immutable');
  END IF;

  IF OLD.reference_transaction_id IS NOT NULL
     AND NEW.reference_transaction_id IS DISTINCT FROM OLD.reference_transaction_id THEN
    PERFORM wagering_raise('wager_tx_immutable', 'resolved reference cannot change');
  END IF;

  IF OLD.status IN ('PROCESSED', 'REJECTED', 'FAILED') THEN
    PERFORM wagering_raise('wager_tx_terminal', format(
      'transaction %s is terminal (%s) and cannot be updated', OLD.id, OLD.status));
  END IF;
  IF NEW.status = 'PENDING' AND OLD.status <> 'PENDING' THEN
    PERFORM wagering_raise('wager_tx_transition',
      format('invalid transition %s -> PENDING', OLD.status));
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE TRIGGER wager_tx_guard
  BEFORE INSERT OR UPDATE OR DELETE ON wager_transactions
  FOR EACH ROW EXECUTE FUNCTION trg_wager_tx_guard();

CREATE FUNCTION trg_outbox_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.aggregate_id, NEW.partition_key, NEW.event_type, NEW.payload, NEW.occurred_at)
     IS DISTINCT FROM
     (OLD.id, OLD.aggregate_id, OLD.partition_key, OLD.event_type, OLD.payload, OLD.occurred_at)
  THEN
    PERFORM wagering_raise('outbox_immutable', 'outbox event content is immutable');
  END IF;
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    PERFORM wagering_raise('outbox_immutable', 'published_at cannot change once set');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER outbox_guard
  BEFORE UPDATE ON outbox_messages
  FOR EACH ROW EXECUTE FUNCTION trg_outbox_guard();

CREATE FUNCTION trg_wallet_matches_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  w wallets%ROWTYPE;
  entry_after numeric(19,2);
BEGIN
  SELECT * INTO w FROM wallets WHERE id = NEW.id;

  IF NOT (w.version = 1 AND w.balance = 0) THEN
    SELECT balance_after INTO entry_after
      FROM wallet_ledger_entries
     WHERE wallet_id = w.id AND wallet_version = w.version;
    IF NOT FOUND OR entry_after <> w.balance THEN
      PERFORM wagering_raise('wallet_ledger_mismatch', format(
        'wallet %s balance %s at version %s has no matching ledger entry',
        w.id, w.balance, w.version));
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM wallet_ledger_entries
              WHERE wallet_id = w.id AND wallet_version > w.version) THEN
    PERFORM wagering_raise('wallet_ledger_mismatch', format(
      'wallet %s has ledger entries beyond its version %s', w.id, w.version));
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER wallet_matches_ledger
  AFTER INSERT OR UPDATE ON wallets
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_wallet_matches_ledger();

CREATE FUNCTION trg_ledger_matches_transaction() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t wager_transactions%ROWTYPE;
  wallet_version integer;
BEGIN
  SELECT * INTO t FROM wager_transactions WHERE id = NEW.transaction_id;
  IF t.status <> 'PROCESSED' OR t.kind = 'LOSS' THEN
    PERFORM wagering_raise('ledger_transaction_mismatch', format(
      'ledger entry %s belongs to transaction %s (%s, %s), which cannot move balance',
      NEW.id, t.id, t.kind, t.status));
  END IF;
  IF t.amount <> NEW.amount THEN
    PERFORM wagering_raise('ledger_transaction_mismatch', format(
      'ledger amount %s differs from transaction amount %s', NEW.amount, t.amount));
  END IF;
  IF t.balance_after <> NEW.balance_after THEN
    PERFORM wagering_raise('ledger_transaction_mismatch', format(
      'transaction %s balance_after %s differs from ledger balance_after %s',
      t.id, t.balance_after, NEW.balance_after));
  END IF;

  SELECT version INTO wallet_version FROM wallets WHERE id = NEW.wallet_id;
  IF wallet_version < NEW.wallet_version THEN
    PERFORM wagering_raise('wallet_ledger_mismatch', format(
      'ledger entry %s (version %s) was not applied to wallet %s (version %s)',
      NEW.id, NEW.wallet_version, NEW.wallet_id, wallet_version));
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ledger_matches_transaction
  AFTER INSERT ON wallet_ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_ledger_matches_transaction();

CREATE FUNCTION trg_transaction_matches_ledger() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  t wager_transactions%ROWTYPE;
  has_entry boolean;
BEGIN
  SELECT * INTO t FROM wager_transactions WHERE id = NEW.id;
  SELECT EXISTS (SELECT 1 FROM wallet_ledger_entries WHERE transaction_id = t.id)
    INTO has_entry;

  IF t.status = 'PROCESSED' AND t.kind <> 'LOSS' AND NOT has_entry THEN
    PERFORM wagering_raise('transaction_ledger_mismatch', format(
      'transaction %s (%s) is PROCESSED but has no ledger entry', t.id, t.kind));
  ELSIF (t.status <> 'PROCESSED' OR t.kind = 'LOSS') AND has_entry THEN
    PERFORM wagering_raise('transaction_ledger_mismatch', format(
      'transaction %s (%s, %s) must not have a ledger entry', t.id, t.kind, t.status));
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER transaction_matches_ledger
  AFTER INSERT OR UPDATE ON wager_transactions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION trg_transaction_matches_ledger();
