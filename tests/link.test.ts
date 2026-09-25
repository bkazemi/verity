import { test } from 'node:test';
import assert from 'node:assert/strict';
import { linkProvider } from '../src/server/link.js';
import { createServer, type AddressInfo } from 'node:net';
import * as zlib from 'node:zlib';
import { publicAddress } from '../src/server/addresses.js';
import { publicFetch } from '../src/server/public-fetch.js';
import { readBounded } from '../src/server/body.js';

/** The preset's own options, so these exercise what `githubLinkProvider()` configures. */
const githubOptions = () => ({
  id: 'github',
  name: 'GitHub',
  hosts: ['github.com'],
  profile: /^\/([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})$/,
});

import { VerityService } from '../src/server/service.js';
import { attestationLabel, externalName } from '../src/core/index.js';
import { alice, bob, MemoryStorage, written } from './helpers.js';

const expect = 'https://site.test/u/alice';

const page = 'https://example.test/about';

function provider(
  body: string,
  init: ResponseInit = {},
  options: Parameters<typeof linkProvider>[0] = { name: 'a page of your own' },
) {
  const calls: { url: string; init?: RequestInit }[] = [];

  const instance = linkProvider({
    ...options,
    fetch: ((url: string, requestInit?: RequestInit) => {
      calls.push({ url: String(url), init: requestInit });

      return Promise.resolve(
        new Response(body, {
          status: 200,
          ...init,
          headers: { 'content-type': 'text/html; charset=utf-8', ...init.headers },
        }),
      );
    }) as unknown as typeof fetch,
  });

  return { instance, calls };
}

// The page is named by where it is: reading it established an address, never an account.
const read = { id: page, kind: 'page', handle: 'example.test/about', profileUrl: page };

test('a rel="me" link to the subject proves the page that carries it', async () => {
  const { instance, calls } = provider(`<a rel="me" href="${expect}">me</a>`);

  assert.deepEqual(await instance.verify({ artifact: page, expect }), read);

  assert.equal(calls[0]!.url, page);
  // The holder names the address, so a redirect would take the check somewhere else.
  assert.equal(calls[0]!.init?.redirect, 'error');
});

test("GitHub's own profile markup proves the account", async () => {
  // Copied from https://github.com/bkazemi: the website field, exactly as GitHub writes it.
  const { instance } = provider(
    `<a rel="nofollow me" class="Link--primary wb-break-all" href="${expect}">`,
  );

  assert.deepEqual(await instance.verify({ artifact: page, expect }), read);
});

test('rel is a token list, so me is never matched inside another word', async () => {
  // Only ASCII whitespace separates tokens: to HTML, a no-break space is part of one.
  for (const rel of [
    'theme',
    'home',
    'readme',
    'me-too',
    'nofollow',
    '',
    'nofollow&nbsp;me',
    'nofollow\u00a0me',
    'nofollow\u2003me',
    '\u00a0me',
  ])
    await assert.rejects(
      provider(`<a rel="${rel}" href="${expect}">x</a>`).instance.verify({
        artifact: page,
        expect,
      }),
      `accepted rel="${rel}"`,
    );

  for (const rel of [
    'me',
    'nofollow me',
    'ME',
    ' me  noopener ',
    'nofollow\tme',
    'nofollow&#10;me',
  ])
    assert.deepEqual(
      await provider(`<a rel="${rel}" href="${expect}">x</a>`).instance.verify({
        artifact: page,
        expect,
      }),
      read,
      `refused rel="${rel}"`,
    );
});

test('the relation counts wherever it is declared', async () => {
  assert.deepEqual(
    await provider(`<head><link rel="me" href="${expect}"></head>`).instance.verify({
      artifact: page,
      expect,
    }),
    read,
  );

  assert.deepEqual(
    await provider('', { headers: { link: `<${expect}>; rel="me"` } }).instance.verify({
      artifact: page,
      expect,
    }),
    read,
  );

  await assert.rejects(
    provider('', { headers: { link: `<${expect}>; rel="alternate"` } }).instance.verify({
      artifact: page,
      expect,
    }),
  );
});

test("a header link is read as the header's grammar has it", async () => {
  const header = (link: string) =>
    provider('', { headers: { link } }).instance.verify({ artifact: page, expect });

  for (const link of [
    `<${expect}>; rel=me`,
    `<https://x.test/>; rel="alternate", <${expect}>; title="a, b; c"; rel="nofollow me"`,
    `<${expect}>; rel="me"; anchor="${page}"`,
    `<${expect}>; rel="me"; anchor="/about"`,
    `<${expect}>; rel="me"; rel="alternate"`,
  ])
    assert.deepEqual(await header(link), read, `refused ${link}`);

  for (const link of [
    // Only quoted text: there is no rel parameter here at all.
    `<${expect}>; title="Example; rel=me; text"`,
    `<${expect}>; title="rel=\\"me\\""`,
    // A relation of some other resource, not of this page.
    `<${expect}>; rel="me"; anchor="https://other.test/about"`,
    `<${expect}>; rel="me"; anchor="#section"`,
    // The first rel is the one that counts.
    `<${expect}>; rel="alternate"; rel="me"`,
    // Unparseable: nothing in it is believed.
    `<${expect}>; rel="me`,
    `<${expect}>; rel="me" junk`,
    `${expect}; rel="me"`,
  ])
    await assert.rejects(header(link), `accepted ${link}`);
});

test('a link to something else does not prove the subject', async () => {
  for (const href of [
    'https://site.test/u/bob',
    'https://site.test/',
    'https://evil.test/u/alice',
    'http://site.test/u/alice',
    'https://site.test.evil.test/u/alice',
  ])
    await assert.rejects(
      provider(`<a rel="me" href="${href}">x</a>`).instance.verify({ artifact: page, expect }),
      `accepted a link to ${href}`,
    );
});

test('subjects that differ only by a query parameter are not conflated', async () => {
  const alice = 'https://site.test/profile?user=alice';

  await assert.rejects(
    provider('<a rel="me" href="https://site.test/profile?user=bob">x</a>').instance.verify({
      artifact: page,
      expect: alice,
    }),
  );

  // A key the subject uses must carry exactly its values: a site reading the last of a
  // repeated parameter takes this link for bob.
  for (const href of [
    'https://site.test/profile?user=alice&amp;user=bob',
    'https://site.test/profile?user=bob&amp;user=alice',
  ])
    await assert.rejects(
      provider(`<a rel="me" href="${href}">x</a>`).instance.verify({
        artifact: page,
        expect: alice,
      }),
      `accepted ${href}`,
    );

  // A subject that repeats a key is proved by a link repeating it the same way.
  const both = 'https://site.test/profile?tag=a&tag=b';

  assert.deepEqual(
    await provider(
      '<a rel="me" href="https://site.test/profile?tag=a&amp;tag=b&amp;ref=x">x</a>',
    ).instance.verify({ artifact: page, expect: both }),
    read,
  );

  await assert.rejects(
    provider('<a rel="me" href="https://site.test/profile?tag=b&amp;tag=a">x</a>').instance.verify({
      artifact: page,
      expect: both,
    }),
  );

  // What the far side adds on top of it is somebody's tracking, not part of the claim.
  assert.deepEqual(
    await provider(
      '<a rel="me" href="https://site.test/profile?user=alice&amp;utm_source=x">x</a>',
    ).instance.verify({ artifact: page, expect: alice }),
    read,
  );
});

test('a trailing slash and a protocol-relative address are the same address', async () => {
  assert.deepEqual(
    await provider(`<a rel="me" href="${expect}/">x</a>`).instance.verify({
      artifact: page,
      expect,
    }),
    read,
  );

  assert.deepEqual(
    await provider('<a rel=me href=//site.test/u/alice>x</a>').instance.verify({
      artifact: page,
      expect,
    }),
    read,
  );
});

test('a page is named exactly as it was read, trailing slash and all', async () => {
  const body = `<a rel="me" href="${expect}">x</a>`;

  for (const artifact of ['https://example.test/foo/', 'https://example.test/foo'])
    assert.equal(
      (await provider(body).instance.verify({ artifact, expect })).id,
      artifact,
      artifact,
    );

  assert.equal(
    (await provider(body).instance.verify({ artifact: 'https://example.test', expect })).id,
    'https://example.test/',
  );
});

test('markup nobody sees is not a link on the page', async () => {
  for (const body of [
    `<!-- <a rel="me" href="${expect}">x</a> -->`,
    `<script>var s = '<a rel="me" href="${expect}"></a>';</script>`,
    `<style>/* <a rel="me" href="${expect}"></a> */</style>`,
    `<script>'<a rel="me" href="${expect}"></a>'`,
  ])
    await assert.rejects(
      provider(body).instance.verify({ artifact: page, expect }),
      `accepted ${body}`,
    );
});

test('text that only reads like a link is not an element on the page', async () => {
  const link = `<a rel="me" href="${expect}"></a>`;

  for (const body of [
    `<textarea>${link}</textarea>`,
    `<title>${link}</title>`,
    `<div title='${link}'></div>`,
    `<div data-x=${link.replace(/ /g, '&#32;')}></div>`,
    `<template>${link}</template>`,
    `<noscript>${link}</noscript>`,
    `<p>&lt;a rel="me" href="${expect}"&gt;</p>`,
    `<xmp>${link}</xmp>`,
    `<plaintext>${link}`,
  ])
    await assert.rejects(
      provider(body).instance.verify({ artifact: page, expect }),
      `accepted ${body}`,
    );
});

test('attributes are read as a browser reads them', async () => {
  for (const body of [
    `<a rel=me href=${expect}>x</a>`,
    `<a rel="&#109;e" href="${expect.replace('/', '&#x2F;')}">x</a>`,
    `<div><p><a class="x" rel="me" href="${expect}">x</div>`,
    `<link rel="me" href="${expect}">`,
  ])
    assert.deepEqual(
      await provider(body).instance.verify({ artifact: page, expect }),
      read,
      `refused ${body}`,
    );

  // The first of two attributes is the one that counts.
  await assert.rejects(
    provider(`<a rel="nofollow" rel="me" href="${expect}">x</a>`).instance.verify({
      artifact: page,
      expect,
    }),
  );
});

test('a page shown as text has no links in it, though its headers still can', async () => {
  const body = `<a rel="me" href="${expect}">x</a>`;

  for (const type of ['text/plain', 'application/json', 'text/markdown', ''])
    await assert.rejects(
      provider(body, { headers: { 'content-type': type } }).instance.verify({
        artifact: page,
        expect,
      }),
      /not HTML/,
      `accepted ${type || 'no type'}`,
    );

  // XHTML is XML, where this element is in no HTML namespace and so is not a link at all.
  await assert.rejects(
    provider(`<a xmlns="urn:not-html" rel="me" href="${expect}"/>`, {
      headers: { 'content-type': 'application/xhtml+xml' },
    }).instance.verify({ artifact: page, expect }),
    /not HTML/,
  );

  assert.deepEqual(
    await provider('plain text', {
      headers: { 'content-type': 'text/plain', link: `<${expect}>; rel="me"` },
    }).instance.verify({ artifact: page, expect }),
    read,
  );
});

test("a relative link is relative to the page's base, not only its address", async () => {
  // The link on this page goes to other.test, whatever host served it.
  await assert.rejects(
    provider(`<base href="https://other.test/"><a rel="me" href="/u/alice">x</a>`).instance.verify({
      artifact: 'https://site.test/about',
      expect,
    }),
  );

  assert.deepEqual(
    await provider(
      `<base target="_blank"><base href="https://site.test/u/"><base href="https://x.test/"><a rel="me" href="alice">x</a>`,
    ).instance.verify({ artifact: page, expect }),
    read,
  );

  // A header link is resolved against the page, since no base in the body applies to it.
  assert.deepEqual(
    await provider(`<base href="https://other.test/">`, {
      headers: { link: '<https://site.test/u/alice>; rel="me"' },
    }).instance.verify({ artifact: page, expect }),
    read,
  );
});

test('a subject named by its fragment is only proved by a link with that fragment', async () => {
  const alice = 'https://site.test/#/users/alice';
  const bob = 'https://site.test/#/users/bob';
  const link = `<a rel="me" href="${alice}">x</a>`;

  assert.deepEqual(await provider(link).instance.verify({ artifact: page, expect: alice }), read);

  for (const subject of [bob, 'https://site.test/#/users/alicia'])
    await assert.rejects(
      provider(link).instance.verify({ artifact: page, expect: subject }),
      `accepted ${subject}`,
    );

  await assert.rejects(
    provider(`<a rel="me" href="https://site.test/">x</a>`).instance.verify({
      artifact: page,
      expect: alice,
    }),
  );

  // Without one in the subject, a fragment on the link is only a spot on the same page.
  assert.deepEqual(
    await provider(`<a rel="me" href="${expect}#bio">x</a>`).instance.verify({
      artifact: page,
      expect,
    }),
    read,
  );
});

test('a page is read in the encoding a browser would read it in', async () => {
  const markup = `<a rel="me" href="${expect}">x</a>`;

  const bytes = (body: Uint8Array, type: string, subject = expect) =>
    linkProvider({
      name: 'a page of your own',
      fetch: (() =>
        Promise.resolve(
          new Response(body as BodyInit, { headers: { 'content-type': type } }),
        )) as unknown as typeof fetch,
    }).verify({ artifact: page, expect: subject });

  const utf16le = (text: string) =>
    new Uint8Array([0xff, 0xfe, ...[...text].flatMap((c) => [c.charCodeAt(0), 0])]);

  // UTF-16, declared by the response and by its byte order mark.
  assert.deepEqual(await bytes(utf16le(markup), 'text/html; charset=utf-16le'), read);
  assert.deepEqual(await bytes(utf16le(markup), 'text/html'), read);

  // A charset declared only in the page, which puts the path in legacy bytes.
  const latin = 'https://site.test/u/caf\u00e9';
  const declared = `<meta charset="windows-1252"><a rel="me" href="${latin}">x</a>`;

  assert.deepEqual(
    await bytes(
      Uint8Array.from([...declared].map((c) => c.charCodeAt(0))),
      'text/html',
      latin,
    ).then((account) => account.id),
    page,
  );

  // Read as UTF-8 regardless, a page in UTF-16 has no links at all.
  await assert.rejects(bytes(utf16le(markup).subarray(2), 'text/html; charset=utf-8'));
});

test('an attribute holding a bracket does not hide the attributes after it', async () => {
  assert.deepEqual(
    await provider(`<a title="a > b" rel="me" href="${expect}">x</a>`).instance.verify({
      artifact: page,
      expect,
    }),
    read,
  );
});

test('the holder cannot point the check inside the network running it', async () => {
  for (const artifact of [
    'http://example.test/about',
    'https://127.0.0.1/about',
    'https://192.168.1.1/about',
    'https://localhost/about',
    'https://router.lan/about',
    'https://wiki.internal/about',
    'https://example.test:8080/about',
    'https://user:pw@example.test/about',
    'https://example/about',
  ])
    await assert.rejects(
      provider(`<a rel="me" href="${expect}">x</a>`).instance.verify({ artifact, expect }),
      `accepted ${artifact}`,
    );
});

test('a public name that resolves inside the network is never connected to', async () => {
  const answers: Record<string, string[]> = {
    'loopback.example.test': ['127.0.0.1'],
    'mixed.example.test': ['93.184.215.14', '10.0.0.5'],
    'mapped.example.test': ['::ffff:169.254.169.254'],
    'v6.example.test': ['fd00::1'],
    'nowhere.example.test': [],
  };

  const request = publicFetch((host) =>
    Promise.resolve(
      (answers[host] ?? []).map((address) => ({
        address,
        family: address.includes(':') ? 6 : 4,
      })),
    ),
  );

  for (const host of Object.keys(answers))
    await assert.rejects(request(`https://${host}/about`, {}), /Not an address/, host);
});

/**
 * A server that answers every request with the same raw bytes, reached as `site.test`
 * through a transport that may connect to this machine and nowhere else.
 */
async function raw(...response: (string | Buffer)[]) {
  let closed = false;

  const server = createServer((socket) =>
    socket.once('data', () => {
      socket.on('close', () => (closed = true));
      socket.end(Buffer.concat(response.map((part) => Buffer.from(part))));
    }),
  );

  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));

  const request = publicFetch(
    async () => [{ address: '127.0.0.1', family: 4 }],
    (address) => address === '127.0.0.1',
  );

  const url = `http://site.test:${(server.address() as AddressInfo).port}/`;

  return {
    get: () => request(url, {}),
    closed: () => closed,
    [Symbol.asyncDispose]: () => new Promise<void>((done) => server.close(() => done())),
  };
}

test('a response the far side mangled is an error or a failure, not a crash', async () => {
  // Node's parser takes any three digits; `Response` refuses them.
  for (const status of [600, 999, 99]) {
    await using server = await raw(`HTTP/1.1 ${status} X\r\ncontent-length: 0\r\n\r\n`);
    const response = await server.get().catch((error: Error) => error);

    assert.ok(response instanceof Error || !response.ok, `${status}`);
  }

  {
    await using server = await raw('HTTP/1.1 200 OK\r\nx-a: a\x01b\r\ncontent-length: 0\r\n\r\n');

    await assert.rejects(server.get());
  }

  {
    await using server = await raw(
      'HTTP/1.1 302 Found\r\nlocation: https://site.test/\r\ncontent-length: 0\r\n\r\n',
    );

    await assert.rejects(server.get(), /redirect/);
  }

  // An address written into the URL goes through no lookup, so it is checked on its own.
  const request = publicFetch(
    async () => [],
    () => false,
  );

  for (const url of ['http://127.0.0.1/', 'http://[::1]/', 'http://[::ffff:10.0.0.1]/'])
    await assert.rejects(request(url, {}), /Not an address/, url);
});

test('a compressed body is read decompressed, and bounded after decompressing', async () => {
  const html = '<a rel="me" href="https://site.test/@alice">x</a>';

  for (const [coding, bytes] of [
    ['gzip', zlib.gzipSync(html)],
    ['x-gzip', zlib.gzipSync(html)],
    ['deflate', zlib.deflateSync(html)],
    // Without the zlib wrapper, as some servers send it.
    ['deflate', zlib.deflateRawSync(html)],
    ['br', zlib.brotliCompressSync(html)],
    ['GZIP', zlib.gzipSync(html)],
    ['identity', Buffer.from(html)],
    // Listed in the order applied, so undone from the end.
    ['deflate, gzip', zlib.gzipSync(zlib.deflateSync(html))],
  ] as const) {
    await using server = await raw(
      `HTTP/1.1 200 OK\r\ncontent-encoding: ${coding}\r\ncontent-length: ${bytes.length}\r\n\r\n`,
      bytes,
    );

    assert.equal(await (await server.get()).text(), html, coding);
  }

  // 16 MiB of zeros in a few kilobytes: read no further than the bound, then let go.
  const bomb = zlib.gzipSync(Buffer.alloc(1 << 24));

  await using server = await raw(
    `HTTP/1.1 200 OK\r\ncontent-encoding: gzip\r\ncontent-length: ${bomb.length}\r\n\r\n`,
    bomb,
  );

  const { bytes, truncated } = await readBounded(await server.get(), 65536);

  assert.equal(bytes.byteLength, 65536);
  assert.ok(truncated);
  await new Promise((settled) => setTimeout(settled, 100));
  assert.ok(server.closed());
});

test('only addresses on the public internet count as public', () => {
  for (const address of [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.31.255.255',
    '192.168.0.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    'fe80::1%eth0',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '64:ff9b::a00:1',
    '2001:db8::1',
    '2001:0:4136:e378::1',
    '2002:a00:1::1',
    'not an address',
    '1:2:3:4:5:6:7:8:9',
  ])
    assert.equal(publicAddress(address), false, address);

  for (const address of [
    '1.1.1.1',
    '93.184.215.14',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '2a00:1450:4001::200e',
    '::ffff:1.1.1.1',
    '64:ff9b::101:101',
  ])
    assert.equal(publicAddress(address), true, address);
});

test('an allowlist narrows the fetcher to the hosts a deployment named', async () => {
  const pinned = { name: 'GitHub', id: 'github', hosts: ['github.com'] };
  const body = `<a rel="me" href="${expect}">x</a>`;

  await assert.rejects(provider(body, {}, pinned).instance.verify({ artifact: page, expect }));

  assert.deepEqual(
    await provider(body, {}, pinned).instance.verify({
      artifact: 'https://GitHub.com/bkazemi',
      expect,
    }),
    {
      id: 'https://github.com/bkazemi',
      kind: 'page',
      handle: 'github.com/bkazemi',
      profileUrl: 'https://github.com/bkazemi',
    },
  );
});

test('a body left unread is cancelled rather than held until the deadline', async () => {
  const exits: [string, ResponseInit][] = [
    [
      'found in a header',
      { headers: { link: `<${expect}>; rel="me"`, 'content-type': 'text/html' } },
    ],
    ['not HTML', { headers: { 'content-type': 'application/octet-stream' } }],
    ['unavailable', { status: 503 }],
  ];

  for (const [exit, init] of exits) {
    let cancelled = false;

    // A body that never ends, so only cancelling it lets go of the connection.
    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(1024)),
      cancel: () => {
        cancelled = true;
      },
    });

    const instance = linkProvider({
      name: 'a page of your own',
      fetch: (() => Promise.resolve(new Response(body, init))) as unknown as typeof fetch,
    });

    await instance.verify({ artifact: page, expect }).catch(() => undefined);
    assert.ok(cancelled, exit);
  }
});

test('a relative link read before the cut is not believed while a base could follow', async () => {
  const tail = `${'<p>padding</p>'.repeat(20)}<base href="https://other.test/">`;
  const cut = { name: 'a page of your own', maxBytes: 200 };

  // Read whole, this page links to other.test, so read in part it must not pass either.
  for (const href of ['/u/alice', '//site.test/u/alice', 'https:/u/alice'])
    await assert.rejects(
      provider(`<a rel="me" href="${href}">x</a>${tail}`, {}, cut).instance.verify({
        artifact: 'https://site.test/about',
        expect,
      }),
      /too large/,
      `accepted ${href}`,
    );

  // A link no base can move proves itself, and so does any link once a base was read.
  assert.deepEqual(
    await provider(`<a rel="me" href="${expect}">x</a>${tail}`, {}, cut).instance.verify({
      artifact: page,
      expect,
    }),
    read,
  );

  assert.deepEqual(
    await provider(
      `<base href="https://site.test/u/"><a rel="me" href="alice">x</a>${tail}`,
      {},
      cut,
    ).instance.verify({ artifact: page, expect }),
    read,
  );
});

test('a page that fills the limit exactly is only whole if it ends there', async () => {
  const link = '<a rel="me" href="/u/alice">x</a>';
  const limit = 256;
  const head = `${link}${' '.repeat(limit - link.length)}`;

  // Sent in pieces the limit falls between, so no single chunk runs past it.
  const streamed = (chunks: string[]) =>
    linkProvider({
      name: 'a page of your own',
      maxBytes: limit,
      fetch: (() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));

                controller.close();
              },
            }),
            { headers: { 'content-type': 'text/html' } },
          ),
        )) as unknown as typeof fetch,
    }).verify({ artifact: 'https://site.test/about', expect });

  // The base after the limit moves the link to other.test, as it would for a reader.
  await assert.rejects(streamed([head, '<base href="https://other.test/">']), /too large/);

  // Ending exactly at the limit is a whole page.
  assert.equal((await streamed([head])).id, 'https://site.test/about');
});

test('a page read only in part cannot report the link is absent', async () => {
  const { instance } = provider(
    `${'<p>padding</p>'.repeat(200)}<a rel="me" href="${expect}">x</a>`,
    {},
    {
      name: 'a page of your own',
      maxBytes: 64,
    },
  );

  await assert.rejects(instance.verify({ artifact: page, expect }), /too large/);
});

test('an unreachable page proves nothing', async () => {
  const { instance } = provider('', { status: 404 });

  await assert.rejects(instance.verify({ artifact: page, expect }), /unavailable/);
});

test('the subject is what the holder is told to publish', () => {
  const { instance } = provider('');

  assert.equal(
    instance.expect!({ id: 'private', label: 'Alice', reference: 'alice', profileUrl: expect }),
    expect,
  );

  assert.ok(written(instance.instructions(expect)).includes(expect));
  assert.match(written(instance.instructions(expect)), /rel="me"/);

  // Nothing to point at is a misconfiguration, not a failed check.
  assert.throws(() => instance.expect!({ id: 'private', label: 'Alice', reference: 'alice' }));
});

// The service mints an unguessable string for every other artifact method. A backlink
// cannot have one, so these cover the path where the provider states what to publish.

function backlink(body: string) {
  const storage = new MemoryStorage();

  const service = new VerityService({
    storage,
    provider: linkProvider({
      name: 'a page of your own',
      fetch: (() =>
        Promise.resolve(
          new Response(body, { status: 200, headers: { 'content-type': 'text/html' } }),
        )) as unknown as typeof fetch,
    }),
    baseUrl: 'https://site.test/api/verity',
    siteName: 'Site',
    verifierName: 'Site',
    profileOrigins: ['https://site.test'],
    now: () => 1000000,
  });

  return service;
}

test('the holder is told to publish the subject, not a string minted here', async () => {
  const service = backlink(`<a rel="me" href="${alice.profileUrl}">x</a>`);
  const flow = await service.start(alice);

  assert.equal(flow.expect, alice.profileUrl);
  assert.ok(written(flow.instructions!).includes(alice.profileUrl));

  // Deliberately not per-flow: the claim is the subject's address, which does not vary,
  // so a standing link keeps proving and is read again rather than republished.
  assert.equal((await service.start(alice)).expect, flow.expect);

  await service.submit(flow.flowId, flow.binding, 'https://example.test/about');

  const id = (await service.approve(flow.flowId, flow.binding, alice, 'public'))!;
  const evidence = await service.read(id);

  assert.equal(evidence.external.handle, 'example.test/about');
  assert.equal(externalName(evidence.external), 'example.test/about');

  assert.deepEqual(evidence.attestations!.external, {
    by: 'provider',
    method: 'backlink',
    artifactUrl: 'https://example.test/about',
    expect: alice.profileUrl,
    confirmedAt: 1000000,
  });

  assert.equal(
    attestationLabel('backlink', { site: 'Site', provider: 'a page of your own' }),
    'Linked back to Site',
  );
});

test('a standing link cannot remove a connection from the external side', async () => {
  const service = backlink(`<a rel="me" href="${alice.profileUrl}">x</a>`);
  const flow = await service.start(alice);

  await service.submit(flow.flowId, flow.binding, 'https://example.test/about');

  const id = (await service.approve(flow.flowId, flow.binding, alice, 'public'))!;

  // The link is public, so handing it back shows only that it exists. Removal from the
  // external side needs a proof its holder makes fresh, and a link back is not one.
  await assert.rejects(service.start(undefined, id, 'revoke'), /Unavailable/);

  // A renewal is the local holder's, and the record says which subject it points at.
  const renewal = await service.start(alice, id, 'renew');

  assert.equal(renewal.expect, alice.profileUrl);
});

test('a subject with no address of its own cannot be pointed at', async () => {
  await assert.rejects(backlink('').start(bob), /profileUrl/);
});

// A page is named by its address, except on a host whose namespace the deployment named.

test('a profile on a named host is the account a reader knows', async () => {
  const { instance } = provider(`<a rel="me" href="${expect}">x</a>`, {}, githubOptions());

  const external = await instance.verify({ artifact: 'https://github.com/bkazemi', expect });

  assert.deepEqual(external, {
    id: 'https://github.com/bkazemi',
    kind: 'account',
    handle: 'bkazemi',
    profileUrl: 'https://github.com/bkazemi',
  });

  assert.equal(externalName(external), '@bkazemi');
});

test('only a path shaped like a profile is one', async () => {
  for (const artifact of [
    'https://github.com/bkazemi/verity',
    'https://github.com/-bkazemi',
    'https://github.com/bkazemi-',
    'https://github.com/bkaze--mi',
    `https://github.com/${'a'.repeat(40)}`,
    'https://github.com/bkazemi?tab=repositories',
    'https://github.com/',
  ]) {
    const { instance } = provider(`<a rel="me" href="${expect}">x</a>`, {}, githubOptions());
    const external = await instance.verify({ artifact, expect });

    // Still proved, still read: just not named as an account in GitHub's namespace.
    assert.equal(external.kind, 'page', `named ${artifact} an account`);
    assert.equal(externalName(external), external.handle);
  }
});

test('a handle is only awarded inside a namespace the deployment named', () => {
  assert.throws(
    () => linkProvider({ name: 'Anywhere', profile: /^\/(\w+)$/ }),
    /hosts/,
    'awarded a handle on any host',
  );

  assert.throws(
    () => linkProvider({ name: 'GitHub', hosts: ['github.com'], profile: /^\/\w+$/ }),
    /capturing group/,
  );
});

test('the preset reads GitHub and nothing else', async () => {
  const { instance, calls } = provider(`<a rel="me" href="${expect}">x</a>`, {}, githubOptions());

  assert.equal(instance.id, 'github');
  assert.equal(instance.name, 'GitHub');

  await assert.rejects(instance.verify({ artifact: 'https://gitlab.com/bkazemi', expect }));
  assert.deepEqual(calls, []);
});
