CREATE OR REPLACE FUNCTION trg_outbox_guard() RETURNS trigger
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

DROP INDEX IF EXISTS ix_outbox_partition_position;
DROP INDEX IF EXISTS ix_outbox_pending_due;
ALTER TABLE outbox_messages DROP CONSTRAINT IF EXISTS uq_outbox_position;
ALTER TABLE outbox_messages DROP COLUMN IF EXISTS position;

CREATE INDEX ix_outbox_pending_due
  ON outbox_messages (next_attempt_at, occurred_at)
  WHERE published_at IS NULL;
