import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions, Response as WorkerResponse } from 'miniflare';

test('Cloudflare SQLite transactions, persistent owner sessions, OAuth, public embeds and revocation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'verity-cloudflare-'));
  const scriptPath = join(directory, 'worker.mjs');
  const origin = 'https://verifier.test';
  const ownerKey = 'a'.repeat(43);
  let providerCalls = 0;

  await build({
    entryPoints: ['tests/fixtures/cloudflare.ts'],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    external: ['node:*'],
    outfile: scriptPath,
  });

  const options = {
    name: 'verity-test',
    rootPath: directory,
    modules: true,
    scriptPath,
    compatibilityDate: '2026-07-01',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: {
      VERITY: { className: 'VerityStore', useSQLite: true },
      PROBE: { className: 'StorageProbe', useSQLite: true },
    },
    bindings: {
      PUBLIC_ORIGIN: origin,
      SITE_NAME: 'Site',
      OWNER_LABEL: 'Site author',
      OWNER_REFERENCE: 'site.test author',
      OWNER_PROFILE_URL: 'https://site.test/about/',
      REPORT_URL: 'mailto:owner@site.test',
      OWNER_KEY: ownerKey,
      GITHUB_CLIENT_ID: 'test-client',
      GITHUB_CLIENT_SECRET: 'test-secret',
    },
    outboundService: async (request: { url: string; text(): Promise<string> }) => {
      if (request.url === 'https://github.com/login/oauth/access_token') {
        const body = new URLSearchParams(await request.text());

        assert.equal(body.get('client_secret'), 'test-secret');
        assert.ok(body.get('code_verifier'));
        providerCalls++;

        return WorkerResponse.json({ access_token: 'provider-secret' });
      }

      if (request.url === 'https://api.github.com/user')
        return WorkerResponse.json({ id: 123, login: 'octocat' });

      throw new Error(`Unexpected outbound URL: ${new URL(request.url).origin}`);
    },
  };

  let mf = new Miniflare({
    ...convertV4MiniflareOptions(options),
    resourcePersistencePath: join(directory, 'data'),
  });

  const request = (path: string, init: Parameters<typeof mf.dispatchFetch>[1] = {}) =>
    mf.dispatchFetch(`${origin}${path}`, { ...init, redirect: 'manual' });

  const post = (path: string, body: string, cookie = '') =>
    request(path, { method: 'POST', headers: { origin, cookie }, body });

  try {
    const namespace = await mf.getDurableObjectNamespace('PROBE');
    const probe = namespace.get(namespace.idFromName('one'));

    assert.equal(await (await probe.fetch('https://probe/rollback')).json(), true);

    const counts = await Promise.all(
      Array.from({ length: 20 }, async () => (await probe.fetch('https://probe/increment')).json()),
    );

    assert.equal(new Set(counts).size, 20);
    assert.ok(counts.includes(20));

    const detached = (await (await probe.fetch('https://probe/detached')).json()) as {
      at: number;
    }[];

    assert.equal(detached[0]!.at, 20);

    assert.deepEqual(
      await (await namespace.get(namespace.idFromName('two')).fetch('https://probe/list')).json(),
      [],
    );

    assert.equal((await request('/api/verity/mine')).status, 404);
    assert.match(await (await request('/')).text(), /Owner sign in/);
    assert.equal((await post('/login', 'key=wrong')).status, 403);
    assert.equal((await post('/login', 'x'.repeat(8193))).status, 413);

    assert.equal(
      (await request('/login', { method: 'POST', body: `key=${ownerKey}` })).status,
      303,
    );

    assert.equal((await mf.dispatchFetch('https://attacker.test/')).status, 404);

    const login = await post('/login', `key=${ownerKey}`);

    assert.equal(login.status, 303);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;

    assert.match(login.headers.get('set-cookie')!, /verity_owner=.*HttpOnly; Secure; SameSite=Lax/);
    assert.match(await (await request('/', { headers: { cookie } })).text(), /Verify with GitHub/);
    await mf.dispose();

    mf = new Miniflare({
      ...convertV4MiniflareOptions(options),
      resourcePersistencePath: join(directory, 'data'),
    });

    const settings = await request('/', { headers: { cookie } });

    assert.match(await settings.text(), /Verify with GitHub/);

    const start = await post('/api/verity/sessions', 'kind=connect', cookie);

    assert.equal(start.status, 303);

    const noOriginStart = await request('/api/verity/sessions', {
      method: 'POST',
      headers: { cookie },
      body: 'kind=connect',
    });

    assert.equal(noOriginStart.status, 303);

    const nullOriginStart = await request('/api/verity/sessions', {
      method: 'POST',
      headers: { cookie, origin: 'null' },
      body: 'kind=connect',
    });

    assert.equal(nullOriginStart.status, 303);
    const flowCookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callbackPath = `/api/verity/callback?state=${state}&code=fixture`;
    const callback = await request(callbackPath, { headers: { cookie: flowCookie } });

    assert.equal(callback.status, 303);
    assert.equal(providerCalls, 1);
    assert.equal((await request(callbackPath, { headers: { cookie: flowCookie } })).status, 404);
    const flowPath = callback.headers.get('location')!;
    const approvalCookie = `${cookie}; ${flowCookie}`;

    const approvals = await Promise.all(
      [1, 2].map(() =>
        post(`${flowPath}/approve`, 'action=approve&visibility=public', approvalCookie),
      ),
    );

    assert.ok(approvals.every((r) => r.status === 200));

    const records = (await (await request('/api/verity/mine', { headers: { cookie } })).json()) as {
      id: string;
    }[];

    assert.equal(records.length, 1);
    const id = records[0]!.id;
    const evidencePath = `/api/verity/connections/${id}?format=json`;
    const evidence = await request(evidencePath, { headers: { origin: 'https://site.test' } });

    assert.equal(evidence.headers.get('access-control-allow-origin'), '*');
    assert.equal(evidence.headers.get('access-control-allow-credentials'), null);
    const publicBody = await evidence.text();

    assert.match(publicBody, /"status":"verified"/);
    assert.ok(!publicBody.includes('provider-secret'));
    assert.ok(!publicBody.includes('site-owner'));
    assert.match(await (await request('/', { headers: { cookie } })).text(), /&lt;verity-badge/);

    assert.equal(
      (
        await request(`/api/verity/connections/${id}/disconnect`, {
          method: 'POST',
          headers: { cookie, origin: 'https://site.test' },
          body: '',
        })
      ).status,
      403,
    );

    await mf.dispose();

    mf = new Miniflare({
      ...convertV4MiniflareOptions(options),
      resourcePersistencePath: join(directory, 'data'),
    });

    assert.match(await (await request(evidencePath)).text(), /"status":"verified"/);
    assert.equal((await post(`/api/verity/connections/${id}/disconnect`, '', cookie)).status, 200);
    assert.match(await (await request(evidencePath)).text(), /"status":"revoked"/);
    const logout = await request('/logout', { method: 'POST', headers: { cookie }, body: '' });

    assert.equal(logout.status, 303);
    assert.match(logout.headers.get('set-cookie')!, /Max-Age=0/);
    assert.equal((await request('/api/verity/mine', { headers: { cookie } })).status, 404);

    const secondLogin = await post('/login', `key=${ownerKey}`);
    const secondCookie = secondLogin.headers.get('set-cookie')!.split(';')[0]!;

    assert.equal(
      (await request('/api/verity/mine', { headers: { cookie: secondCookie } })).status,
      200,
    );

    await mf.dispose();

    const rotatedOptions = {
      ...options,
      bindings: { ...options.bindings, OWNER_KEY: 'b'.repeat(43) },
    };

    mf = new Miniflare({
      ...convertV4MiniflareOptions(rotatedOptions),
      resourcePersistencePath: join(directory, 'data'),
    });

    assert.equal(
      (await request('/api/verity/mine', { headers: { cookie: secondCookie } })).status,
      404,
    );

    // The throttle survives isolate restarts along with sessions and evidence.
    for (let i = 0; i < 10; i++) assert.equal((await post('/login', 'key=wrong')).status, 403);

    await mf.dispose();

    mf = new Miniflare({
      ...convertV4MiniflareOptions(options),
      resourcePersistencePath: join(directory, 'data'),
    });

    assert.equal((await post('/login', 'key=wrong')).status, 429);
  } finally {
    await mf.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
