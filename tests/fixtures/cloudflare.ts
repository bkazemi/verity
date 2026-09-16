import type { DurableObjectState } from '@cloudflare/workers-types';
import { CloudflareStorage } from '../../cloudflare/storage.js';

export { default, VerityStore } from '../../cloudflare/worker.js';

/** Test-only entry point; never included in the deployment bundle. */
export class StorageProbe {
  constructor(private readonly ctx: DurableObjectState) {}

  async fetch(request: Request) {
    const storage = new CloudflareStorage(this.ctx.storage);
    const path = new URL(request.url).pathname;

    if (path === '/rollback') {
      try {
        await storage.transaction(async (tx) => {
          await tx.put('audit', 'rollback', {
            id: 'rollback',
            action: 'test',
            actor: 'local',
            at: 0,
          });

          throw new Error('Expected rollback');
        });
      } catch {
        // Check persisted state in a new transaction below.
      }

      return Response.json(
        await storage.transaction(async (tx) => !(await tx.get('audit', 'rollback'))),
      );
    }

    if (path === '/increment') {
      const count = await storage.transaction(async (tx) => {
        const record = await tx.get('audit', 'counter');
        const at = (record?.at ?? 0) + 1;

        await tx.put('audit', 'counter', { id: 'counter', action: 'test', actor: 'local', at });

        return at;
      });

      return Response.json(count);
    }

    if (path === '/detached') {
      await storage.transaction(async (tx) => {
        const record = (await tx.get('audit', 'counter'))!;

        record.at = -1;
      });
    }

    return Response.json(await storage.transaction((tx) => tx.list('audit')));
  }
}
