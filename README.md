# Verity V0

Standalone, self-hosted account-link verification for Node.js and ordinary HTML sites. Verity authenticates a GitHub account and asks its holder to approve a connection to the exact local account supplied by your application. It does not sign users into your site or establish legal identity.

Includes a TypeScript server, a framework-free browser component, transactional Postgres adapter, public/unlisted evidence, sharing-link rotation, local and external revocation, and a runnable generic example. No Veracity service or account is needed. MIT licensed; package names are provisional and publication is disabled.

## Preview the default badge

```sh
npm run preview
```

Open http://localhost:3001 to see the actual styled badge on a JoeSite profile, including expired, revoked, and unavailable states. This clearly labeled fixture preview requires no database or GitHub credentials and performs no real verification.

## Run the example

Requires Node.js 22.13+ or 24+, npm, Postgres, and a GitHub.com OAuth app.

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
import {
  createVerity,
  githubProvider,
  githubGistProvider,
  pgpProvider,
  PostgresStorage,
} from 'verity';

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
  verifierName: 'verity.example.com',
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
// `githubGistProvider()`, `linkProvider()` and `pgpProvider()` are the alternatives,
// and `provider` also takes several at once; see Proof methods below.
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
// Evidence already in hand draws the finished pill without another request.
await client.mountBadge(element, { connectionId: evidence.id, evidence });
await client.disconnect(evidence.id);
```

Badges include their default styling, isolated in Shadow DOM with a constructable stylesheet (modern browsers). Both `mountBadge` and `<verity-badge>` use the same design. A badge with nothing to show yet draws its own frame and mark in the page's text colour, with a spinner in place of the account, and claims nothing until evidence arrives; that same frame and mark are then filled in rather than replaced. A refresh that finds unchanged evidence leaves the pill untouched, so a badge does not blink every thirty seconds. Setting `element.evidence` before inserting a `<verity-badge>`, or passing `evidence` to `mountBadge`, renders that evidence at once without a request, which suits an embed that has already read `/published`; a badge may also be inserted before its `connection-id` is known, and waits until one is set. The compact default shows the Verity mark, provider logo, and external @handle in one row. The entire badge is one keyboard-focusable control: a normal click opens a verification modal showing both account references, status, timestamps, and verifier attribution. It opens already drawn from the record behind the pill, so it appears at the size it keeps, and re-reads that record from the backend at once: an unchanged answer leaves the modal alone, a changed one redraws it, and a failed one replaces it with an unavailable notice. Escape, the close button, or clicking the backdrop dismisses it. Verification status and verifier attribution remain in the accessible label and tooltip; inactive badges reveal their state text on hover or keyboard focus while their status icons remain visible. Provider profile links are available in the modal, and the verifier named under the status links to this record on the verifier's own domain, so a reader can check the claim at its source without a modified click. Every link in the modal opens in a new tab: the record is read against what it points to, and the page the pill sits on is not lost to it. The local side of a link is not required to be an account. `LocalAccount.kind` accepts `account`, `page` or `site`, so a site can link one of its member accounts, a single page, or the site itself to an external account; `reference` stays the durable public identifier and `profileUrl` is that subject's canonical URL. Omitting `kind` means an account. Badges and evidence pages word themselves from it and name no specific provider.

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

## Proof methods

A provider answers _whose_ an account is; a method answers _how_ control of it was shown. The two multiply rather than enumerate, and none of them is ranked above the others: which proof convinces is the reader's call, which is the reason for publishing one instead of issuing a verdict.

| Provider               | How the holder proves it                                                                                  | Needs                                          |
| ---------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `githubProvider()`     | Signs in through GitHub and comes back.                                                                   | An OAuth app, a client id and a client secret. |
| `githubGistProvider()` | Publishes a public gist containing a per-flow line, and hands back its address.                           | Nothing.                                       |
| `linkProvider()`       | Puts a `rel="me"` link to their local subject on a page they control, and hands back that page's address. | Nothing.                                       |
| `githubLinkProvider()` | The same, on their GitHub profile, whose website field GitHub already marks `rel="me"`.                   | Nothing.                                       |
| `pgpProvider()`        | Signs a per-flow line with an OpenPGP key, and hands back the signed message and their public key.        | Nothing.                                       |

All but the first are holder-paced: the flow stays on your origin while the holder goes away and publishes, instead of being one redirect. They differ in who keeps the proof, which is what `ArtifactProvider.artifact` says:

- **`location`** — the holder publishes the proof somewhere only they can write and hands back an address. The address is half of what is proved, so the provider must refuse any address outside itself; an unpinned fetch is an open proxy. The proof can later be deleted, so it is reread on a schedule.
- **`document`** — the holder hands over the proof itself and Verity publishes it at `<baseUrl>/connections/<id>/proof`, as `text/plain` a reader can drop straight into their own tools. Nothing is fetched to establish it.

`pgpProvider()` is a `document` method because a key has no provider at all. Nobody operates it, nobody can transfer it, and there is no account table anywhere to consult: **the fingerprint is the identity**, and the address a signature was typed at proves nothing.

A key is shown by the address on it, because that is what a reader recognises — forty hex digits are not. But an address is shown **only where two parties who cannot stand in for each other have both said it**: the key signed for it, and somebody who is not its holder publishes it.

There are two sources for the second half. A keyserver that confirms addresses, and the mailbox's own domain: if `example.com` publishes the key at the [web key directory](https://datatracker.ietf.org/doc/draft-koch-openpgp-webkey-service/) location derived from `alice@example.com`, that is the domain owning the mailbox saying the two belong together — a better answer than a third party's, and the one that covers keys uploaded nowhere. The keyserver is asked first because it is a single request; the directory's two locations follow. The directory's host comes off a stranger's key, so it is read through the same transport as a backlink: every address the name resolves to must be public, checked on the connection itself. That needs Node; elsewhere the directory is skipped and the key shows as its fingerprint unless the keyserver confirms an address.

Either one alone is worth nothing. Minting a key that self-certifies `<support@bank.example>` takes seconds, so an address on a key is only the key's word for itself, and printing it beside a real proof would read as established when nobody established anything. A keyserver saying it alone is no better, because Verity does not take the keyserver's word either: the served packets are checked against the key it already holds, so the keyserver is a courier that can stay silent but cannot put an address on a key or take one off. Anywhere no address is confirmed — not uploaded, keyserver down, keyserver lying — the fingerprint's short form stands in, and the proof itself is unaffected, because the proof never depended on a keyserver.

The fingerprint is always carried beside the address, since a confirmation says only that somebody could read that mailbox on the day they confirmed it, while the fingerprint is the part nobody can claim their way into. A holder who wants their address shown is told so in the flow's instructions: publish the key and confirm the address first.

The OpenPGP reader is written out rather than depended on, because a library arguing that you can check its claims should not first ask you to accept a megabyte of somebody else's cryptography. It parses armor, public-key and signature packets, and the cleartext framework, and verifies Ed25519, ECDSA and RSA through WebCrypto. It rejects SHA-1 signatures. A signing subkey counts, but only where the primary key signed a binding for it — otherwise anyone could staple their own subkey to a published key and sign as its holder.

### A link back

`linkProvider()` proves a link by reading one back. The holder puts an ordinary `rel="me"` link to their exact local subject on a page only they can write, hands back that page's address, and Verity reads the page and checks the link is there.

Usually they have already done it without being asked. GitHub marks a profile's website field `rel="me"`, and Mastodon does the same for its profile links, so anybody who filled that field in is published already:

```html
<a rel="nofollow me" class="Link--primary wb-break-all" href="https://shirkadeh.org"></a>
```

`rel="me"` says the thing at the other end of the link is also me. It is an [XFN](https://gmpg.org/xfn/) relation, and it is what IndieAuth and Mastodon's own profile verification run on. One such link proves nothing by itself — anyone can write one pointing anywhere — and it is the **pair** that proves something: two addresses agreeing they are the same party, each writable only by whoever holds it. Verity already has the other half, because a site declaring its own subject is the `declared` attestation on every link it makes, so only the far side is ever fetched.

Two things follow, and both depart from the other holder-paced methods.

**The proof is not a per-flow token.** Every other artifact method has Verity mint an unguessable line for the holder to publish, which is what stops an artifact made for one flow completing another. A backlink has no room for one: the claim _is_ the subject's address, and nobody is going to leave `?verity=…` in their GitHub website field forever. So `ArtifactProvider.expect()` lets a provider state what must be published instead, and this one returns the local subject's `profileUrl` — meaning a subject without one cannot be proved this way at all, and starting such a flow fails loudly. Uniqueness is traded for a standing link, and freshness comes from reading it again: `recheck()` does that on its usual schedule, and a link taken down stops confirming.

**What is proved is a page, not an account** — unless you have said whose namespace it is in. No provider was asked who holds the address; a document was fetched from it. So by default the external side comes back with `kind: 'page'`, named by its address, because a handle is a claim that somebody issued an account and reading a page never establishes one. The address is kept exactly as it was read, trailing slash included, since `/foo/` and `/foo` can be different resources on an arbitrary host.

A deployment that has named the host can say more, because the namespace is then known: pass `profile` and a path of the right shape is an account in it, written `@bkazemi` as a reader would know it. That option requires `hosts`, since a handle means nothing without the namespace it belongs to, and an instance reading any host is in no position to award one.

The holder chooses the address, so an unguarded fetch here would be an open proxy. Reads are HTTPS on the default port, never an address literal, never followed through a redirect, and bounded in both time and bytes, counted after a compressed body is decompressed — a page too large to finish reading reports that it could not be read, rather than that the link is absent. Without `hosts`, every address the name resolves to must be on the public internet, and that is checked in the connection's own lookup, so the socket connects to the address that passed and a DNS answer cannot change between the check and the fetch. The request itself is made with [undici](https://github.com/nodejs/undici), the library Node's own `fetch` is built on, given that lookup for every connection it opens. That needs Node; elsewhere, such as on Cloudflare Workers, `linkProvider()` refuses to start without `hosts`. Passing `fetch` replaces the transport and this check with it, so pass one only where it keeps requests out of your network itself.

Only a response served as `text/html` has its body read, since a browser shows anything else as text, where markup is an example of a link rather than one. XHTML is refused too: it is XML, where namespaces decide what an element is, and an HTML parser would misread it. The page is decoded in the encoding a browser would use — a byte order mark, then the response's `charset`, then a `<meta>` near the top — and parsed as a browser would parse it, and only real `<a>` and `<link>` elements count: markup inside a comment, a script, an attribute value, a `<textarea>` or `<title>`, or a `<template>` is text, not a link. Relative links resolve against the page's `<base href>` where it has one. On a page too large to read whole, a relative link found before any `<base>` does not count, since the unread rest could still declare one that sends it elsewhere. `rel` is matched as a token, split on ASCII whitespace as HTML splits it, so `theme` is not `me` and neither is `nofollow&nbsp;me`. A `Link:` response header carrying the relation counts too, whatever the page's type, and resolves against the page's address. The header is parsed by its grammar, so `rel=me` inside a quoted parameter such as a `title` is not a relation, and a link whose `anchor` names another resource is not one of this page's.

A link matches the subject by scheme, host, path and the subject's query parameters. Where the subject's `profileUrl` has a fragment, as hash-routed apps give their profiles (`https://site.example/#/users/alice`), the fragment names the subject and must match exactly; otherwise a fragment on the link is ignored.

Unlike the other `location` providers, this one is not pinned to a single host by default — the fediverse has no fixed host and neither does somebody's own domain, and pinning would narrow a method meant for any site to one. Pass `hosts` where a deployment wants a narrower fetcher than the guards alone give it:

```ts
linkProvider({ name: 'a page of your own' }); // Any public host, named by address.
githubLinkProvider(); // github.com only, named @handle.

// What the preset configures, for any other host whose namespace you know:
linkProvider({
  id: 'github',
  name: 'GitHub',
  hosts: ['github.com'],
  profile: /^\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})$/,
});
```

The preset takes the id `github`, the same one `githubProvider()` and `githubGistProvider()` use, because the id names whose namespace the account is in and the method says how it was shown. That also gives it the GitHub mark on the badge with no further wiring.

What it does **not** give is a shared external id. A sign-in learns the number GitHub issued; a backlink only ever learns an address, and it uses the address as the id. Where the two meet on one record, they are matched by profile address instead — see below.

A link back is public and standing, so handing one back shows only that it exists. It can therefore never remove a connection from the external side: that takes a method whose proof the holder makes fresh.

### Several methods at once

`provider` takes an array. Methods sharing an id are ways of showing one account, and the verify page offers each as its own button:

```ts
provider: [githubProvider({ clientId, clientSecret }), githubLinkProvider()],
```

A record keeps the method it was first shown by as its main one. Showing the same account another way — by connecting again with a different method, or renewing with one — adds that method beneath the main one instead of making a second record, and the evidence page and dialog list it there (`+ Linked back to …`). Each method's proof is reread on its own; one that goes unread drops off the record until it reads again, and only the main one decides the record's status.

Two methods agree on an account when their provider-issued ids match. A method that learns only an address, such as a link back, is matched by profile address instead, without case. That is the weaker test, and it applies only to flows the local holder starts and approves: removing a connection or its sharing link from the external side takes a matching provider-issued id, so whoever holds a username next cannot remove the record the last holder's link back proved.

A proof that names the subject, as a link back names its address, proves the subject at that address only. If the site later gives the subject a new `profileUrl`, a record first shown by such a proof is not joined by a flow for the new address, and further proofs naming the old address are dropped when a record is joined.

## Contract and operations

Defaults: verification lasts **30 days**, flows **10 minutes**, sharing links **7 days**. Configure `validityMs`, `flowTtlMs`, and `shareTtlMs` in milliseconds. All evidence responses use **no-store**; declarative badges refresh every **30 seconds** and remove their active presentation if refresh fails. Manual `mountBadge` calls render once; adopters must call again at least every 30 seconds. The evidence page is authoritative at request time. Nothing here claims continuous ownership.

Call `verity.service.prune()` periodically; the example runs it hourly. It deletes expired flows and removes expired/revoked evidence after a default 90-day history period. See the retention policy before changing that period.

### Rechecking published proofs

A sign-in happened once and stays happened, so it needs no upkeep. A published proof is different: it is only true while the artifact is still published, and the holder can delete it without telling anyone. Backends using an artifact provider must therefore call `verity.service.recheck()` on the same schedule; the Cloudflare example runs it hourly beside `prune()`.

Each run reads the proofs that are due, oldest first, and takes a `budget` argument bounding how many it reads (default 5) because providers rate-limit unauthenticated callers. A proof is re-read every `recheckMs` (default 24 hours) and counts as current for `freshnessMs` after its last successful read (default 7 days); `freshnessMs` must exceed `recheckMs`, so a few failed reads in a row change nothing. Past that, the connection reports `expired` and drops out of `published()` until a later read succeeds. A failed read writes nothing at all: a provider being down is not a revocation, and nothing here revokes on the holder's behalf.

**A backend that never calls `recheck()` must set `freshnessMs: Infinity`.** Otherwise every artifact-proved connection ages out after a week, correctly: a proof nobody reads is a proof nobody has confirmed. Renderers word that state as _Unconfirmed_ rather than _Expired_, since the approval itself has not run out.

A proof Verity hosts cannot go missing behind your back, so it never goes stale and is marked `hosted` in the evidence. What can still change is the identity behind it, and a method with somewhere to say so is asked instead: `pgpProvider()` looks the fingerprint up on `keys.openpgp.org` (configurable via `keyserver`) and, if the key now carries a revocation, revokes the connection. That is a revocation rather than staleness, because publishing a revocation certificate is an affirmative act by the keyholder, and unlike staleness it does not reverse.

The keyserver is never trusted. A revocation is a self-signature, checked against the key Verity already holds, so a hostile or MITM'd keyserver cannot revoke anyone's links — it can only withhold a revocation, which is the same as being unreachable. A key that was never uploaded has nowhere for a revocation to be, and silence is not read as one.

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
