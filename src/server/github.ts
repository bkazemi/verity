import type { Provider } from '../core/index.js';

/** GitHub.com OAuth app, PKCE S256, no additional scopes. Tokens are never persisted. */
export function githubProvider(options: {
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
}): Provider {
  if (!options.clientId || !options.clientSecret) throw new Error('GitHub credentials required');

  const request = options.fetch ?? fetch;

  return {
    id: 'github',
    name: 'GitHub',
    authorizationUrl({ state, challenge, redirectUri }) {
      const url = new URL('https://github.com/login/oauth/authorize');

      url.search = new URLSearchParams({
        client_id: options.clientId,
        redirect_uri: redirectUri,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        scope: '',
        prompt: 'select_account',
      }).toString();

      return url.href;
    },
    async authenticate({ code, verifier, redirectUri }) {
      const response = await request('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
        body: new URLSearchParams({
          client_id: options.clientId,
          client_secret: options.clientSecret,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
        }),
      });

      const token: unknown = await response.json();

      if (!response.ok || !isRecord(token) || typeof token.access_token !== 'string' || token.error)
        throw new Error('Provider authentication failed');

      const identity = await request('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'Verity-V0',
        },
        signal: AbortSignal.timeout(15000),
      });

      const user: unknown = await identity.json();

      if (
        !identity.ok ||
        !isRecord(user) ||
        !Number.isSafeInteger(user.id) ||
        Number(user.id) <= 0 ||
        typeof user.login !== 'string' ||
        !/^[a-zA-Z0-9-]+$/.test(user.login)
      )
        throw new Error('Invalid provider identity');

      return {
        id: String(user.id),
        handle: user.login,
        profileUrl: `https://github.com/${user.login}`,
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
