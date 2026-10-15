export interface UnitOfWork<Repositories> {
  run<T>(work: (repositories: Repositories) => Promise<T>): Promise<T>;
}
