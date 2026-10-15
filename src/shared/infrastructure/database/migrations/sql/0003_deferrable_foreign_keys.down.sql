ALTER TABLE wallet_ledger_entries
  ALTER CONSTRAINT fk_ledger_transaction NOT DEFERRABLE;

ALTER TABLE wallet_ledger_entries
  ALTER CONSTRAINT fk_ledger_wallet NOT DEFERRABLE;

ALTER TABLE wager_transactions
  ALTER CONSTRAINT wager_transactions_reference_transaction_id_fkey NOT DEFERRABLE;

ALTER TABLE wager_transactions
  ALTER CONSTRAINT wager_transactions_wallet_id_fkey NOT DEFERRABLE;
