export interface PendingReferenceBacklog {
  waiting: number;
  due: number;
}

export interface PendingReferenceQueue {
  claimDue(limit: number, leaseMs: number): Promise<string[]>;
  backlog(): Promise<PendingReferenceBacklog>;
}
