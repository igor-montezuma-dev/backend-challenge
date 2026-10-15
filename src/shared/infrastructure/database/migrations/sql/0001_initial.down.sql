DROP TABLE IF EXISTS outbox_messages;
DROP TABLE IF EXISTS inbox_messages;
DROP TABLE IF EXISTS wallet_ledger_entries;
DROP TABLE IF EXISTS wager_transactions;
DROP TABLE IF EXISTS wallets;

DROP FUNCTION IF EXISTS trg_transaction_matches_ledger();
DROP FUNCTION IF EXISTS trg_ledger_matches_transaction();
DROP FUNCTION IF EXISTS trg_wallet_matches_ledger();
DROP FUNCTION IF EXISTS trg_outbox_guard();
DROP FUNCTION IF EXISTS trg_wager_tx_guard();
DROP FUNCTION IF EXISTS trg_wallet_guard();
DROP FUNCTION IF EXISTS trg_ledger_chain();
DROP FUNCTION IF EXISTS trg_ledger_immutable();
DROP FUNCTION IF EXISTS wagering_raise(text, text);
