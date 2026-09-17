import type { DurableObjectNamespace, DurableObjectState } from '@cloudflare/workers-types';
import { externalName, localSide, statusLabel, type Evidence } from '../src/core/index.js';
import { logo } from '../src/server/logo.js';
import { styleVersion } from '../src/server/style.js';
import { createVerity, githubProvider } from '../src/server/index.js';
import { CloudflareStorage } from './storage.js';
import { OwnerAuth } from './auth.js';
import type { LocalKind } from '../src/core/index.js';

export interface Env {
  VERITY: DurableObjectNamespace;
  PUBLIC_ORIGIN: string;
  SITE_NAME: string;
  /** What this deployment links: one of its accounts, a page, or the site. Defaults to account. */
  OWNER_KIND?: LocalKind;
  OWNER_LABEL: string;
  OWNER_REFERENCE: string;
  OWNER_PROFILE_URL: string;
  REPORT_URL: string;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  OWNER_KEY: string;
}

const safeHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

const escape = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/**
 * Every page here says in its heading what it is, the way the library's pages do. The
 * logotype above already says whose it is, so the heading never has to repeat that.
 */
const html = (heading: string, body: string, status = 200, variant = '') =>
  new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(heading)} · Verity</title><link rel="stylesheet" href="/api/verity/style.css?v=${styleVersion}"><body><main${variant && ` class="${variant}"`}>${logo}<h1>${escape(heading)}</h1>${body}</main></body></html>`,
    { status, headers: { ...safeHeaders, 'Content-Type': 'text/html; charset=utf-8' } },
  );

/**
 * The page at the root for anybody not signed in, and the only thing it does. Whoever
 * reaches it either holds the owner key or has no business past it, so it carries one
 * field and no account of what lies behind.
 */
const signIn = (message = '', status = 200) =>
  html(
    'Sign in',
    `${message}<form action="/login" method="post"><label>Owner key <input name="key" type="password" autocomplete="current-password" required></label><button>Sign in</button></form>`,
    status,
    'single',
  );

const redirect = (cookie: string) =>
  new Response(null, {
    status: 303,
    headers: { ...safeHeaders, Location: '/', 'Set-Cookie': cookie },
  });

/** Matches the library's own bound: large enough for a pasted key, small enough to buffer. */
const maxBodyBytes = 65536;

/** Buffer only bounded request bodies before passing them to the library. */
async function boundedBody(request: Request): Promise<ArrayBuffer | undefined> {
  if (!request.body) return;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;

  while (true) {
    const { value, done } = await reader.read();

    if (done) break;

    length += value.byteLength;

    if (length > maxBodyBytes) {
      await reader.cancel();

      throw new Error('Body too large');
    }

    chunks.push(value);
  }

  const body = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return body.buffer;
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.origin !== env.PUBLIC_ORIGIN) return html('Unavailable', '', 404);

    if (!['GET', 'POST'].includes(request.method)) return html('Unavailable', '', 405);

    let body: ArrayBuffer | undefined;

    try {
      body = await boundedBody(request);
    } catch {
      return html('Request too large', '', 413);
    }

    try {
      // One installation, with an identity that survives deployments and hostname changes.
      return await env.VERITY.get(env.VERITY.idFromName('site-owner')).fetch(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body,
        redirect: 'manual',
      });
    } catch {
      return html('Temporarily unavailable', '', 503);
    }
  },
};

export class VerityStore {
  private readonly app;
  private readonly auth: OwnerAuth;
  private readonly local;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: Env,
  ) {
    const origin = new URL(env.PUBLIC_ORIGIN);

    if (origin.protocol !== 'https:' || origin.origin !== env.PUBLIC_ORIGIN)
      throw new Error('PUBLIC_ORIGIN must be an HTTPS origin without a trailing slash');

    this.auth = new OwnerAuth(ctx.storage, env.OWNER_KEY);

    this.local = {
      id: 'site-owner',
      // A site with no user accounts must not have its subject described as one.
      kind: env.OWNER_KIND,
      label: env.OWNER_LABEL,
      reference: env.OWNER_REFERENCE,
      profileUrl: env.OWNER_PROFILE_URL,
    };

    this.app = createVerity({
      storage: new CloudflareStorage(ctx.storage),
      provider: githubProvider({
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      }),
      baseUrl: `${env.PUBLIC_ORIGIN}/api/verity`,
      siteName: env.SITE_NAME,
      // The verifier is the origin that ran the flow and serves the evidence, which a
      // reader can check. It is not SITE_NAME: that host is claimed, not demonstrated.
      // The host alone: how the backend is operated is not something a reader verifies.
      verifierName: origin.host,
      profileOrigins: [new URL(env.OWNER_PROFILE_URL).origin],
      reportUrl: env.REPORT_URL,
      authenticate: async (request) =>
        (await this.auth.authenticated(request)) ? this.local : undefined,
    });

    this.app.service.validateLocal(this.local);

    ctx.blockConcurrencyWhile(async () => {
      if ((await ctx.storage.getAlarm()) === null) await ctx.storage.setAlarm(Date.now() + 3600000);
    });
  }

  async alarm() {
    // Schedule first so transient cleanup failures never permanently stop maintenance.
    await this.ctx.storage.setAlarm(Date.now() + 3600000);
    await this.app.service.prune();
    // Published proofs go stale on their own. A small budget per hour stays inside the
    // rate limit a provider gives an unauthenticated caller, shared across this colo.
    await this.app.service.recheck();
    await this.auth.prune();
  }

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.handle(request);
    } catch {
      return html('Temporarily unavailable', '', 503);
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.origin !== this.env.PUBLIC_ORIGIN) return html('Unavailable', '', 404);

    if (
      request.method === 'POST' &&
      url.pathname.startsWith('/api/verity/') &&
      (!request.headers.has('origin') || request.headers.get('origin') === 'null')
    ) {
      const headers = new Headers(request.headers);

      headers.set('origin', this.env.PUBLIC_ORIGIN);
      request = new Request(request, { headers });
    }

    if (request.method === 'POST') {
      if (!(await this.auth.allow('mutation', 60, 60000)))
        return html('Too many requests', '<p>Try again later.</p>', 429);

      if (url.pathname === '/login') {
        if (!(await this.auth.allow('login', 10, 15 * 60000)))
          return html('Too many requests', '<p>Try again in fifteen minutes.</p>', 429);

        const key = new URLSearchParams(await request.text()).get('key') ?? '';
        const cookie = await this.auth.login(key);

        return cookie ? redirect(cookie) : signIn('<p>Incorrect owner key.</p>', 403);
      }

      if (url.pathname === '/logout') return redirect(await this.auth.logout(request));

      if (request.headers.get('origin') !== this.env.PUBLIC_ORIGIN)
        return html('Unavailable', '', 403);
    }

    if (url.pathname.startsWith('/api/verity/')) {
      // Some browsers omit Origin on native same-origin form posts. The request
      // already passed the exact public-origin check above; flow cookies are
      // SameSite=Lax and the library still requires the authenticated owner.
      if (request.method === 'POST' && !request.headers.has('origin')) {
        const headers = new Headers(request.headers);

        headers.set('origin', this.env.PUBLIC_ORIGIN);
        request = new Request(request, { headers });
      }

      return this.app.handle(request);
    }

    if (request.method !== 'GET' || url.pathname !== '/') return html('Unavailable', '', 404);

    if (!(await this.auth.authenticated(request))) return signIn();

    const connections = await this.app.service.mine(this.local);

    const local = localSide(this.local, this.env.SITE_NAME);

    return html(
      'Owner settings',
      `<div class="side"><p class="who">${escape(local.heading)}</p>
      <p class="name">${escape(local.value)}</p>
      <p class="reference">${escape(this.local.reference)}</p></div>
      <p><a href="/api/verity/verify">Verify with GitHub or renew a connection</a></p>
      <p class="fine">Approve a public connection to display it on your site. Renew an existing one to extend it in place; only a new pair needs a new connection.</p>
      ${connections.map((e) => this.connection(e)).join('')}
      <form action="/logout" method="post"><button>Sign out</button></form>`,
    );
  }

  /** One connection, with the state, the visibility and the expiry each said once. */
  private connection(e: Evidence) {
    const embed = `<script src="/assets/verity.js" defer></script>\n<verity-badge backend-url="${this.env.PUBLIC_ORIGIN}/api/verity" connection-id="${e.id}"></verity-badge>`;

    return `<section><p class="who">${escape(e.providerName ?? e.provider)}</p>
      <h3>${escape(externalName(e.external))}</h3>
      <dl><dt>Status</dt><dd>${escape(statusLabel(e, Date.now()))}</dd>
      <dt>Visibility</dt><dd>${escape(e.visibility)}</dd>
      <dt>Expires</dt><dd>${escape(new Date(e.expiresAt).toISOString().replace(/\.\d{3}Z$/, 'Z'))}</dd></dl>
      ${e.visibility === 'public' ? `<p><a href="${escape(e.evidenceUrl)}">Inspect evidence</a></p><label>Embed on your site<textarea readonly rows="4" cols="80">${escape(embed)}</textarea></label>` : '<p class="fine">Unlisted connections cannot appear in a public pill.</p>'}
      <p><a href="/api/verity/renew/${escape(e.id)}">Renew this connection</a></p>
      <p class="fine">Renewing keeps the same connection ID, so embeds stay valid.</p>
      <p><a href="/api/verity/visibility/${escape(e.id)}">Change visibility</a></p>
      <form action="/api/verity/connections/${escape(e.id)}/disconnect" method="post"><button>Revoke connection</button></form></section>`;
  }
}
