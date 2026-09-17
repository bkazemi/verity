import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerity } from '../src/server/index.js';
import { alice, bob, fakeProvider, MemoryStorage } from './helpers.js';

function fixture() {
  const app = createVerity({
    storage: new MemoryStorage(),
    provider: fakeProvider(),
    baseUrl: 'https://site.test/api/verity',
    siteName: 'Site',
    verifierName: 'Self-hosted Site',
    profileOrigins: ['https://site.test'],
    reportUrl: 'mailto:reports@site.test',
    authenticate: async (r) =>
      r.headers.get('cookie')?.includes('local=alice')
        ? alice
        : r.headers.get('cookie')?.includes('local=bob')
          ? bob
          : undefined,
  });

  const request = (path: string, options: RequestInit = {}) =>
    app.handle(new Request(`https://site.test/api/verity${path}`, options));

  async function connect(visibility = 'unlisted') {
    const start = await request('/sessions', {
      method: 'POST',
      headers: { origin: 'https://site.test', cookie: 'local=alice' },
      body: 'kind=connect',
    });

    assert.equal(start.status, 303);
    const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
    const state = new URL(start.headers.get('location')!).searchParams.get('state')!;
    const callback = await request(`/callback?state=${state}&code=ok`, { headers: { cookie } });
    const path = callback.headers.get('location')!.replace('/api/verity', '');
    const review = await request(path, { headers: { cookie: `${cookie}; local=alice` } });

    assert.match(await review.text(), /value="unlisted" checked/);

    const approve = await request(`${path}/approve`, {
      method: 'POST',
      headers: { origin: 'https://site.test', cookie: `${cookie}; local=alice` },
      body: `visibility=${visibility}&action=approve&localId=attacker&verified=true`,
    });

    assert.equal(approve.status, 200);
    const id = (await app.service.mine(alice))[0]!.id;

    return id;
  }

  return { app, request, connect };
}

test('HTTP full flow and visibility across HTML/JSON, generic secret failures and security headers', async () => {
  const f = fixture(),
    id = await f.connect();

  const expected = await (await f.request('/s/missing')).text();

  for (const path of [
    `/connections/${id}`,
    `/connections/${id}?format=json`,
    `/connections/${id}/badge`,
    '/s/invalid',
  ]) {
    const response = await f.request(path, { headers: { cookie: 'local=alice' } });

    assert.equal(response.status, 404);
    assert.equal(await response.text(), expected);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  }

  const share = (await f.app.service.share(id, alice))!;
  const response = await f.request(share.url.replace('https://site.test/api/verity', ''));

  assert.equal(response.status, 200);
  assert.match(await response.text(), /Anyone with this link/);
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
  const token = share.url.split('/').at(-1)!;

  assert.equal(
    (
      await f.request(`/connections/${id}/disconnect`, {
        method: 'POST',
        headers: { origin: 'https://site.test', Authorization: `Bearer ${token}` },
        body: '{}',
      })
    ).status,
    404,
  );

  await f.app.service.revoke(id, alice);
  assert.equal(await (await f.request(`/s/${token}`)).text(), expected);
});

test('forged origins, missing local authentication, and cross-account mutations fail', async () => {
  const f = fixture(),
    id = await f.connect('public');

  for (const origin of [undefined, 'https://evil.test', 'null']) {
    const response = await f.request(`/connections/${id}/disconnect`, {
      method: 'POST',
      headers: { cookie: 'local=alice', ...(origin ? { origin } : {}) },
      body: '{}',
    });

    assert.equal(response.status, 404);
  }

  for (const cookie of ['', 'local=bob'])
    assert.equal(
      (
        await f.request(`/connections/${id}/disconnect`, {
          method: 'POST',
          headers: { origin: 'https://site.test', cookie },
          body: '{}',
        })
      ).status,
      404,
    );

  assert.equal(
    (
      await f.request('/connect', {
        method: 'POST',
        headers: { origin: 'https://site.test', 'content-type': 'application/json' },
        body: '{"provider":"github","localId":"private-local-1"}',
      })
    ).status,
    404,
  );

  const evidence = await (await f.request(`/connections/${id}?format=json`)).json();

  assert.equal(evidence.status, 'verified');
  assert.equal(evidence.verifierName, 'Self-hosted Site');
  assert.ok(!JSON.stringify(evidence).includes('private-local-1'));
});

test('static sites can read public evidence across origins without gaining management or sharing access', async () => {
  const f = fixture(),
    id = await f.connect('public');

  const headers = { origin: 'https://other.test', cookie: 'local=alice' };

  const response = await f.request(`/connections/${id}?format=json`, { headers });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-credentials'), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).status, 'verified');

  for (const path of ['/mine', `/manage/${id}`, `/connections/${id}`]) {
    const result = await f.request(path, { headers });

    assert.equal(result.headers.get('access-control-allow-origin'), null);
  }

  const mutation = await f.request(`/connections/${id}/disconnect`, {
    method: 'POST',
    headers,
    body: '{}',
  });

  assert.equal(mutation.status, 404);
  assert.equal(mutation.headers.get('access-control-allow-origin'), null);
  assert.equal((await f.app.service.read(id)).status, 'verified');

  await f.app.service.revoke(id, alice);
  const revoked = await f.request(`/connections/${id}?format=json`, { headers });

  assert.equal(revoked.headers.get('access-control-allow-origin'), '*');
  assert.equal((await revoked.json()).status, 'revoked');

  const privateFixture = fixture(),
    privateId = await privateFixture.connect(),
    share = (await privateFixture.app.service.share(privateId, alice))!;

  for (const path of [
    `/connections/${privateId}?format=json`,
    '/connections/missing?format=json',
    `/s/${share.url.split('/').at(-1)}?format=json`,
  ]) {
    const result = await privateFixture.request(path, { headers });

    assert.equal(result.headers.get('access-control-allow-origin'), null);

    if (path.startsWith('/connections/')) assert.equal(result.status, 404);
  }
});

test('the evidence page names how each side was established, without ranking them', async () => {
  const f = fixture(),
    id = await f.connect('public');

  const body = await (await f.request(`/connections/${id}`)).text();

  // Each side is described next to that side, so neither reads as a note on the other.
  assert.match(body, /Stated by Site/);
  assert.match(body, /Signed in with GitHub/);
  // Nothing outside a provider's own lines may name that provider.
  assert.ok(!/GitHub[^<]*approved/.test(body));

  // The old sentence assigned one method to both sides and named neither.
  assert.ok(!body.includes('proved control of it with'));
  assert.ok(!body.includes('does not check'));

  // No artifact exists for oauth, so nothing invites the reader to open one.
  assert.ok(!body.includes('View the proof'));

  // An artifact url reaches an href only after it is confirmed http(s).
  await f.app.service.options.storage.transaction(async (tx) => {
    const stored = (await tx.get('connections', id))!;

    stored.attestations = {
      local: { by: 'backend', method: 'declared', confirmedAt: 1 },
      external: {
        by: 'provider',
        method: 'attestation',
        artifactUrl: 'javascript:alert(1)',
        confirmedAt: 2,
      },
    };

    await tx.put('connections', id, stored);
  });

  const hostile = await (await f.request(`/connections/${id}`)).text();

  assert.match(hostile, /Published a proof on GitHub/);
  assert.ok(!hostile.includes('javascript:'));
  assert.ok(!hostile.includes('View the proof'));
});
