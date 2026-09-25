import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import type * as Stream from 'node:stream';
import type * as Zlib from 'node:zlib';

/** What a name resolved to, as `dns.lookup(name, { all: true })` gives it. */
export type Resolve = (host: string) => Promise<{ address: string; family: number }[]>;

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * A fetch that only ever connects to public addresses. Checking the name before fetching
 * is not enough: whoever runs its DNS can answer the check with a public address and the
 * fetch with an internal one. So the check runs inside the connection's own lookup, and
 * the socket connects to exactly the address that passed. A name with any internal
 * address among its answers is refused outright rather than raced.
 *
 * Node only, since it needs a say in how the socket resolves. A redirect is never
 * followed, and one is reported as an error, as `fetch` does with `redirect: 'error'`. A
 * compressed body is decompressed, as `fetch` does, since Node leaves that to its caller.
 */
export function publicFetch(resolve: Resolve = system): Fetch {
  return async (url, init) => {
    const { request } = await import('node:https');
    const node = { stream: await import('node:stream'), zlib: await import('node:zlib') };

    const lookup: LookupFunction = (hostname, options, callback) => {
      resolve(hostname).then(
        (addresses) => {
          if (!addresses.length || !addresses.every(({ address }) => publicAddress(address))) {
            callback(new Error('Not an address this can read'), '', 0);

            return;
          }

          if (options.all) callback(null, addresses);
          else callback(null, addresses[0]!.address, addresses[0]!.family);
        },
        (error: Error) => callback(error, '', 0),
      );
    };

    return new Promise<Response>((resolved, rejected) => {
      const outgoing = request(
        url,
        {
          method: 'GET',
          headers: {
            'accept-encoding': accepted(node.zlib),
            ...Object.fromEntries(new Headers(init.headers)),
          },
          lookup,
          // A pooled socket would be one this lookup never saw.
          agent: false,
          signal: init.signal ?? undefined,
        },
        (incoming) => {
          // Anything thrown here is thrown on Node's own callback, where no promise hears
          // of it and the process goes down instead.
          try {
            resolved(respond(incoming, node));
          } catch (error) {
            incoming.destroy();
            rejected(error);
          }
        },
      );

      outgoing.on('error', rejected);
      outgoing.end();
    });
  };
}

/**
 * The response Node read, as a `Response`. Node's parser takes any three-digit status and
 * header bytes that `Response` and `Headers` refuse, and the far side chooses both, so
 * anything they refuse is an error here rather than an exception out of a callback.
 */
export function respond(
  incoming: IncomingMessage,
  { stream, zlib }: { stream: typeof Stream; zlib: typeof Zlib },
): Response {
  const status = incoming.statusCode ?? 0;

  if (status >= 300 && status < 400) throw new Error('Redirects are not followed');

  if (status < 200 || status > 599) throw new Error('Not an HTTP status');

  const headers = new Headers();

  for (const [key, value] of Object.entries(incoming.headers))
    for (const one of [value ?? []].flat()) headers.append(key, one);

  const empty = status > 299 || status === 204 || status === 205;

  if (empty) {
    incoming.destroy();

    return new Response(null, { status, headers });
  }

  const body = decompressed(incoming, headers, { stream, zlib });

  headers.delete('content-encoding');
  headers.delete('content-length');

  return new Response(stream.Readable.toWeb(body) as ReadableStream, { status, headers });
}

/**
 * The body with its content codings undone, last applied first. Whatever reads it bounds
 * the decompressed bytes, and the decompressors only work as far ahead as that reader asks,
 * so a small body that expands without end is cut off like any long one.
 */
function decompressed(
  incoming: IncomingMessage,
  headers: Headers,
  { stream, zlib }: { stream: typeof Stream; zlib: typeof Zlib },
): Stream.Readable {
  const codings = (headers.get('content-encoding') ?? '')
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding && coding !== 'identity')
    .reverse();

  if (!codings.length) return incoming;

  // Each coding costs a decompressor, and the far side chooses how many to list.
  if (codings.length > 5) throw new Error('Too many content encodings');

  const decoders = codings.map((coding) => {
    const decoder = decoderFor(coding, zlib);

    if (!decoder) throw new Error(`Content encoding ${coding} is not supported`);

    return decoder;
  });

  stream.pipeline([incoming, ...decoders], () => {});

  return decoders.at(-1)!;
}

function decoderFor(coding: string, zlib: typeof Zlib): Stream.Transform | undefined {
  if (coding === 'gzip' || coding === 'x-gzip') return zlib.createGunzip();

  if (coding === 'deflate') return zlib.createInflate();

  if (coding === 'br') return zlib.createBrotliDecompress();

  // Node has zstd from 22.15 and 23.8.
  if (coding === 'zstd' && 'createZstdDecompress' in zlib) return zlib.createZstdDecompress();

  return undefined;
}

/** The codings to ask for: the ones `decoderFor` undoes on this Node. */
function accepted(zlib: typeof Zlib): string {
  return ['gzip', 'deflate', 'br', ...('createZstdDecompress' in zlib ? ['zstd'] : [])].join(', ');
}

/** Whether this runtime is Node, the only one that lets `publicFetch()` pin its lookup. */
export function pinnable(): boolean {
  return globalThis.navigator?.userAgent?.startsWith('Node.js/') ?? false;
}

const system: Resolve = async (host) => {
  const { lookup } = await import('node:dns/promises');

  return lookup(host, { all: true, verbatim: true });
};

interface Range {
  base: bigint;
  prefix: number;
}

// Everything that is not a unicast address on the public internet: this network, private
// and shared address space, loopback, link-local, protocol assignments, documentation and
// benchmarking ranges, multicast and the reserved block.
const reservedV4 = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '100.64.0.0/10',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '192.88.99.0/24',
  '192.168.0.0/16',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
].map((cidr) => range(cidr, ipv4));

// IPv6 is allowed only inside global unicast, less the parts of it that are protocol
// assignments (Teredo among them), documentation, 6to4 relays that tunnel to any IPv4
// address, and segment routing.
const globalV6 = range('2000::/3', ipv6);

const reservedV6 = ['2001::/23', '2001:db8::/32', '2002::/16', '3fff::/20', '5f00::/16'].map(
  (cidr) => range(cidr, ipv6),
);

// These carry an IPv4 address in their low 32 bits, and are judged by it.
const mappedV6 = range('::ffff:0:0/96', ipv6);
const nat64V6 = range('64:ff9b::/96', ipv6);

/** Whether an address is somewhere on the public internet, as opposed to inside a network. */
export function publicAddress(address: string): boolean {
  const v4 = ipv4(address);

  if (v4 !== undefined) return !reservedV4.some((reserved) => within(v4, reserved, 32));

  const v6 = ipv6(address);

  if (v6 === undefined) return false;

  if (within(v6, mappedV6, 128) || within(v6, nat64V6, 128))
    return publicAddress(fromV4(v6 & 0xffffffffn));

  return within(v6, globalV6, 128) && !reservedV6.some((reserved) => within(v6, reserved, 128));
}

function range(cidr: string, parse: (text: string) => bigint | undefined): Range {
  const [base, prefix] = cidr.split('/');

  return { base: parse(base!)!, prefix: Number(prefix) };
}

function within(value: bigint, { base, prefix }: Range, width: number): boolean {
  const shift = BigInt(width - prefix);

  return value >> shift === base >> shift;
}

function ipv4(text: string): bigint | undefined {
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)?.slice(1).map(Number);

  if (!octets || octets.some((octet) => octet > 255)) return undefined;

  return octets.reduce((value, octet) => (value << 8n) | BigInt(octet), 0n);
}

const fromV4 = (value: bigint) =>
  [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join('.');

function ipv6(text: string): bigint | undefined {
  const halves = text.split('%')[0]!.split('::');

  if (halves.length > 2) return undefined;

  const [head, tail] = halves.map((half) => (half ? half.split(':').flatMap(groups) : []));
  let all = head!;

  if (tail !== undefined) {
    const missing = 8 - head!.length - tail.length;

    if (missing < 1) return undefined;

    all = [...head!, ...Array<string>(missing).fill('0'), ...tail];
  }

  if (all.length !== 8 || !all.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) return undefined;

  return all.reduce((value, group) => (value << 16n) | BigInt(`0x${group}`), 0n);
}

/** A group, or the two groups a trailing dotted IPv4 address stands for. */
function groups(group: string): string[] {
  const v4 = ipv4(group);

  if (v4 === undefined) return [group];

  return [(v4 >> 16n).toString(16), (v4 & 0xffffn).toString(16)];
}
