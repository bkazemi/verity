import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import {
  createVerity,
  githubProvider,
  nodeHandler,
  Pool,
  PostgresStorage,
  type LocalAccount,
} from 'verity';

const origin = process.env.ORIGIN ?? 'http://localhost:3000';
const password = process.env.EXAMPLE_PASSWORD;

if (!password || password.length < 12)
  throw new Error('Set EXAMPLE_PASSWORD to at least 12 characters');

if (!process.env.DATABASE_URL || !process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET)
  throw new Error('Set DATABASE_URL, GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const storage = new PostgresStorage(pool, process.env.VERITY_NAMESPACE ?? 'verity');

await storage.migrate();

// Example application-owned identity/session adapter. A production adopter supplies its own.
const localAccount: LocalAccount = {
  id: 'example-account-1',
  label: 'Alex Example',
  reference: 'example-member-1',
  profileUrl: `${origin}/profile`,
};

const sessions = new Map<string, number>();

async function authenticate(request: Request) {
  const token = request.headers
    .get('cookie')
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('example_session='))
    ?.slice(16);

  if (token && (sessions.get(token) ?? 0) > Date.now()) return localAccount;

  return undefined;
}

const verity = createVerity({
  storage,
  provider: githubProvider({
    clientId: process.env.GITHUB_CLIENT_ID,
    clientSecret: process.env.GITHUB_CLIENT_SECRET,
  }),
  baseUrl: `${origin}/api/verity`,
  siteName: 'Example Community',
  verifierName: 'verity.example.com',
  profileOrigins: [origin],
  authenticate,
  reportUrl: `${origin}/report`,
});

await verity.service.prune();

const maintenance = setInterval(() => {
  void verity.service.prune().catch(() => console.error('Verity maintenance failed'));
}, 3600000);

maintenance.unref();
const require = createRequire(import.meta.url);
const asset = await readFile(require.resolve('verity/verity.js'));
const ui = await readFile(new URL('./ui.js', import.meta.url));

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const page = (body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Verity example</title><body><h1>Example Community</h1><nav><a href="/">Settings</a> · <a href="/profile">Public profile</a></nav><main>${body}</main></body></html>`;

const safeHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
};

const html = (body: string, status = 200) =>
  new Response(page(body), {
    status,
    headers: { ...safeHeaders, 'Content-Type': 'text/html; charset=utf-8' },
  });

const loginAttempts = new Map<string, { count: number; until: number }>();

async function handle(request: Request) {
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/verity/')) return verity.handle(request);

  if (request.method === 'POST') {
    if (request.headers.get('origin') !== origin) return html('Unavailable', 403);

    if (url.pathname === '/login') {
      // A single development account, shared password, and global throttle; not a signup system.
      const attempt = loginAttempts.get('global');

      if (attempt && attempt.until > Date.now() && attempt.count >= 10)
        return html('Try again in a minute.', 429);

      const next =
        attempt && attempt.until > Date.now() ? attempt : { count: 0, until: Date.now() + 60000 };

      next.count++;
      loginAttempts.set('global', next);
      const input = new URLSearchParams(await request.text()).get('password') ?? '';

      const a = Buffer.from(input),
        b = Buffer.from(password!);

      if (a.length !== b.length || !timingSafeEqual(a, b))
        return html('Incorrect password. <a href="/">Try again</a>', 403);

      const token = randomBytes(32).toString('base64url');

      for (const [key, expiry] of sessions) if (expiry <= Date.now()) sessions.delete(key);

      sessions.set(token, Date.now() + 8 * 3600000);

      return new Response(null, {
        status: 303,
        headers: {
          ...safeHeaders,
          Location: '/',
          'Set-Cookie': `example_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=28800${origin.startsWith('https:') ? '; Secure' : ''}`,
        },
      });
    }

    return html('Unavailable', 404);
  }

  if (url.pathname === '/assets/verity.js')
    return new Response(asset, { headers: { ...safeHeaders, 'Content-Type': 'text/javascript' } });

  if (url.pathname === '/assets/ui.js')
    return new Response(ui, { headers: { ...safeHeaders, 'Content-Type': 'text/javascript' } });

  if (url.pathname === '/report')
    return html(
      '<h2>Report an incorrect record</h2><p>This is a development example. Contact the person running this instance; configure reportUrl with your real reporting destination before deployment.</p>',
    );

  if (url.pathname === '/profile') {
    const connections = (await verity.service.mine(localAccount)).filter(
      (c) => c.visibility === 'public',
    );

    return html(
      `<h2>Alex Example</h2><p>Account reference: example-member-1</p>${connections.map((c) => `<verity-badge backend-url="/api/verity" connection-id="${esc(c.id)}"></verity-badge><p><a href="${esc(c.evidenceUrl)}">Inspect account-pair evidence (${esc(c.status)})</a></p>`).join('')}<script src="/assets/verity.js" defer></script>`,
    );
  }

  if (url.pathname !== '/') return html('Unavailable', 404);

  if (!(await authenticate(request)))
    return html(
      '<h2>Sign in to the example local account</h2><p>This password belongs to the example site, not GitHub.</p><form method="post" action="/login"><label>Example password <input type="password" name="password" autocomplete="current-password" required></label><button>Sign in</button></form>',
    );

  return html(`<h2>Account settings: Alex Example</h2><p>Confirm the connection between this account and your GitHub account.</p>
    <button id="verify">Verify with GitHub</button><p><a href="/api/verity/verify">Verify using the full-page flow</a></p><p id="message" role="status"></p><section id="connections"></section>
    <script src="/assets/verity.js" defer></script><script src="/assets/ui.js" defer></script>`);
}

const server = createServer(nodeHandler(handle, origin));

server.listen(Number(new URL(origin).port || 3000), '127.0.0.1', () =>
  console.log(`Verity example: ${origin}`),
);

async function close() {
  clearInterval(maintenance);
  server.close();
  await pool.end();
}

process.on('SIGTERM', close);
process.on('SIGINT', close);
