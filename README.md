<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/design/verity-logo-inverted.svg" />
    <img src="docs/design/verity-logo.svg" alt="Verity" width="280" />
  </picture>
</h1>

<p align="center">
  Let your users prove they own an account elsewhere, and show it on their profile with a badge anyone can check.
</p>

<p align="center">
  <a href="https://github.com/bkazemi/verity/actions/workflows/ci.yml"><img src="https://github.com/bkazemi/verity/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@bkazemi/verity"><img src="https://img.shields.io/npm/v/@bkazemi/verity" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license" /></a>
</p>

<p align="center">
  <img src="docs/images/badge.png" alt="A profile card with a Verity badge showing a GitHub account" width="480" />
</p>

Verity is a self-hosted library for Node.js. A signed-in user of your site proves they control an external account, by signing in with GitHub, publishing a gist, linking back with `rel="me"`, or signing with an OpenPGP key. They approve the connection, and Verity publishes it as a record anyone can inspect, with a badge for their profile.

It doesn't sign anyone into your site, and it doesn't establish legal identity.

## How it works

1. Your site tells Verity who is signed in. Verity never handles your logins.
2. The user opens `<baseUrl>/verify`, picks a method, and proves they control the external account.
3. They approve the connection. Verity stores it and publishes the evidence at a public URL.
4. A `<verity-badge>` on their profile shows the external account. Clicking it opens the evidence.
5. Verity keeps the record honest: published proofs are re-read, records expire, and either side can revoke.

## Install

```sh
npm install @bkazemi/verity
```

Requires Node.js 22.13+ or 24+. In Node, `@bkazemi/verity` exports the server. Browser bundlers get a browser-only entry with no server or database code. With TypeScript, use `moduleResolution: "NodeNext"` for the server and `"Bundler"` for the browser.

## Set up the server

### 1. Storage

```ts
import { Pool, PostgresStorage } from '@bkazemi/verity';

const storage = new PostgresStorage(new Pool({ connectionString: process.env.DATABASE_URL }));
await storage.migrate(); // creates its one table if it doesn't exist
```

### 2. Create the handler

```ts
import { createVerity, githubProvider } from '@bkazemi/verity';

const verity = createVerity({
  storage,
  providers: [
    githubProvider({
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    }),
  ],
  baseUrl: 'https://community.example/api/verity',
  siteName: 'Example Community',
  verifierName: 'community.example',
  profileOrigins: ['https://community.example'],
  reportUrl: 'mailto:reports@community.example',
  authenticate: async (request) => {
    const user = await getSignedInUser(request); // your own session lookup
    if (!user) return undefined;

    return {
      id: user.id, // private, stable, never reused
      label: user.displayName,
      reference: user.username, // public and durable; never an email
      profileUrl: `https://community.example/users/${user.username}`, // optional
    };
  },
});
```

| Option           | Meaning                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------- |
| `provider`       | How users prove an external account. One provider or an array; see [Proof methods](#proof-methods). |
| `baseUrl`        | The public URL you mount Verity at. Every route it serves is under this path.                       |
| `siteName`       | Your site's name, shown on evidence.                                                                |
| `verifierName`   | Who vouches for the record, shown on evidence. Usually the backend's domain.                        |
| `profileOrigins` | The origins a local `profileUrl` may be on.                                                         |
| `reportUrl`      | Where readers report a bad record (`https:` or `mailto:`).                                          |
| `authenticate`   | Returns the signed-in local account for a request, or `undefined` if nobody is signed in.           |

For GitHub sign-in, [register an OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) with the callback URL `<baseUrl>/callback`.

### 3. Mount it

`verity.handle` takes a `Request` and returns a `Response`, so it plugs into any fetch-style router. For `node:http`, wrap it with `nodeHandler` and route the requests under `baseUrl` to it:

```ts
import { createServer } from 'node:http';
import { nodeHandler } from '@bkazemi/verity';

const handleVerity = nodeHandler(verity.handle, 'https://community.example');

createServer((req, res) => {
  if (req.url?.startsWith('/api/verity')) return handleVerity(req, res);
  // ...the rest of your site
}).listen(3000);
```

### 4. Link to it

Send signed-in users to `<baseUrl>/verify` to connect an account. `<baseUrl>/mine` returns their connections as JSON, for your settings page.

Then schedule the upkeep described under [Operations](#operations).

## Show the badge

With a bundler:

```js
import { init } from '@bkazemi/verity'; // also registers <verity-badge>

const client = init({ backendUrl: '/api/verity' });
```

Without one, serve `node_modules/@bkazemi/verity/dist/verity.js` yourself, or load it from a CDN such as `https://cdn.jsdelivr.net/npm/@bkazemi/verity@0.0.3/dist/verity.js`. The script defines a global `Verity`.

Then place the badge wherever the account appears:

```html
<script src="/assets/verity.js" defer></script>
<verity-badge backend-url="/api/verity" connection-id="CONNECTION_ID"></verity-badge>
```

Clicking the badge opens the verification details:

<p align="center">
  <img src="docs/images/dialog.png" alt="The verification details dialog: the local account, the linked GitHub account, its status, and when it was approved, expires and was last checked" width="448" />
</p>

The badge refreshes every 30 seconds, and only ever reads public evidence. The client can also start and end connections, and draw a badge into an element of your own:

```js
await client.connect({ provider: 'github' }); // opens <baseUrl>/verify in a popup; call from a click
await client.mountBadge(element, { connectionId }); // draws once; call again to refresh
await client.disconnect(connectionId);
```

To match your site's look, set any of these CSS variables on an ancestor: `--verity-surface`, `--verity-text`, `--verity-border`, `--verity-muted`, `--verity-hover`, `--verity-font-family`, `--verity-font-size`.

## Proof methods

```ts
import {
  githubProvider,
  githubGistProvider,
  linkProvider,
  githubLinkProvider,
  pgpProvider,
} from '@bkazemi/verity';
```

| Provider               | The user proves it by                                                                 | Setup                                   |
| ---------------------- | ------------------------------------------------------------------------------------- | --------------------------------------- |
| `githubProvider()`     | signing in with GitHub.                                                               | A GitHub OAuth app.                     |
| `githubGistProvider()` | publishing a public gist containing a line Verity gives them.                         | None.                                   |
| `linkProvider()`       | adding a `rel="me"` link to their profile on a page they control.                     | The local account needs a `profileUrl`. |
| `githubLinkProvider()` | putting their profile URL in the website field of their GitHub profile.               | The local account needs a `profileUrl`. |
| `pgpProvider()`        | signing a line Verity gives them with their OpenPGP key, then pasting it and the key. | None.                                   |

All methods except GitHub sign-in let the user publish the proof in their own time and come back. Gists and link-backs can be taken down later, so Verity re-reads them on a schedule. A PGP signature is kept by Verity and published at `<baseUrl>/connections/<id>/proof`.

**Several at once.** List more than one, and `/verify` offers each method as its own button:

```ts
providers: [githubProvider({ clientId, clientSecret }), githubLinkProvider()],
```

Proving the same account a second way adds that proof to the existing record instead of creating another.

**Link-backs.** Many people already have one, since GitHub and Mastodon mark profile links `rel="me"`. By default the page may be on any public host, and the account is named by the page's address. This mode needs Node, because Verity checks every connection it makes to stop the page's address from pointing inside your network. Pass `hosts` to read only certain hosts (required on Cloudflare Workers), and `profile` to name the account by handle, as `githubLinkProvider()` does for github.com. If you pass your own `fetch`, it replaces that network check, so it must enforce the same rule itself. Only real `<a>` and `<link>` elements in HTML pages, or a `Link:` header, count; [`src/server/link.ts`](src/server/link.ts) has the exact rules.

**OpenPGP.** The key's fingerprint is the identity. An email address is shown only when the key signed it **and** either keys.openpgp.org has confirmed it or the address's domain publishes the key in its [web key directory](https://datatracker.ietf.org/doc/draft-koch-openpgp-webkey-service/). The key must be valid when the proof is checked (not expired or revoked), SHA-1 signatures are refused, and a signing subkey must be properly bound to its key.

**Matching accounts.** Two methods agree on an account when the provider's account ids match. A link-back only knows an address, so it's matched by profile URL instead, and only in flows the user starts themselves. Removing a connection from the external side always needs a matching provider account id.

## A badge on a static site

A static site only needs the script and the badge markup; the backend runs somewhere else over HTTPS. The quickest backend is the Cloudflare Worker in this repository, which fits the free plan:

1. Clone this repository, run `npm ci`, and copy `wrangler.example.jsonc` to `wrangler.jsonc`. Fill in your account, origin and owner details.
2. Run `wrangler secret put` for `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `OWNER_KEY`, then `npm run cloudflare:deploy`.
3. On the backend's site, sign in with `OWNER_KEY`, verify, and approve a **public** connection. Its id is listed at `/api/verity/mine`.
4. Add the script and the badge to your site:

```html
<script src="https://cdn.jsdelivr.net/npm/@bkazemi/verity@0.0.3/dist/verity.js" defer></script>
<verity-badge
  backend-url="https://your-backend.example/api/verity"
  connection-id="CONNECTION_ID"
></verity-badge>
```

Run the backend on a domain readers can connect to your site, because `PUBLIC_ORIGIN` is shown as the verifier. If your site sets a Content Security Policy, allow the backend in `connect-src`.

## Operations

Verification lasts 30 days, flows 10 minutes, and sharing links 7 days. Change them with `validityMs`, `flowTtlMs` and `shareTtlMs`. Evidence is never cached.

Run the upkeep on a schedule, for example hourly:

```ts
setInterval(
  async () => {
    try {
      await verity.service.prune();
      await verity.service.recheck(); // only needed if you use a method other than GitHub sign-in
    } catch (error) {
      console.error('Verity upkeep failed', error);
    }
  },
  60 * 60 * 1000,
);
```

- **`prune()`** deletes expired flows, and deletes expired or revoked records after 90 days.
- **`recheck()`** re-reads gists and link-backs that are due, up to 5 per run (its `budget` argument). Each proof is re-read every 24 hours (`recheckMs`) and stays current for 7 days after its last successful read (`freshnessMs`); after that it shows as unconfirmed until a read succeeds. A failed read changes nothing. For PGP, it asks the keyserver whether the key has been revoked, and revokes the connection if so.

**If you never call `recheck()`, set `freshnessMs: Infinity`.** Otherwise connections proved by gist, link-back or PGP lapse after a week.

## Development

Clone the repository and run `npm ci`. `npm run preview` then shows the badge in every state at http://localhost:3001, with no other setup.

The full example also needs Postgres and a GitHub OAuth app with the callback URL `http://localhost:3000/api/verity/callback`:

```sh
npm run build
docker compose up -d --wait
cp example/.env.example .env   # add the GitHub client id and secret, and a long EXAMPLE_PASSWORD
node --env-file=.env --import tsx example/server.ts
```

Checks and tests:

```sh
npm run build
npm run check
npm run format:check   # npm run format fixes formatting
npm test
TEST_DATABASE_URL=postgres://verity:verity@localhost:5432/verity npm test
npm run test:consumer
```

The Postgres and example tests only run when `TEST_DATABASE_URL` is set. The other tests use a fake provider and in-memory storage, so a live GitHub sign-in still has to be tried by hand. `test:consumer` installs the packed package into a separate project and checks its Node and browser imports. CI runs all of it, Postgres included, on Node 22.13, 24 and 26.

## License

MIT. `pgpProvider()` uses [OpenPGP.js](https://github.com/openpgpjs/openpgpjs), which is LGPL-3.0-or-later.
