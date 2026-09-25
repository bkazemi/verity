import { legacyHookDecode } from '@exodus/bytes/encoding.js';
import htmlEncodingSniffer from 'html-encoding-sniffer';
import { MIMEType } from 'node:util';
import { html, parse, type DefaultTreeAdapterTypes } from 'parse5';
import type { ArtifactProvider, ExternalAccount, LocalAccount } from '../core/index.js';
import { discard, readBounded } from './body.js';
import { pinnable, publicFetch, type Fetch } from './public-fetch.js';

/**
 * Domain suffixes that must never be fetched. The holder names the address, so it names
 * the host, and these are the names that can resolve to something inside the network
 * running this. Reserved suffixes that resolve nowhere are left alone: asking about them
 * is pointless rather than dangerous, and they are what tests use.
 */
const reserved = ['local', 'internal', 'localhost', 'home', 'lan', 'corp', 'intranet'];

const name = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

export interface LinkProviderOptions {
  /**
   * Whose namespace a verified page is in. One instance reading many hosts has one
   * namespace, because the address is the identity and addresses do not collide.
   */
  id?: string;
  /** Shown as "Verify with …". Only the operator knows what their instance reads. */
  name: string;
  /**
   * Hosts this instance will read, lowercase and without a port. Omitted means any public
   * host, which is the point of the method: the fediverse has no fixed host and neither
   * does somebody's own domain. Set it when the deployment wants a narrower fetcher than
   * the guards alone give it.
   */
  hosts?: string[];
  /**
   * Which paths on those hosts are somebody's profile, capturing the handle. A page is
   * named by its address because fetching one establishes no account — but on a host whose
   * namespace the deployment has named, a path of the right shape is an account in it, and
   * `github.com/bkazemi` is written `@bkazemi` as a reader would know it.
   *
   * Requires `hosts`. A handle means nothing without the namespace it belongs to, so an
   * instance that reads any host is in no position to award one.
   */
  profile?: RegExp;
  /**
   * Replaces the transport, and with it the check that keeps an instance reading any host
   * out of the network it runs in. Pass one only where it enforces that itself, such as
   * through an egress proxy, or where `hosts` already confines it.
   */
  fetch?: typeof fetch;
  /** How much of a page is read before giving up on finding the link. */
  maxBytes?: number;
  timeoutMs?: number;
}

/**
 * Proves a link by reading one back. The holder publishes an ordinary `rel="me"` link to
 * the exact local subject on a page only they can write, and hands back that page's
 * address; this reads the page and checks the link is there. No app registration, no
 * token, and nothing published for the occasion: GitHub already marks a profile's website
 * field `rel="me"`, as Mastodon does its profile links, so a holder who filled that field
 * in has already done the work.
 *
 * What it establishes is narrower than a sign-in, and the wording around it should say so.
 * `rel="me"` means "the thing at the other end is also me", so a page carrying one asserts
 * it is the same party as the subject it points at. Whoever wrote that link could write
 * that page, and nothing more: no provider was asked who holds the address, and an address
 * that changes hands carries the link with it. That is why a verified page is a `page`
 * rather than an account, and why it is named by its address instead of a handle.
 *
 * The proof is a standing link rather than a per-flow token, so it cannot be unguessable
 * and freshness comes from reading it again instead. `recheck()` does that on its schedule,
 * and a link taken down stops confirming.
 */
export function linkProvider(options: LinkProviderOptions): ArtifactProvider {
  if (!options.name) throw new Error('A link provider needs a name');

  if (options.profile && !options.hosts)
    throw new Error('A profile pattern needs the hosts whose namespace it names');

  // Flags that carry position between calls would make the same page match every other
  // time, and a pattern with nothing captured would silently name no one.
  const profile = options.profile
    ? new RegExp(options.profile.source, options.profile.flags.replace(/[gy]/g, ''))
    : undefined;

  if (profile && new RegExp(`${profile.source}|`).exec('')!.length === 1)
    throw new Error('A profile pattern needs a capturing group for the handle');

  const request = transport(options);
  const maxBytes = options.maxBytes ?? 512 * 1024;
  const hosts = options.hosts?.map((host) => host.toLowerCase());

  return {
    id: options.id ?? 'link',
    name: options.name,
    method: 'backlink',
    artifact: 'location',

    // The subject's own address is the entire claim, so there is nothing per-flow to mint.
    expect(local: LocalAccount) {
      if (!local.profileUrl)
        throw new Error('A backlink needs a local subject with a profileUrl to point at');

      return local.profileUrl;
    },

    instructions: (expect) => [
      'Add a link to this address on a page you control, marked rel="me", then paste that page’s address below.',
      { code: expect },
      'Writing the page yourself, that is one element:',
      { code: `<a rel="me" href="${expect}">${expect}</a>` },
      'On GitHub, putting the address in your profile’s website field is enough: GitHub marks that link rel="me" for you, as Mastodon does for its profile links. Paste the page’s final address, because a redirect is not followed.',
    ],

    async verify({ artifact, expect }): Promise<ExternalAccount> {
      const page = address(artifact, hosts);
      const subject = new URL(expect);

      const response = await request(page.href, {
        redirect: 'error',
        headers: { Accept: 'text/html, */*;q=0.1', 'User-Agent': 'Verity-V0' },
        signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
      });

      try {
        await backlinked(response, page, subject, maxBytes);
      } finally {
        // An answer found early, or a refusal, leaves the rest of the body on the wire,
        // where it would hold the connection until the deadline.
        await discard(response);
      }

      return account(page, profile);
    },
  };
}

/**
 * Returns once the response links the page to the subject, from its headers or from the
 * HTML it serves, and throws saying why it does not otherwise.
 */
async function backlinked(
  response: Response,
  page: URL,
  subject: URL,
  maxBytes: number,
): Promise<void> {
  if (!response.ok) throw new Error('Page unavailable');

  // A link relation is a link relation wherever it is declared, and a page with no
  // HTML of its own can still carry one in its headers.
  for (const href of headerLinks(response.headers.get('link') ?? '', page))
    if (points(href, page, subject)) return;

  // Anything else is shown as text, where markup is an example of a link and not one.
  const type = mediaType(response.headers.get('content-type'));

  if (!type || !rendered(type))
    throw new Error('Page is not HTML, and its headers carry no rel="me" link to this subject');

  // Finding the link in what was read still proves the claim; not finding it in part of
  // a page proves nothing.
  const { bytes, truncated } = await readBounded(response, maxBytes);
  const text = decode(bytes, type.params.get('charset') ?? undefined);
  const document = parse(text);
  const declared = firstBase(document);
  const base = baseUrl(declared, page);

  // Only the first `<base>` counts, so once one is read no later markup can move a link.
  // Until then, the unread rest of a page can still declare one, and a relative link read
  // from the part before it may point somewhere else on the whole page.
  const settled = !truncated || declared !== undefined;

  for (const link of elements(document, ['a', 'link'])) {
    const rel = attribute(link, 'rel');
    const href = attribute(link, 'href');

    if (
      rel !== undefined &&
      relMe(rel) &&
      href !== undefined &&
      (settled || unmoved(href)) &&
      points(href, base, subject)
    )
      return;
  }

  // Not finding it in part of a page is not the same as it not being there.
  throw new Error(
    truncated ? 'Page is too large to read' : 'Page has no rel="me" link to this subject',
  );
}

/**
 * How pages are fetched. A deployment that named its hosts has vouched for where they
 * resolve, so the platform's own fetch will do. One that reads any host has vouched for
 * nothing, and the holder picks the name: every address it resolves to is checked, on the
 * connection that uses it, which only Node lets this do.
 */
function transport(options: LinkProviderOptions): Fetch {
  if (options.fetch) return options.fetch;

  if (options.hosts) return (url, init) => fetch(url, init);

  if (!pinnable())
    throw new Error(
      'Reading any host needs Node, which lets it check where a name resolves; name the hosts to read instead',
    );

  return publicFetch();
}

/**
 * The address the holder handed back, once it is one this may fetch. They choose it, so
 * an unguarded fetch here is an open proxy: HTTPS only, a public-looking name rather than
 * an address literal or a suffix that resolves inside the network, and the default port.
 * Where the name really resolves is checked when it is fetched.
 */
function address(artifact: string, hosts?: string[]): URL {
  if (artifact.length > 2000) throw new Error('Not an address this can read');

  const url = new URL(artifact);
  const host = url.hostname.toLowerCase();

  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    (url.port && url.port !== '443') ||
    !name.test(host) ||
    /^[\d.]+$/.test(host) ||
    reserved.includes(host.split('.').pop()!)
  )
    throw new Error('Not an address this can read');

  if (hosts && !hosts.includes(host)) throw new Error('Not a host this instance reads');

  return url;
}

/**
 * What was read, named by where it is, because on an unnamed host that is all reading it
 * established. Where the deployment has named the namespace and the path is one of its
 * profiles, the handle is what a reader recognises and is used instead.
 *
 * The id stays the address either way. It is what the record is matched on later, and a
 * handle that changed hands would go on matching while proving nothing; the address stops
 * resolving, so the next recheck says so. Where a record was first shown by a sign-in,
 * which learns the id the provider issued, the service matches this one to it by profile
 * address instead, and only in flows the local holder runs.
 */
function account(page: URL, profile?: RegExp): ExternalAccount {
  // A query says this is some view of a page rather than the bare profile, and two views
  // of one profile would otherwise be two records wearing the same handle.
  const path = page.pathname.replace(/\/+$/, '');
  const handle = page.search ? undefined : profile?.exec(path || '/')?.[1];

  // A profile is the account whether or not its address ends in a slash, because the
  // deployment named a host that treats them alike.
  if (handle) {
    const canonical = `${page.origin}${path}`;

    return { id: canonical, kind: 'account', handle, profileUrl: canonical };
  }

  // Any other page is exactly what was read. On an arbitrary host `/foo/` and `/foo` can
  // be two resources, and only one of them was shown to carry the link.
  const canonical = `${page.origin}${page.pathname}${page.search}`;

  return {
    id: canonical,
    kind: 'page',
    handle: canonical.replace(/^https:\/\//, ''),
    profileUrl: canonical,
  };
}

/**
 * GitHub profile pages. A path of one segment shaped like a username is an account in
 * GitHub's namespace, which is the same namespace `githubProvider()` and
 * `githubGistProvider()` name: the id says whose account it is and the method says how it
 * was shown. This one needs no OAuth app and no API call, because the holder's profile
 * carries `rel="me"` on its website field already.
 */
export function githubLinkProvider(
  options: Omit<LinkProviderOptions, 'id' | 'name' | 'hosts' | 'profile'> = {},
): ArtifactProvider {
  return linkProvider({
    ...options,
    id: 'github',
    name: 'GitHub',
    hosts: ['github.com'],
    // GitHub's own rule: alphanumerics and single hyphens, never leading or trailing, 39 max.
    profile: /^\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})$/,
  });
}

/**
 * Whether a link points at the subject. Every key in the subject's query must carry the
 * same values in the same order on the link, since a site whose profiles differ only by a
 * parameter would otherwise have every one of them proved by a link to any other. Keys the
 * far side adds on top are ignored, because that is where tracking junk lands.
 */
function points(href: string, base: URL, subject: URL): boolean {
  let target: URL;

  try {
    target = new URL(href, base);
  } catch {
    return false;
  }

  // A subject with a fragment is one of the views a hash-routed page serves, so the
  // fragment names it and must match. A fragment on the link alone is a spot on the page.
  if (
    target.protocol !== subject.protocol ||
    target.host.toLowerCase() !== subject.host.toLowerCase() ||
    trim(target.pathname) !== trim(subject.pathname) ||
    (subject.hash !== '' && target.hash !== subject.hash)
  )
    return false;

  // Every value of a key the subject uses, in order: a site reading the last of a repeated
  // parameter takes `?user=alice&user=bob` for bob, whatever the first one says.
  for (const key of new Set(subject.searchParams.keys())) {
    const wanted = subject.searchParams.getAll(key);
    const found = target.searchParams.getAll(key);

    if (found.length !== wanted.length || found.some((value, at) => value !== wanted[at]))
      return false;
  }

  return true;
}

const trim = (path: string) => path.replace(/\/+$/, '') || '/';

/**
 * `rel` is a space-separated token list, so `me` matches a token and never `theme`. The
 * spaces are ASCII whitespace only: to HTML, `nofollow&nbsp;me` is one token and not `me`.
 */
function relMe(rel: string): boolean {
  return rel.split(/[\t\n\f\r ]+/).some((token) => token.toLowerCase() === 'me');
}

/**
 * The named HTML elements on the page, in document order, as a browser would build it.
 * Text that only looks like one — in a comment, a script, an attribute value, a
 * `<textarea>` or `<title>`, or an inert `<template>` — is no element at all, and on a page
 * that takes contributions it can be written by somebody other than the page's author.
 * Walked without recursion, because the nesting depth is the page's to choose.
 */
function elements(
  document: DefaultTreeAdapterTypes.Document,
  names: string[],
): DefaultTreeAdapterTypes.Element[] {
  const found: DefaultTreeAdapterTypes.Element[] = [];
  const pending: DefaultTreeAdapterTypes.ChildNode[] = [...document.childNodes].reverse();

  for (let node = pending.pop(); node; node = pending.pop()) {
    if (!('tagName' in node)) continue;

    if (node.namespaceURI === html.NS.HTML && names.includes(node.tagName)) found.push(node);

    for (let at = node.childNodes.length - 1; at >= 0; at--) pending.push(node.childNodes[at]!);
  }

  return found;
}

/**
 * The page as text, in the encoding a browser would read it in: a byte order mark first,
 * then the charset the response declared, then a `<meta>` near the top, and the standard's
 * default after that. Read any other way, a page in UTF-16 or a legacy encoding shows this
 * different characters, and so different links, from the ones its readers see.
 */
function decode(bytes: Uint8Array, charset: string | undefined): string {
  const encoding = htmlEncodingSniffer(bytes, {
    ...(charset ? { transportLayerEncodingLabel: charset } : {}),
  });

  return legacyHookDecode(bytes, encoding);
}

/** The `href` of the page's first `<base>` that has one, which is the one a browser uses. */
function firstBase(document: DefaultTreeAdapterTypes.Document): string | undefined {
  return elements(document, ['base'])
    .map((base) => attribute(base, 'href'))
    .find((value) => value !== undefined);
}

/**
 * What the page's relative links are relative to: its declared base, as a browser takes
 * it, and otherwise the page itself. A link header has no base but the page.
 */
function baseUrl(declared: string | undefined, page: URL): URL {
  if (declared === undefined) return page;

  try {
    const base = new URL(declared, page);

    return base.protocol === 'data:' || base.protocol === 'javascript:' ? page : base;
  } catch {
    return page;
  }
}

/**
 * Whether no base could move a link: it resolves to the same address against two bases
 * that share nothing, not scheme, host or path. Checking the text for a scheme would not
 * do, because `https:/u/alice` is relative to an https base and `\\host` is `//host`.
 */
function unmoved(href: string): boolean {
  try {
    return (
      new URL(href, 'https://one.invalid/a/b').href === new URL(href, 'http://two.invalid/c/').href
    );
  } catch {
    return false;
  }
}

/**
 * A `Content-Type` parsed as the web's MIME standard parses it, or nothing where it is
 * missing or malformed. Two joined into one header by a comma are malformed.
 */
function mediaType(header: string | null): MIMEType | undefined {
  if (header === null) return undefined;

  try {
    return new MIMEType(header);
  } catch {
    return undefined;
  }
}

/**
 * Whether a response says it is HTML. XHTML is not taken: it is XML, where namespaces and
 * case decide what an element is, and an HTML parser would read elements it has no business
 * calling links.
 */
function rendered(type: MIMEType): boolean {
  return type.essence === 'text/html';
}

/** An attribute as the parser left it: entities decoded, and the first of any duplicates. */
function attribute(element: DefaultTreeAdapterTypes.Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value;
}

/**
 * The targets of `rel="me"` links in a `Link:` header, which is the same relation off the
 * page. Parsed as RFC 8288 writes it rather than matched, because a quoted parameter can
 * hold anything, `rel=me` included. A link whose `anchor` names another resource is about
 * that resource, not this page, and one this cannot parse is not believed.
 */
function headerLinks(header: string, page: URL): string[] {
  const links = linkHeader(header);
  const self = new URL(page);

  self.hash = '';

  return links
    .filter(({ params }) => {
      const rel = params.get('rel');
      const anchor = params.get('anchor');

      if (rel === undefined || !relMe(rel)) return false;

      if (anchor === undefined) return true;

      try {
        return new URL(anchor, page).href === self.href;
      } catch {
        return false;
      }
    })
    .map(({ target }) => target);
}

const token = /[!#$%&'*+.^_`|~0-9A-Za-z-]/;

/**
 * Every link in the header with its parameters, the first of any repeated one, as the RFC
 * says to take them. A header malformed anywhere yields nothing: a parser that recovered
 * would be guessing where one link ends and the next begins.
 */
function linkHeader(header: string): { target: string; params: Map<string, string> }[] {
  const links: { target: string; params: Map<string, string> }[] = [];
  let at = 0;

  const space = () => {
    while (at < header.length && /[ \t]/.test(header[at]!)) at++;
  };

  while (at < header.length) {
    while (at < header.length && /[ \t,]/.test(header[at]!)) at++;

    if (at >= header.length) break;

    if (header[at] !== '<') return [];

    const close = header.indexOf('>', at);

    if (close < 0) return [];

    const target = header.slice(at + 1, close);
    const params = new Map<string, string>();

    at = close + 1;
    space();

    while (header[at] === ';') {
      at++;
      space();

      const start = at;

      while (at < header.length && token.test(header[at]!)) at++;

      const name = header.slice(start, at).toLowerCase();
      let value = '';

      if (!name) return [];

      space();

      if (header[at] === '=') {
        at++;
        space();

        if (header[at] === '"') {
          at++;

          while (at < header.length && header[at] !== '"') {
            if (header[at] === '\\') at++;

            value += header[at] ?? '';
            at++;
          }

          if (header[at] !== '"') return [];

          at++;
        } else {
          const from = at;

          while (at < header.length && token.test(header[at]!)) at++;

          value = header.slice(from, at);
        }
      }

      if (!params.has(name)) params.set(name, value);

      space();
    }

    if (at < header.length && header[at] !== ',') return [];

    links.push({ target, params });
  }

  return links;
}
