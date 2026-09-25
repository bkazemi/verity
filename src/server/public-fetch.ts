import type { LookupFunction } from 'node:net';
import type { Dispatcher } from 'undici';

/** What a name resolved to, as `dns.lookup(name, { all: true })` gives it. */
export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A fetch that only ever connects to public addresses. Checking the name before fetching
 * is not enough: whoever runs its DNS can answer the check with a public address and the
 * fetch with an internal one. So the check runs inside the connection's own lookup, and
 * the socket connects to exactly the address that passed. A name with any internal
 * address among its answers is refused outright rather than raced, and an address written
 * into the URL, which no lookup sees, is checked before connecting.
 *
 * Node only, since it needs a say in how the socket resolves; the request itself is
 * undici's `fetch`, the one Node's own is built on, so the response is read and checked as
 * `fetch` reads it. A redirect is never followed, and is reported as an error.
 *
 * `allowed` decides which addresses may be connected to, and is only for tests.
 */
export function publicFetch(
  resolve: Resolve = system,
  allowed?: (address: string) => boolean,
): Fetch {
  let dispatcher: Dispatcher | undefined;

  return async (url, init) => {
    const { Agent, fetch } = await import('undici');
    const { isIP } = await import('node:net');
    const permitted = allowed ?? (await import('./addresses.js')).publicAddress;
    const host = new URL(url).hostname.replace(/^\[(.*)\]$/, '$1');

    if (isIP(host) && !permitted(host)) throw new Error('Not an address this can read');

    // Every connection this pools is made through that lookup.
    dispatcher ??= new Agent({ connect: { lookup: pinned(resolve, permitted) } });

    try {
      const response = await fetch(url, {
        ...(init as Parameters<typeof fetch>[1]),
        redirect: 'error',
        dispatcher,
      });

      return response as unknown as Response;
    } catch (error) {
      // `fetch` reports every network failure as "fetch failed", with the reason beneath.
      throw error instanceof TypeError && error.cause instanceof Error ? error.cause : error;
    }
  };
}

/** A lookup that answers only with addresses that are all permitted, or not at all. */
function pinned(resolve: Resolve, permitted: (address: string) => boolean): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (!addresses.length || !addresses.every(({ address }) => permitted(address))) {
          callback(new Error('Not an address this can read'), '', 0);

          return;
        }

        if (options.all) callback(null, addresses);
        else callback(null, addresses[0]!.address, addresses[0]!.family);
      },
      (error: Error) => callback(error, '', 0),
    );
  };
}

/** Whether this runtime is Node, the only one that lets `publicFetch()` pin its lookup. */
export function pinnable(): boolean {
  return globalThis.navigator?.userAgent?.startsWith('Node.js/') ?? false;
}

const system: Resolve = async (host) => {
  const { lookup } = await import('node:dns/promises');

  return lookup(host, { all: true, verbatim: true });
};
