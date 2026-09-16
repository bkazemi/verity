# Verity V0

Standalone, self-hosted account-link verification for Node.js and ordinary HTML sites. Verity authenticates a GitHub account and asks its holder to approve a connection to the exact local account supplied by your application. It does not sign users into your site or establish legal identity.

Includes a TypeScript server, a framework-free browser component, transactional Postgres adapter, public/unlisted evidence, sharing-link rotation, local and external revocation, and a runnable generic example. No Veracity service or account is needed. MIT licensed; package names are provisional and publication is disabled.

## Preview the default badge

```sh
npm run preview
```

Open http://localhost:3001 to see the actual styled badge on a JoeSite profile, including expired, revoked, and unavailable states. This clearly labeled fixture preview requires no database or GitHub credentials and performs no real verification.

## Run the example

Requires Node.js 22+, npm, Postgres, and a GitHub.com OAuth app.

```sh
npm ci
npm run build
docker compose up -d --wait
cp example/.env.example .env
```

Register a [GitHub OAuth app](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app) with:

- Homepage URL: `http://localhost:3000`
- Authorization callback URL: `http://localhost:3000/api/verity/callback`

Fill in `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and a long `EXAMPLE_PASSWORD` in `.env`. The supplied database URL matches Compose. Then:

```sh
node --env-file=.env --import tsx example/server.ts
```

Open **http://localhost:3000**, sign into the example local account with `EXAMPLE_PASSWORD`, and choose **Verify with GitHub**. Review the exact pair, choose visibility (unlisted by default), and select **Confirm account link**. Settings can issue/replace/revoke a sharing link or disconnect. The public profile includes only public connections. Evidence pages work without JavaScript and offer removal through fresh authentication with the matching GitHub account. Unlisted evidence also offers revocation of only its sharing link. Visibility changes require local authorization, fresh external authentication, and explicit approval.

The example is real OAuth, not a simulated provider. The example site's single-account password and in-memory sessions are deliberately application-owned sample authentication, not a reusable production account system. Sessions reset when the example restarts; verification records persist in Postgres. Bind is loopback-only; put a configured HTTPS proxy in front for deployment.

## Use the built package

```sh
npm pack --pack-destination /tmp
# In a separate application:
npm install /tmp/verity-0.0.1.tgz
```

One package, one import path:

```ts
// Frontend
import { init } from 'verity';

// Backend
import { createVerity, githubProvider, PostgresStorage } from 'verity';

// Shared types
import type { LocalAccount, Evidence } from 'verity';
```

The package uses [conditional exports](https://nodejs.org/api/packages.html#conditional-exports): Node loads the server APIs, while browser bundlers load a browser-safe entry point without provider or database code. The fallback also selects the browser-safe entry point. Server APIs are unavailable in browser builds. The modules remain internal; consumers do not import module subpaths.

Use TypeScript `moduleResolution: "NodeNext"` for Node backends and `"Bundler"` for frontend builds. Frontend configurations using NodeNext should add [`customConditions: ["browser"]`](https://www.typescriptlang.org/tsconfig/customConditions.html) so TypeScript uses the browser declarations too. Node exports `init` as well so importing a frontend component during server-side rendering works; call browser client methods only in the browser.

```ts
import { createVerity, githubProvider, nodeHandler, Pool, PostgresStorage } from 'verity';

const storage = new PostgresStorage(new Pool({ connectionString: process.env.DATABASE_URL }));
await storage.migrate(); // Run once at startup or in your migration process.
const verity = createVerity({
  storage,
  provider: githubProvider({
    clientId: process.env.GITHUB_CLIENT_ID!,
    clientSecret: process.env.GITHUB_CLIENT_SECRET!,
  }),
  baseUrl: 'https://community.example/api/verity',
  siteName: 'Example Community',
  verifierName: 'Example Community (self-hosted Verity)',
  profileOrigins: ['https://community.example'],
  reportUrl: 'mailto:reports@community.example',
  authenticate: async (request) => {
    const user = await yourApplicationSession(request);
    if (!user) return undefined;
    return {
      id: user.permanentId, // Private, stable, never reassigned.
      label: user.publicLabel,
      reference: user.publicAccountReference, // Durable, public-safe; not an email.
      // profileUrl is optional: accounts need not have public profiles.
    };
  },
});
// Your router calls verity.handle(Request), or mounts this Node callback:
const handler = nodeHandler(verity.handle, 'https://community.example');
```

Resolve the distributed asset with `createRequire(import.meta.url).resolve('verity/verity.js')`, as shown in [the example](example/server.ts). Browser imports have no server/database imports.

```html
<script src="/assets/verity.js" defer></script>
<verity-badge backend-url="/api/verity" connection-id="PUBLIC_CONNECTION_ID"></verity-badge>
```

```js
const client = Verity.init({ backendUrl: '/api/verity' });
// Call directly from a button click so the browser permits a popup.
const result = await client.connect({ provider: 'github' });
// result.outcome: complete | cancelled | failed; completion includes connectionId.
const evidence = await client.getConnection('PUBLIC_CONNECTION_ID');
await client.mountBadge(element, { connectionId: evidence.id });
await client.disconnect(evidence.id);
```

Badges include their default styling, isolated in Shadow DOM with a constructable stylesheet (modern browsers). Both `mountBadge` and `<verity-badge>` use the same design. The compact default shows the Verity mark, provider logo, and external @handle in one row. The entire badge is one keyboard-focusable control: a normal click opens a verification modal with freshly fetched evidence, both account references, status, timestamps, and verifier attribution. Escape, the close button, or clicking the backdrop dismisses it. Verification status and verifier attribution remain in the accessible label and tooltip; inactive badges reveal their state text on hover or keyboard focus while their status icons remain visible. Provider profile links are available in the modal. The local side of a link is not required to be an account. `LocalAccount.kind` accepts `account`, `page` or `site`, so a site can link one of its member accounts, a single page, or the site itself to an external account; `reference` stays the durable public identifier and `profileUrl` is that subject's canonical URL. Omitting `kind` means an account. Badges and evidence pages word themselves from it and name no specific provider.

Optional inherited CSS variables `--verity-surface`, `--verity-text`, `--verity-border`, `--verity-muted`, and `--verity-hover` let a host site adjust colors; `--verity-font-family` and `--verity-font-size` match the surrounding typeface.

For script-free verification, link to `/api/verity/verify`. For private settings, use the authenticated `/mine` and `/manage/:id` endpoints. `getConnection` and badges deliberately read only public evidence, even when the browser is signed in. Keep sharing URLs in private settings, never public HTML.

## A live pill on GitHub Pages or another static site

For a backend and persistent storage on Cloudflare's free plan, copy `wrangler.example.jsonc` to `wrangler.jsonc`, fill in your account, origin and owner details, and set `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` and `OWNER_KEY` with `wrangler secret put`. Then deploy with `npm run cloudflare:deploy`. It provides a single-owner settings page, SQLite-backed Durable Object storage, and hourly cleanup; no Postgres server is needed for that deployment.

`wrangler.jsonc` is gitignored because it names one Cloudflare account and one site owner. Serve the backend from a host a reader can tie to the site making the claim: `PUBLIC_ORIGIN` sets the verifier name that appears in evidence, and the Worker refuses any other origin.

The static site hosts `dist/verity.js` and the badge markup. Run the verification backend separately at an HTTPS address, using either Cloudflare or Node with Postgres. Successful public evidence JSON responses allow cross-origin reads; the badge fetches current status without sending cross-origin cookies and refreshes every 30 seconds.

1. Configure and deploy the backend with your GitHub OAuth app and an authenticated owner account. The local account reference should identify the author/account displayed on your site. Merely configuring a profile URL does not prove control of its domain.
2. On the backend's own site, sign in, complete GitHub authentication, and explicitly approve a **public** connection. Obtain its connection ID from the authenticated `/mine` endpoint.
3. Copy `dist/verity.js` into your static site's assets and embed the following markup, replacing the example backend URL and connection ID:

```html
<script src="/assets/verity.js" defer></script>
<verity-badge
  backend-url="https://verifier.example/api/verity"
  connection-id="YOUR_PUBLIC_CONNECTION_ID"
></verity-badge>
```

Visitors can inspect the evidence in the pill's modal or follow its evidence link. Verification, renewal, and management happen on the backend's site; `connect()` requires a same-origin backend. Keep the backend available for status reads. The default verification expires after 30 days, and the pill stops showing an active verification when evidence expires, is revoked, or cannot be fetched. If your static site sets a Content Security Policy, allow the backend origin in `connect-src`.

## Contract and operations

Defaults: verification lasts **30 days**, flows **10 minutes**, sharing links **7 days**. Configure `validityMs`, `flowTtlMs`, and `shareTtlMs` in milliseconds. All evidence responses use **no-store**; declarative badges refresh every **30 seconds** and remove their active presentation if refresh fails. Manual `mountBadge` calls render once; adopters must call again at least every 30 seconds. The evidence page is authoritative at request time. There is no background provider recheck or claim of continuous ownership.

Call `verity.service.prune()` periodically; the example runs it hourly. It deletes expired flows and removes expired/revoked evidence after a default 90-day history period. See the retention policy before changing that period.

## Formatting

[Prettier](https://prettier.io/docs/install) and ESLint Stylistic are installed locally at pinned versions. ESLint enforces blank lines between declarations and methods, around control flow, and before returns; Prettier handles indentation and wrapping. Editor integrations can use `.prettierrc.json` for the same formatting on save.

```sh
npm run format        # Format source, tests, examples, docs, and configuration.
npm run format:check  # Check formatting without editing files.
```

Generated files, dependency lockfiles, and the original specification are excluded.

## Validation

```sh
npm run build
npm run check
npm test
TEST_DATABASE_URL=postgres://verity:verity@localhost:5432/verity npm test
npm run test:consumer
```

The Postgres test is explicitly skipped unless `TEST_DATABASE_URL` is supplied. It uses isolated namespaces and removes its records. The other tests use a deterministic test-only provider and transaction adapter; they do not establish successful live GitHub integration. `test:consumer` packs and installs into a temporary separate consumer, checks Node and browser imports and TypeScript declarations, verifies the browser bundle excludes server/database modules, and executes the distributed browser script without server globals.

Live OAuth acceptance still requires an operator with GitHub app credentials to drive the flow against the real provider by hand. Provider access is an integration prerequisite; no credentials ship in this repository.
