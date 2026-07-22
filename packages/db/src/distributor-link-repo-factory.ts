import type { DistributorLinkRepository } from './distributor-link-repo';
import {
  PrismaDistributorLinkRepository,
  type PrismaLinkClient,
} from './prisma-distributor-link-repo';

/**
 * Select the persistence adapter from the environment.
 *
 * `DATABASE_URL` is mandatory and selects PostgreSQL through Prisma. There is no
 * process-local runtime path.
 *
 * The Prisma client is imported dynamically so the package can compile before
 * `prisma generate` has produced `@prisma/client`. If the import fails we throw
 * rather than risk acknowledging non-durable writes.
 */
export async function createDistributorLinkRepository(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DistributorLinkRepository> {
  if (!env.DATABASE_URL?.trim()) {
    throw new Error('DATABASE_URL is required; runtime persistence cannot fall back to process memory.');
  }

  let PrismaClientCtor: new () => PrismaLinkClient;
  try {
    // Indirect specifier keeps bundlers/typecheck from requiring the generated
    // client to exist at build time; it only needs to resolve at runtime.
    const mod = (await import('@prisma/client' as string)) as { PrismaClient: new () => PrismaLinkClient };
    PrismaClientCtor = mod.PrismaClient;
  } catch (err) {
    throw new Error(
      `DATABASE_URL is set but @prisma/client is not available. Run "npm -w @sentinel/db run db:generate" (and db:migrate:deploy) before starting with a database. Cause: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const client = new PrismaClientCtor();
  return new PrismaDistributorLinkRepository(client);
}
