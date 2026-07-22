/**
 * @sentinel/persistence — durable Postgres implementations of the contracts' storage ports.
 *
 * Dependency rule: this package depends on `@sentinel/contracts` and `pg`. Nothing else. It must
 * never import an application, a browser, or a queue driver — a database layer that transitively
 * pulls in Playwright is a database layer nobody can deploy on its own.
 *
 * Redis holds operational checkpoints so a crashed read can resume. Postgres is the system of
 * record: what survives a flush, an expiry and a redeploy.
 */
export * from './outcome-repository';
export * from './endpoint-registry-store';
export * from './candidate-store';
