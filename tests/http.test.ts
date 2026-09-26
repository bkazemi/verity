import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerity } from '../src/server/index.js';
import {
  alice,
  bob,
  fakeArtifactProvider,
  fakeDocumentProvider,
  fakeProvider,
  MemoryStorage,
} from './helpers.js';

function fixture(provider = fakeProvider() as Parameters<typeof createVerity>[0]['provider']) {
  const app = createVerity({
    storage: new MemoryStorage(),
    provider,
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
      external: [
        {
          by: 'provider',
          method: 'attestation',
          artifactUrl: 'javascript:alert(1)',
          confirmedAt: 2,
        },
      ],
    };

    await tx.put('connections', id, stored);
  });

  const hostile = await (await f.request(`/connections/${id}`)).text();

  assert.match(hostile, /Published a proof on GitHub/);
  assert.ok(!hostile.includes('javascript:'));
  assert.ok(!hostile.includes('View the proof'));
});

test('a holder-paced proof is published here, submitted here, and approved here', async () => {
  const provider = fakeArtifactProvider();
  const f = fixture(provider);

  // No redirect away: the flow stays on this origin while the holder publishes.
  const start = await f.request('/sessions?kind=connect', { headers: { cookie: 'local=alice' } });

  assert.equal(start.status, 303);
  const location = start.headers.get('location')!;

  assert.match(location, /^\/api\/verity\/flows\//);
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const path = location.replace('/api/verity', '');

  const waiting = await f.request(path, { headers: { cookie: `${cookie}; local=alice` } });
  const body = await waiting.text();

  assert.match(body, /Publish this line/);
  assert.match(body, /Verity proof for Site: /);
  assert.match(body, /name="artifact"/);

  // Another local account cannot watch someone else's flow.
  const stranger = await f.request(path, { headers: { cookie: `${cookie}; local=bob` } });

  assert.equal(stranger.status, 404);

  const expect = body.match(/<code>([^<]+)<\/code>/)![1]!;
  const url = 'https://notes.test/alice/1';

  provider.artifacts.set(url, expect);

  const submitted = await f.request(`${path}/submit`, {
    method: 'POST',
    headers: {
      origin: 'https://site.test',
      cookie: `${cookie}; local=alice`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: `artifact=${encodeURIComponent(url)}`,
  });

  assert.equal(submitted.status, 303);

  const review = await f.request(path, { headers: { cookie: `${cookie}; local=alice` } });

  assert.match(await review.text(), /value="unlisted" checked/);

  const approved = await f.request(`${path}/approve`, {
    method: 'POST',
    headers: { origin: 'https://site.test', cookie: `${cookie}; local=alice` },
    body: 'visibility=public&action=approve',
  });

  assert.equal(approved.status, 200);
  const evidence = (await f.app.service.mine(alice))[0]!;

  assert.equal(evidence.attestations!.external[0].artifactUrl, url);
  assert.equal(evidence.attestations!.external[0].method, 'attestation');

  // The published proof is offered to the reader on the evidence page.
  const page = await (await f.request(`/connections/${evidence.id}`)).text();

  assert.match(page, /Published a proof on Notes/);
  assert.match(page, /View the proof/);
  assert.ok(page.includes(url));
});

test('a refused proof says why on the result page, and any other failure does not', async () => {
  const provider = fakeArtifactProvider();
  const f = fixture(provider);

  async function submit(artifact: string) {
    const start = await f.request('/sessions?kind=connect', { headers: { cookie: 'local=alice' } });
    const cookie = `${start.headers.get('set-cookie')!.split(';')[0]!}; local=alice`;
    const path = start.headers.get('location')!.replace('/api/verity', '');

    await f.request(`${path}/submit`, {
      method: 'POST',
      headers: {
        origin: 'https://site.test',
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: `artifact=${encodeURIComponent(artifact)}`,
    });

    return (await f.request(path, { headers: { cookie } })).text();
  }

  const refused = await submit('https://notes.test/alice/1');

  assert.match(refused, /<p>failed<\/p><p>Line not found\.<\/p>/);

  const broken = await submit('https://evil.test/alice');

  assert.match(broken, /<p>failed<\/p><div/);
  assert.doesNotMatch(broken, /Not a notes address/);
});

test('several methods are offered one by one, and a second one joins the record', async () => {
  const oauth = fakeProvider();
  const notes = { ...fakeArtifactProvider(), id: 'github', name: 'GitHub' };
  const f = fixture([oauth, notes]);

  const choice = await (
    await f.request('/verify?provider=github', { headers: { cookie: 'local=alice' } })
  ).text();

  assert.match(choice, /Sign in with GitHub/);
  assert.match(choice, /Publish a proof on GitHub/);
  assert.match(choice, /name="method" value="attestation"/);

  const id = await f.connect('public');

  // The same account, shown the other way.
  const start = await f.request('/sessions?kind=connect&provider=github&method=attestation', {
    headers: { cookie: 'local=alice' },
  });

  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const path = start.headers.get('location')!.replace('/api/verity', '');

  const waiting = await (
    await f.request(path, { headers: { cookie: `${cookie}; local=alice` } })
  ).text();

  const url = 'https://notes.test/alice/1';

  notes.artifacts.set(url, waiting.match(/<code>([^<]+)<\/code>/)![1]!);

  await f.request(`${path}/submit`, {
    method: 'POST',
    headers: {
      origin: 'https://site.test',
      cookie: `${cookie}; local=alice`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: `artifact=${encodeURIComponent(url)}`,
  });

  const review = await (
    await f.request(path, { headers: { cookie: `${cookie}; local=alice` } })
  ).text();

  assert.match(review, /Add to connection/);
  assert.match(review, /stays public/);
  assert.ok(!review.includes('value="unlisted" checked'));

  await f.request(`${path}/approve`, {
    method: 'POST',
    headers: { origin: 'https://site.test', cookie: `${cookie}; local=alice` },
    body: 'visibility=unlisted&action=approve',
  });

  const page = await (await f.request(`/connections/${id}`)).text();

  assert.match(
    page,
    /Signed in with GitHub<\/p><p class="how additional">\+ Published a proof on GitHub<\/p><p class="how additional"><a/,
  );

  assert.equal((await f.app.service.mine(alice)).length, 1);
});

test('a proof handed over is taken as text, published here, and served as text', async () => {
  const provider = fakeDocumentProvider();
  const f = fixture(provider);

  const start = await f.request('/sessions?kind=connect', { headers: { cookie: 'local=alice' } });
  const cookie = start.headers.get('set-cookie')!.split(';')[0]!;
  const path = start.headers.get('location')!.replace('/api/verity', '');

  const body = await (
    await f.request(path, { headers: { cookie: `${cookie}; local=alice` } })
  ).text();

  // Nowhere to publish and no address to give back, so the page takes the proof itself.
  assert.match(body, /name="artifact"/);
  assert.match(body, /<textarea/);
  assert.ok(!body.includes('type="url"'));

  // What the holder has to reproduce exactly is set as a block, never as prose.
  assert.match(body, /<pre><code>/);

  // The copy button is made by that script, so a reader without it sees no dead control.
  assert.match(body, /\/copy\.js"/);
  assert.ok(!body.includes('class="copy"'));

  const script = await f.request('/copy.js');

  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-type'), 'text/javascript');
  assert.match(await script.text(), /clipboard/);

  // The sheet's address carries its version, so a release never renders in an old one.
  assert.match(body, /\/style\.css\?v=[a-z0-9]+"/);

  const expect = body.match(/<code>([^<]+)<\/code>/)![1]!;
  const proof = `-----BEGIN SOMETHING-----\n${expect}\n-----END SOMETHING-----`;

  const submitted = await f.request(`${path}/submit`, {
    method: 'POST',
    headers: {
      origin: 'https://site.test',
      cookie: `${cookie}; local=alice`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: `artifact=${encodeURIComponent(proof)}`,
  });

  assert.equal(submitted.status, 303);

  await f.request(`${path}/approve`, {
    method: 'POST',
    headers: { origin: 'https://site.test', cookie: `${cookie}; local=alice` },
    body: 'visibility=public&action=approve',
  });

  const evidence = (await f.app.service.mine(alice))[0]!;
  const at = `/connections/${evidence.id}/proof`;

  assert.equal(evidence.attestations!.external[0].artifactUrl, `https://site.test/api/verity${at}`);
  assert.equal(evidence.attestations!.external[0].hosted, true);

  const served = await f.request(at);

  // Served as the bytes it is, so a reader can put it into their own tools unchanged.
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(await served.text(), proof);

  // The evidence page points a reader at it rather than describing what it said.
  const page = await (await f.request(`/connections/${evidence.id}`)).text();

  assert.match(page, /Proved with a signature/);
  assert.match(page, /View the proof/);

  // A key is named by what it is. The @ that marks a handle would claim there is an
  // account behind it, issued by somebody who could also hand it to somebody else.
  assert.match(page, /AAAA BBBB/);
  assert.ok(!page.includes('@AAAA'));

  // A connection with no proof of its own has nothing to serve under that address.
  const missing = await f.request('/connections/nonexistent/proof');

  assert.equal(missing.status, 404);
});
