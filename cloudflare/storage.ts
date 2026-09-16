import type { DurableObjectStorage } from '@cloudflare/workers-types';
import type { Records, Storage, Transaction } from '../src/core/index.js';

/** The KV API is backed by the object's SQLite database, not Workers KV. */
export class CloudflareStorage implements Storage {
  constructor(private readonly storage: DurableObjectStorage) {}

  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.storage.transaction(async (storage) =>
      work({
        get: async <K extends keyof Records>(kind: K, id: string) =>
          structuredClone(await storage.get<Records[K]>(`verity/${kind}/${id}`)),
        put: (kind, id, value) => storage.put(`verity/${kind}/${id}`, structuredClone(value)),
        delete: async (kind, id) => {
          await storage.delete(`verity/${kind}/${id}`);
        },
        list: async <K extends keyof Records>(kind: K) =>
          [...(await storage.list<Records[K]>({ prefix: `verity/${kind}/` })).values()].map(
            (value) => structuredClone(value),
          ),
      }),
    );
  }
}
