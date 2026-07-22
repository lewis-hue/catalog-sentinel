import { InMemoryDistributorLinkRepository } from '@sentinel/db';
import { InMemoryAuditLogger, type AuditLogger } from '@sentinel/security';
import { DistributorLinkService } from './distributor-link';
import { InMemoryConnectSessionRegistry } from './distributor-connect';

/**
 * Isolated test composition. Runtime entrypoints must inject durable implementations and may
 * never call this helper.
 */
export function createAppTestServices(auditLogger: AuditLogger = new InMemoryAuditLogger()): {
  auditLogger: AuditLogger;
  distributorLink: DistributorLinkService;
  connectSessionRegistry: InMemoryConnectSessionRegistry;
} {
  return {
    auditLogger,
    connectSessionRegistry: new InMemoryConnectSessionRegistry(),
    distributorLink: new DistributorLinkService(auditLogger, {
      repo: new InMemoryDistributorLinkRepository(),
      env: { NODE_ENV: 'test', BROWSER_LINK_PROVIDER: 'steel' },
    }),
  };
}
