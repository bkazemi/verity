# Verity V0

Self-hosted account-link verification for Node.js and plain HTML sites. The holder of an external account proves they control it — by signing in with GitHub, publishing a gist, linking back with `rel="me"`, or signing with an OpenPGP key — and approves a connection to a local account your application supplies. Verity publishes the result as evidence anyone can check, and a badge that shows it. It does not sign users into your site or establish legal identity.

It includes a TypeScript server, a framework-free browser component, a Postgres adapter, a Cloudflare Worker, and a runnable example. MIT licensed; [OpenPGP.js](https://github.com/openpgpjs/openpgpjs), used by `pgpProvider()`, is LGPL-3.0-or-later. Package names are provisional and publication is disabled.

## Try it

Requires Node.js 22.13+ or 24+.

```sh
npm ci
npm run preview   # the badge in each state at http://localhost:3001, no setup needed
```

To run the full example you also need Postgres and a [GitHub OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) with homepage `http://localhost:3000` and callback `http://localhost:3000/api/verity/callback`:

```sh
npm run build
docker compose up -d --wait
cp example/.env.example .env   # fill in the GitHub client id and secret, and a long EXAMPLE_PASSWORD
node --env-file=.env --import tsx example/server.ts
```

The example's password login and in-memory sessions stand in for your own authentication. It binds to loopback only.

## Use it

```sh
npm pack --pack-destination /tmp
npm install /tmp/verity-0.0.1.tgz   # in your application
```

`import ... from 'verity'` gives Node the server API and browser bundlers a browser-only entry with no server or database code. Use `moduleResolution: "NodeNext"` on the server and `"Bundler"` in the browser; a browser build using NodeNext needs `customConditions: ["browser"]`.

```ts
import { createVerity, githubProvider, nodeHandler, Pool, PostgresStorage } from 'verity';

const storage = new PostgresStorage(new Pool({ connectionString: process.env.DATABASE_URL }));
await storage.migrate();

const verity = createVerity({
  storage,
  provider: githubProvider({
    clientId: process.env.GITHUB_CLIENT_ID!,
    clientSecret: process.env.GITHUB_CLIENT_SECRET!,
  }),
  baseUrl: 'https://community.example/api/verity',
  siteName: 'Example Community',
  verifierName: 'verity.example.com',
  profileOrigins: ['https://community.example'],
  reportUrl: 'mailto:reports@community.example',
  authenticate: async (request) => {
    const user = await yourApplicationSession(request);
    if (!user) return undefined;
    return {
      id: user.permanentId, // private, stable, never reassigned
      label: user.publicLabel,
      reference: user.publicAccountReference, // durable and public; not an email
      // profileUrl is optional. kind is 'account' (default), 'page' or 'site'.
    };
  },
});

// Call verity.handle(Request) from your router, or mount the Node callback:
const handler = nodeHandler(verity.handle, 'https://community.example');
```

In the browser, serve the bundled script (resolve it with `createRequire(import.meta.url).resolve('verity/verity.js')`, as [the example](example/server.ts) does):

```html
<script src="/assets/verity.js" defer></script>
<verity-badge backend-url="/api/verity" connection-id="PUBLIC_CONNECTION_ID"></verity-badge>
```

```js
const client = Verity.init({ backendUrl: '/api/verity' });
const result = await client.connect({ provider: 'github' }); // call from a click, so the popup is allowed
const evidence = await client.getConnection('PUBLIC_CONNECTION_ID');
await client.mountBadge(element, { connectionId: evidence.id, evidence });
await client.disconnect(evidence.id);
```

The badge shows the external handle and opens a dialog with both accounts, the status, timestamps and a link to the evidence on the verifier's domain. `<verity-badge>` refreshes every 30 seconds; `mountBadge` renders once, so call it again at least that often. Hosts can restyle it with the CSS variables `--verity-surface`, `--verity-text`, `--verity-border`, `--verity-muted`, `--verity-hover`, `--verity-font-family` and `--verity-font-size`.

Badges and `getConnection` read public evidence only. Private settings use the authenticated `/mine` and `/manage/:id` endpoints; keep sharing links out of public HTML. For a page without scripts, link to `/api/verity/verify`.

## A badge on a static site

The static site only hosts `dist/verity.js` and the badge markup; the backend runs elsewhere over HTTPS. The simplest backend is the Cloudflare Worker, which runs on the free plan with SQLite-backed Durable Object storage:

1. Copy `wrangler.example.jsonc` to `wrangler.jsonc` (gitignored) and fill in your account, origin and owner details.
2. `wrangler secret put` `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `OWNER_KEY`, then `npm run cloudflare:deploy`.
3. On the backend's own site, sign in, verify, and approve a **public** connection. Take its id from `/mine`.
4. Embed the badge with `backend-url="https://your-backend/api/verity"` and that id.

Serve the backend from a host readers can tie to your site: `PUBLIC_ORIGIN` is the verifier name shown in evidence. If your site has a Content Security Policy, allow the backend in `connect-src`. The badge stops showing as verified when evidence expires (30 days by default), is revoked, or can't be fetched.

## Proof methods

| Provider               | The holder…                                                                    | Needs                                |
| ---------------------- | ------------------------------------------------------------------------------ | ------------------------------------ |
| `githubProvider()`     | signs in with GitHub.                                                          | An OAuth app id and secret.          |
| `githubGistProvider()` | publishes a public gist containing a line Verity gives them.                   | Nothing.                             |
| `linkProvider()`       | puts a `rel="me"` link to their local profile on a page they control.          | Nothing; the subject's `profileUrl`. |
| `githubLinkProvider()` | the same, using the website field on their GitHub profile.                     | Nothing; the subject's `profileUrl`. |
| `pgpProvider()`        | signs a line Verity gives them with an OpenPGP key and pastes it with the key. | Nothing.                             |

Every method except GitHub sign-in lets the holder publish the proof in their own time and come back. A gist or link back is re-read on a schedule, since it can be taken down; a PGP signature is published by Verity itself at `<baseUrl>/connections/<id>/proof`.

**Link back.** Many people have one already: GitHub and Mastodon mark profile links `rel="me"`. Without `hosts`, the page can be on any public host, the result is a page named by its address, and the provider refuses to start anywhere but Node, because it needs to check where each connection goes. With `hosts` it reads only those hosts, and with `profile` it names the account by handle, as `githubLinkProvider()` does for github.com. Passing your own `fetch` replaces the protection against reading addresses inside your network, so only pass one that enforces that itself. Only real `<a>` and `<link>` elements in `text/html` pages, or a `Link:` header, count. See [`src/server/link.ts`](src/server/link.ts) for the exact rules.

**OpenPGP.** The key's fingerprint is the identity. An email address is shown only where the key signed for it **and** either keys.openpgp.org confirmed it or the mailbox's domain publishes the key in its [web key directory](https://datatracker.ietf.org/doc/draft-koch-openpgp-webkey-service/); otherwise the fingerprint is shown. The key has to be valid now (not expired or revoked, with a signed user ID), SHA-1 signatures are refused, and a signing subkey must be bound both ways.

**Several at once.** `provider` takes an array, and the verify page offers each method as its own button:

```ts
provider: [githubProvider({ clientId, clientSecret }), githubLinkProvider()],
```

Showing the same account a second way adds that proof to the existing record rather than making a new one. Methods agree on an account when their provider-issued ids match; a link back, which only knows an address, is matched by profile address, and only in flows the local holder starts. Removing a connection from the external side always needs a matching provider-issued id.

## Operations

Verification lasts 30 days, flows 10 minutes and sharing links 7 days (`validityMs`, `flowTtlMs`, `shareTtlMs`). Evidence responses are never cached.

Call `verity.service.prune()` periodically (the example runs it hourly) to delete expired flows and, after 90 days, expired or revoked evidence.

If you use a gist, link-back or PGP provider, also call `verity.service.recheck()` on a schedule. It re-reads proofs that are due, up to `budget` per run (default 5). Each is re-read every `recheckMs` (24 hours) and stays current for `freshnessMs` (7 days) after its last good read; after that it shows as unconfirmed until a read succeeds. A failed read changes nothing. For PGP it checks the keyserver for a revocation the key itself signed, and revokes the connection if it finds one. **If you never call `recheck()`, set `freshnessMs: Infinity`**, or these connections lapse after a week.

## Development

```sh
npm run build
npm run check
npm run format:check   # npm run format to fix
npm test
TEST_DATABASE_URL=postgres://verity:verity@localhost:5432/verity npm test
npm run test:consumer
```

The Postgres and example tests run only with `TEST_DATABASE_URL`. Other tests use a fake provider and in-memory storage, so they don't exercise a live GitHub sign-in; that still has to be tried by hand with real credentials. `test:consumer` installs the packed package into a separate project and checks its Node and browser imports. CI runs everything, Postgres included, on Node 22.13, 24 and 26.
