import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { setTimeout } from 'node:timers/promises';
import { Pool, PostgresStorage } from '../src/postgres/index.js';
import { VerityService } from '../src/server/service.js';
import { fakeProvider } from './helpers.js';

test(
  'runnable example: installed exports, local login, public markup, OAuth entry and disconnect',
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const portServer = createServer().listen(0, '127.0.0.1');

    await once(portServer, 'listening');
    const address = portServer.address();

    assert.ok(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;

    await new Promise<void>((resolve) => portServer.close(() => resolve()));

    const namespace = `example-test-${randomUUID()}`,
      pool = new Pool({ connectionString: process.env.TEST_DATABASE_URL });

    const storage = new PostgresStorage(pool, namespace);

    await storage.migrate();
    const provider = fakeProvider();

    const service = new VerityService({
      storage,
      provider,
      baseUrl: `${origin}/api/verity`,
      siteName: 'Example',
      verifierName: 'Example',
      profileOrigins: [origin],
    });

    const local = {
      id: 'example-account-1',
      label: 'Alex Example',
      reference: 'example-member-1',
      profileUrl: `${origin}/profile`,
    };

    const flow = await service.start(local);

    await service.callback(
      new URL(flow.authorizationUrl).searchParams.get('state')!,
      flow.binding,
      'fixture-only',
    );

    const privateId = (await service.approve(flow.flowId, flow.binding, local, 'unlisted'))!;

    const child = spawn(process.execPath, ['--import', 'tsx', 'example/server.ts'], {
      env: {
        ...process.env,
        ORIGIN: origin,
        DATABASE_URL: process.env.TEST_DATABASE_URL,
        VERITY_NAMESPACE: namespace,
        GITHUB_CLIENT_ID: 'test-client',
        GITHUB_CLIENT_SECRET: 'test-provider-secret',
        EXAMPLE_PASSWORD: 'test-local-password',
      },
      stdio: 'pipe',
    });

    try {
      let ready = false;

      for (let i = 0; i < 100; i++) {
        try {
          if ((await fetch(origin)).ok) {
            ready = true;
            break;
          }
        } catch {
          /* Startup polling only. */
        }

        await setTimeout(50);
      }

      assert.ok(ready, 'Example starts with built package and database');
      assert.match(await (await fetch(origin)).text(), /Sign in to the example local account/);
      const profile = await (await fetch(`${origin}/profile`)).text();

      assert.ok(!profile.includes(privateId));
      assert.ok(!profile.includes('known-alice'));
      const asset = await (await fetch(`${origin}/assets/verity.js`)).text();

      assert.ok(asset.includes('verity-badge'));
      assert.ok(!asset.includes('test-provider-secret'));

      const login = await fetch(`${origin}/login`, {
        method: 'POST',
        headers: { origin },
        body: 'password=test-local-password',
        redirect: 'manual',
      });

      assert.equal(login.status, 303);
      const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

      assert.match(
        await (await fetch(origin, { headers: { cookie } })).text(),
        /Verify with GitHub/,
      );

      const mine = await (await fetch(`${origin}/api/verity/mine`, { headers: { cookie } })).json();

      assert.equal(mine[0].id, privateId);

      const start = await fetch(`${origin}/api/verity/sessions`, {
        method: 'POST',
        headers: { origin, cookie },
        body: 'kind=connect',
        redirect: 'manual',
      });

      assert.equal(start.status, 303);
      assert.equal(new URL(start.headers.get('location')!).hostname, 'github.com');

      const disconnect = await fetch(`${origin}/api/verity/connections/${privateId}/disconnect`, {
        method: 'POST',
        headers: { origin, cookie },
        body: '{}',
      });

      assert.equal(disconnect.status, 200);
      assert.equal((await service.read(privateId, local)).status, 'revoked');
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }

      await pool.query('DELETE FROM verity_records WHERE namespace=$1', [namespace]);
      await pool.end();
    }
  },
);
