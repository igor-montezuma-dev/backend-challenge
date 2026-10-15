import { SQL } from "bun";
import { buildHarness } from "./harness";

interface Job {
  url: string;
  instance: string;
  operations: Record<string, unknown>[];
  startAt: number;
}

const job = JSON.parse(process.env.JOB ?? "{}") as Job;
const sql = new SQL(job.url);
const h = await buildHarness(job.url, sql, { poolMax: 10 });

const delay = job.startAt - Date.now();
if (delay > 0) await Bun.sleep(delay);

const results = await Promise.all(
  job.operations.map(async (op) => {
    try {
      const r = await h.processWager.execute(op, { correlationId: `${job.instance}:${String(op.externalTransactionId)}` });
      return { ok: true, id: r.transaction.id, status: r.transaction.status, replay: r.idempotentReplay, failureCode: r.transaction.failureCode ?? null };
    } catch (error) {
      return { ok: false, error: (error as Error).name, code: (error as { code?: string }).code ?? null };
    }
  }),
);

await h.orm.close(true);
await sql.close();
console.log(JSON.stringify({ instance: job.instance, pid: process.pid, results }));
