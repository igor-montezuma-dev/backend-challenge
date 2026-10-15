ALTER TABLE wager_transactions
  ALTER CONSTRAINT wager_transactions_wallet_id_fkey DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE wager_transactions
  ALTER CONSTRAINT wager_transactions_reference_transaction_id_fkey DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE wallet_ledger_entries
  ALTER CONSTRAINT fk_ledger_wallet DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE wallet_ledger_entries
  ALTER CONSTRAINT fk_ledger_transaction DEFERRABLE INITIALLY DEFERRED;
