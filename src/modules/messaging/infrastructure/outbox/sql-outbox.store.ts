import type { MikroORM } from "@mikro-orm/postgresql";
import { OutboxMessage } from "../../domain/outbox-message";
import type { ClaimedOutboxMessage, OutboxStore } from "../../application/ports/outbox-store.port";

interface OutboxRow {
  id: string;
  aggregate_id: string;
  partition_key: string;
  event_type: string;
  payload: Record<string, unknown> | string;
  occurred_at: Date | string;
  attempts: number;
  next_attempt_at: Date | string | null;
  published_at: Date | string | null;
  last_error: string | null;
  position: string;
}

const CLAIM_DUE_SQL = `
  UPDATE outbox_messages AS o
     SET locked_by = ?, locked_until = now() + (? * interval '1 millisecond')
   WHERE o.id IN (
         SELECT id FROM outbox_messages
          WHERE published_at IS NULL
            AND next_attempt_at <= now()
            AND (locked_until IS NULL OR locked_until < now())
            AND NOT EXISTS (
                SELECT 1 FROM outbox_messages AS head
                 WHERE head.partition_key = outbox_messages.partition_key
                   AND head.published_at IS NULL
                   AND head.position < outbox_messages.position
                   AND head.locked_until >= now())
          ORDER BY position
          LIMIT ?
            FOR UPDATE SKIP LOCKED)
  RETURNING o.id, o.aggregate_id, o.partition_key, o.event_type, o.payload, o.occurred_at,
            o.attempts, o.next_attempt_at, o.published_at, o.last_error, o.position::text AS position`;

const HAS_EARLIER_UNPUBLISHED_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM outbox_messages
     WHERE partition_key = ? AND published_at IS NULL AND position < ?::bigint
  ) AS blocked`;

const MARK_PUBLISHED_SQL = `
  UPDATE outbox_messages
     SET published_at = now(), attempts = attempts + 1, locked_by = NULL, locked_until = NULL, last_error = NULL
   WHERE id = ANY(?::uuid[]) AND published_at IS NULL
  RETURNING id`;

const RESCHEDULE_SQL = `
  UPDATE outbox_messages
     SET attempts = ?, next_attempt_at = now() + (? * interval '1 millisecond'), last_error = ?, locked_by = NULL, locked_until = NULL
   WHERE id = ? AND published_at IS NULL`;

const RELEASE_SQL = `
  UPDATE outbox_messages
     SET locked_by = NULL, locked_until = NULL
   WHERE id = ANY(?::uuid[]) AND locked_by = ? AND published_at IS NULL`;

const PENDING_STATS_SQL = `
  SELECT COUNT(*)::int AS pending,
         COALESCE(EXTRACT(EPOCH FROM (now() - MIN(occurred_at))) * 1000, 0)::float8 AS oldest_ms
    FROM outbox_messages
   WHERE published_at IS NULL`;

export class SqlOutboxStore implements OutboxStore {
  constructor(private readonly orm: MikroORM) {}

  async claimDue(owner: string, limit: number, leaseMs: number): Promise<ClaimedOutboxMessage[]> {
    const rows = await this.execute<OutboxRow[]>(CLAIM_DUE_SQL, [owner, leaseMs, limit]);
    return rows.map((row) => ({ message: toDomain(row), position: BigInt(row.position) }));
  }

  async hasEarlierUnpublished(partitionKey: string, position: bigint): Promise<boolean> {
    const [row] = await this.execute<{ blocked: boolean }[]>(HAS_EARLIER_UNPUBLISHED_SQL, [partitionKey, position.toString()]);
    return row?.blocked === true;
  }

  async markPublished(messages: readonly OutboxMessage[]): Promise<number> {
    if (messages.length === 0) return 0;
    const rows = await this.execute<{ id: string }[]>(MARK_PUBLISHED_SQL, [uuidArray(messages)]);
    return rows.length;
  }

  async reschedule(message: OutboxMessage, retryInMs: number): Promise<void> {
    await this.execute(RESCHEDULE_SQL, [message.attempts, retryInMs, message.lastError ?? null, message.id]);
  }

  async release(messages: readonly OutboxMessage[], owner: string): Promise<void> {
    if (messages.length === 0) return;
    await this.execute(RELEASE_SQL, [uuidArray(messages), owner]);
  }

  async pendingStats(): Promise<{ pending: number; oldestPendingAgeMs: number }> {
    const [row] = await this.execute<{ pending: number; oldest_ms: number }[]>(PENDING_STATS_SQL, []);
    return { pending: row?.pending ?? 0, oldestPendingAgeMs: row?.oldest_ms ?? 0 };
  }

  private execute<T = unknown>(sql: string, params: unknown[]): Promise<T> {
    return this.orm.em.fork().getConnection().execute(sql, params as never[]) as Promise<T>;
  }
}

const uuidArray = (messages: readonly OutboxMessage[]): string => `{${messages.map((m) => m.id).join(",")}}`;

function toDomain(row: OutboxRow): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregate_id,
    partitionKey: row.partition_key,
    eventType: row.event_type,
    payload: typeof row.payload === "string" ? (JSON.parse(row.payload) as Record<string, unknown>) : row.payload,
    occurredAt: new Date(row.occurred_at),
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at ? new Date(row.next_attempt_at) : undefined,
    publishedAt: row.published_at ? new Date(row.published_at) : undefined,
    lastError: row.last_error ?? undefined,
  });
}
