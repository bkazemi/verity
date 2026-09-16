import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubProvider } from '../src/server/github.js';

test('GitHub adapter sends PKCE and reads identity from authenticated provider API', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];

  const provider = githubProvider({
    clientId: 'client',
    clientSecret: 'private-secret',
    fetch: (async (url, init) => {
      calls.push({ url: String(url), init });

      return Response.json(
        calls.length === 1 ? { access_token: 'private-token' } : { id: 42, login: 'alice' },
      );
    }) as typeof fetch,
  });

  const url = new URL(
    provider.authorizationUrl({
      state: 'state',
      challenge: 'challenge',
      redirectUri: 'https://site.test/callback',
    }),
  );

  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), '');
  assert.equal(url.searchParams.has('client_secret'), false);

  assert.deepEqual(
    await provider.authenticate({
      code: 'code',
      verifier: 'verifier',
      redirectUri: 'https://site.test/callback',
    }),
    { id: '42', handle: 'alice', profileUrl: 'https://github.com/alice' },
  );

  assert.equal((calls[0]!.init!.body as URLSearchParams).get('code_verifier'), 'verifier');
  assert.equal(new Headers(calls[1]!.init!.headers).get('authorization'), 'Bearer private-token');
});

test('malformed provider identity and token errors fail closed', async () => {
  for (const value of [
    { error: 'bad_verification_code' },
    { id: 'not-a-stable-id', login: 'alice' },
    { id: 42, login: '<script>' },
  ]) {
    let calls = 0;

    const provider = githubProvider({
      clientId: 'client',
      clientSecret: 'secret',
      fetch: (async () =>
        Response.json(
          ++calls === 1 && !('error' in value) ? { access_token: 'token' } : value,
        )) as typeof fetch,
    });

    await assert.rejects(
      provider.authenticate({
        code: 'code',
        verifier: 'verifier',
        redirectUri: 'https://site.test/callback',
      }),
    );
  }
});
