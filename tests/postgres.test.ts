import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool, PostgresStorage } from '../src/postgres/index.js';
import { VerityService } from '../src/server/service.js';
import { alice, fakeProvider } from './helpers.js';

test(
  'real Postgres: rollback, namespace isolation, persistence and concurrent share rotation',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL }),
      namespace = `test-${randomUUID()}`;

    const storage = new PostgresStorage(pool, namespace),
      other = new PostgresStorage(pool, `${namespace}-other`);

    try {
      await storage.migrate();

      await assert.rejects(
        storage.transaction(async (tx) => {
          await tx.put('audit', 'rollback', {
            id: 'rollback',
            action: 'test',
            actor: 'local',
            at: 0,
          });

          throw new Error('rollback');
        }),
      );

      assert.equal(await storage.transaction((tx) => tx.get('audit', 'rollback')), undefined);

      const options = {
        storage,
        providers: [fakeProvider()],
        baseUrl: 'https://site.test/api/verity',
        siteName: 'Site',
        verifierName: 'Site',
        profileOrigins: ['https://site.test'],
      };

      const service = new VerityService(options),
        flow = await service.start(alice);

      await service.callback(
        new URL(flow.authorizationUrl!).searchParams.get('state')!,
        flow.binding,
        'code',
      );

      const approvals = await Promise.all(
        [1, 2].map(() => service.approve(flow.flowId, flow.binding, alice, 'unlisted')),
      );

      assert.equal(approvals[0], approvals[1]);
      const id = approvals[0]!;

      assert.equal(await other.transaction((tx) => tx.get('connections', id)), undefined);

      const restarted = new VerityService({
        ...options,
        storage: new PostgresStorage(pool, namespace),
      });

      assert.equal((await restarted.read(id, alice)).status, 'verified');
      const shares = await Promise.all(Array.from({ length: 8 }, () => restarted.share(id, alice)));

      const outcomes = await Promise.allSettled(
        shares.map((s) => service.shared(s!.url.split('/').at(-1)!)),
      );

      assert.equal(outcomes.filter((o) => o.status === 'fulfilled').length, 1);
      await service.revoke(id, alice);

      for (const share of shares)
        await assert.rejects(restarted.shared(share!.url.split('/').at(-1)!));
    } finally {
      await pool.query('DELETE FROM verity_records WHERE namespace=$1 OR namespace=$2', [
        namespace,
        `${namespace}-other`,
      ]);

      await pool.end();
    }
  },
);

test(
  'real Postgres: workers starting together on a new database all create the table',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    // A schema of its own, so the table is new here whatever else has run on this database.
    const schema = `migrate_${randomUUID().replaceAll('-', '')}`,
      admin = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

    await admin.query(`CREATE SCHEMA ${schema}`);

    const pools = Array.from(
      { length: 8 },
      () =>
        new Pool({
          connectionString: process.env.TEST_DATABASE_URL,
          options: `-c search_path=${schema}`,
        }),
    );

    try {
      await Promise.all(pools.map((pool) => new PostgresStorage(pool).migrate()));
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
