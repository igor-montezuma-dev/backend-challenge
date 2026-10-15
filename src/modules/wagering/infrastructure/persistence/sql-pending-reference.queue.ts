import type { MikroORM } from "@mikro-orm/postgresql";
import type { PendingReferenceBacklog, PendingReferenceQueue } from "../../application/ports/pending-reference-queue.port";

const CLAIM_DUE_SQL = `
  UPDATE wager_transactions AS t
     SET next_reference_check_at = now() + (? * interval '1 millisecond')
   WHERE t.id IN (
         SELECT id FROM wager_transactions
          WHERE status = 'PENDING_REFERENCE'
            AND next_reference_check_at <= now()
          ORDER BY next_reference_check_at
          LIMIT ?
            FOR UPDATE SKIP LOCKED)
  RETURNING t.id`;

const BACKLOG_SQL = `
  SELECT COUNT(*)::int AS waiting,
         COUNT(*) FILTER (WHERE next_reference_check_at <= now())::int AS due
    FROM wager_transactions
   WHERE status = 'PENDING_REFERENCE'`;

export class SqlPendingReferenceQueue implements PendingReferenceQueue {
  constructor(private readonly orm: MikroORM) {}

  async claimDue(limit: number, leaseMs: number): Promise<string[]> {
    const rows = await this.execute<{ id: string }[]>(CLAIM_DUE_SQL, [leaseMs, limit]);
    return rows.map((row) => row.id);
  }

  async backlog(): Promise<PendingReferenceBacklog> {
    const [row] = await this.execute<PendingReferenceBacklog[]>(BACKLOG_SQL, []);
    return { waiting: row?.waiting ?? 0, due: row?.due ?? 0 };
  }

  private execute<T>(sql: string, params: unknown[]): Promise<T> {
    return this.orm.em.fork().getConnection().execute(sql, params as never[]) as Promise<T>;
  }
}
