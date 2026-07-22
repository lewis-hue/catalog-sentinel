import type { ObjectStore, StoredObject } from './object-store';

/** Process-local object storage for isolated automated tests only. */
export class InMemoryObjectStore implements ObjectStore {
  readonly provider = 'test-memory';
  readonly objects = new Map<string, Buffer>();

  async put(key: string, content: string | Buffer): Promise<StoredObject> {
    const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    this.objects.set(key, buffer);
    return { ref: `test-memory://${key}`, byteSize: buffer.byteLength };
  }

  /** Fetch stored content by the ref returned from put(), or null if absent. */
  getByRef(ref: string): Buffer | null {
    return this.objects.get(ref.replace(/^test-memory:\/\//, '')) ?? null;
  }
}
