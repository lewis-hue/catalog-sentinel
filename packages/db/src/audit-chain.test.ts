import { describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync, sign, verify } from 'node:crypto';
import {
  AuditChainAnchorPublisher,
  auditAnchorPayload,
  verifyAnchoredAuditExport,
  verifyAuditChain,
  type AuditAnchorRecord,
  type AuditChainRecord,
} from './audit-chain';

function record(sequence: bigint, previousHash: string, overrides: Partial<AuditChainRecord> = {}): AuditChainRecord {
  const id = `event-${sequence}`;
  const payload = JSON.stringify({
    action: 'catalog.read', actorUserId: 'subject', canonicalVersion: 1, id,
    metadata: {}, occurredAt: '2026-07-22T00:00:00.000Z', targetId: null,
    targetType: 'catalog', tenantId: 'tenant-a', workspaceId: null,
  });
  const eventHash = createHash('sha256').update(`${previousHash}\n${payload}`).digest('hex');
  return {
    id,
    occurredAt: '2026-07-22T00:00:00.000Z',
    tenantId: 'tenant-a',
    workspaceId: null,
    actorUserId: 'subject',
    action: 'catalog.read',
    targetType: 'catalog',
    targetId: null,
    metadata: {},
    chainSequence: sequence,
    previousHash,
    eventHash,
    canonicalPayload: payload,
    canonicalVersion: 1,
    ...overrides,
  };
}

describe('audit chain verification', () => {
  it('verifies a complete chain and detects payload, sequence, and predecessor tampering', () => {
    const first = record(1n, '');
    const second = record(2n, first.eventHash);
    expect(verifyAuditChain([first, second])).toMatchObject({ valid: true, verifiedEvents: 2, finalHash: second.eventHash });
    expect(verifyAuditChain([{ ...first, canonicalPayload: `${first.canonicalPayload} ` }, second]).valid).toBe(false);
    expect(verifyAuditChain([{ ...first, chainSequence: 2n }]).error).toMatch(/Expected sequence/);
    expect(verifyAuditChain([{ ...first, previousHash: '0'.repeat(64) }]).error).toMatch(/Previous hash/);
  });

  it('verifies a page from an independently trusted predecessor', () => {
    const first = record(10n, 'a'.repeat(64));
    expect(verifyAuditChain([first], { sequence: 9n, hash: 'a'.repeat(64) }).valid).toBe(true);
  });

  it('uses an unambiguous versioned anchor payload', () => {
    expect(auditAnchorPayload('tenant-a', 42n, 'f'.repeat(64))).toBe(
      `sentinel-audit-anchor-v1\ntenant-a\n42\n${'f'.repeat(64)}`,
    );
  });

  it('verifies the export against an actual asymmetric signature', async () => {
    const first = record(1n, '');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const payload = Buffer.from(auditAnchorPayload(first.tenantId, first.chainSequence, first.eventHash));
    const signature = sign(null, payload, privateKey).toString('base64');
    const anchor: AuditAnchorRecord = {
      id: 'anchor-1', tenantId: first.tenantId, chainSequence: first.chainSequence,
      eventHash: first.eventHash, signerKeyId: 'test-ed25519', signature,
      externalRef: 'immutable:test', anchoredAt: '2026-07-22T00:00:01.000Z',
    };
    const verifier = {
      verify: async (input: { keyId: string; payload: Uint8Array; signature: string }) =>
        input.keyId === 'test-ed25519' && verify(null, input.payload, publicKey, Buffer.from(input.signature, 'base64')),
    };
    expect((await verifyAnchoredAuditExport([first], anchor, verifier)).valid).toBe(true);
    expect((await verifyAnchoredAuditExport([first], { ...anchor, eventHash: '0'.repeat(64) }, verifier)).valid).toBe(false);
  });

  it('reuses the durable signature after S3 succeeds but database finalization fails', async () => {
    const eventHash = 'f'.repeat(64);
    let pending: {
      tenantId: string; chainSequence: string; eventHash: string; payload: string;
      signerKeyId: string; signature: string;
    } | undefined;
    let persisted: Record<string, unknown> | undefined;
    let failFinalization = true;
    let headSequence = '7';
    const query = async (sql: string, values: readonly unknown[] = []) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [{}] };
      if (sql.includes('SELECT EXISTS (')) return { rows: [{ frozen: false }] };
      if (sql.includes('INSERT INTO audit_chain_anchors')) {
        if (failFinalization) {
          failFinalization = false;
          throw new Error('simulated commit-path outage');
        }
        persisted = {
          id: values[0], tenantId: values[1], chainSequence: values[2], eventHash: values[3],
          signerKeyId: values[4], signature: values[5], externalRef: values[6],
          anchoredAt: '2026-07-23T00:00:00.000Z',
        };
        pending = undefined;
        return { rows: [persisted] };
      }
      if (sql.includes('SELECT "last_sequence" AS sequence')) {
        return { rows: [{ sequence: headSequence, eventHash: headSequence === '7' ? eventHash : 'e'.repeat(64) }] };
      }
      if (sql.includes('FROM audit_chain_anchors WHERE tenant_id')) {
        return { rows: persisted ? [persisted] : [] };
      }
      if (sql.includes('SELECT 1 FROM security_audit_events')) return { rows: [{}], rowCount: 1 };
      if (sql.includes('INSERT INTO audit_anchor_outbox')) {
        pending = {
          tenantId: String(values[0]), chainSequence: String(values[1]), eventHash: String(values[2]),
          payload: String(values[3]), signerKeyId: String(values[4]), signature: String(values[5]),
        };
        return { rows: [pending] };
      }
      if (sql.includes('FROM audit_anchor_outbox WHERE')) return { rows: pending ? [pending] : [] };
      if (sql.includes('DELETE FROM audit_anchor_outbox')) {
        pending = undefined;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`Unexpected audit publisher SQL: ${sql}`);
    };
    const pool = {
      async connect() { return { query: query as never, release() {} }; },
    };
    let signerCalls = 0;
    const signer = {
      async sign() {
        signerCalls += 1;
        return { keyId: 'kms-signing-key', signature: `nondeterministic-signature-${signerCalls}` };
      },
    };
    const storedSignatures: string[] = [];
    const immutableStore = {
      async put(input: { signature: string }) {
        storedSignatures.push(input.signature);
        return { immutableRef: 's3://sentinel-audit/tenant-a/7.json?versionId=immutable-version' };
      },
    };
    const publisher = new AuditChainAnchorPublisher(pool, signer, immutableStore);

    await expect(publisher.anchorLatest('tenant-a')).rejects.toThrow('simulated commit-path outage');
    headSequence = '8';
    await expect(publisher.anchorLatest('tenant-a')).resolves.toMatchObject({
      tenantId: 'tenant-a', chainSequence: 7n, signature: 'nondeterministic-signature-1',
    });
    expect(signerCalls).toBe(1);
    expect(storedSignatures).toEqual(['nondeterministic-signature-1', 'nondeterministic-signature-1']);
  });
});
