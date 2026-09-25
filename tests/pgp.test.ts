import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pgpProvider } from '../src/server/pgp.js';
import { dearmor } from '../src/server/openpgp.js';
import { wkdUrls } from '../src/server/wkd.js';
import { written } from './helpers.js';

const fixture = (name: string) =>
  readFile(new URL(`./fixtures/pgp/${name}`, import.meta.url), 'utf8');

const expect = 'Verity proof for Site: aGVsbG8td29ybGQtdGVzdC10b2tlbg';

const ed25519 = '7FDEB37E4F6EAD8E2FEFD8511347D93FEB1342AF';

const impostor = '304D4205366EC12CF1A3FDB68CEFD26FAEDE3108';

/** The holder pastes both blocks, so the artifact is what they would actually hand over. */
const pasted = async (key: string, signature: string) =>
  `${await fixture(signature)}\n${await fixture(key)}`;

const at = (fingerprint: string) => `https://keys.openpgp.org/vks/v1/by-fingerprint/${fingerprint}`;

/**
 * A keyserver that answers only what a test puts in it. Everything else is a 404, which is
 * the ordinary case: most keys were never uploaded anywhere.
 */
function keyserver(replies: Record<string, { status: number; body: string | Uint8Array }> = {}) {
  const calls: string[] = [];

  const call = (async (input: string | URL) => {
    const url = String(input);

    calls.push(url);

    const reply = replies[url] ?? { status: 404, body: 'not found' };

    return new Response(reply.body as BodyInit, { status: reply.status });
  }) as unknown as typeof fetch;

  return { fetch: call, calls };
}

/** Where example.test would publish the key for the address on the ed25519 fixture. */
const wkd = wkdUrls('ed25519@example.test');

/** No test reaches the real network, so every one of them says what it is answering. */
const provider = (replies?: Record<string, { status: number; body: string | Uint8Array }>) =>
  pgpProvider(keyserver(replies));

test('a key proves itself by signing the line, and carries its fingerprint', async () => {
  const instance = provider();

  const account = await instance.verify({
    artifact: await pasted('ed25519.pub.asc', 'ed25519.sig.asc'),
    expect,
  });

  assert.equal(account.id, ed25519);
  assert.equal(account.kind, 'key');
  assert.equal(account.profileUrl, `https://keys.openpgp.org/search?q=0x${ed25519}`);

  // The method needs no registration anywhere, so it holds this backend to nothing.
  assert.equal(instance.artifact, 'document');
  assert.equal(instance.method, 'signature');
  assert.match(written(instance.instructions(expect)), /gpg --clearsign/);
  assert.ok(written(instance.instructions(expect)).includes(expect));
});

test('an address shows only where the key signed it and a keyserver confirmed it', async () => {
  // The keyserver publishes an address only once somebody reading mail there asked it to,
  // so one it serves has been said by two parties who cannot stand in for each other.
  const known = keyserver({
    [at(ed25519)]: { status: 200, body: await fixture('ed25519.pub.asc') },
  });

  const shown = await pgpProvider(known).verify({
    artifact: await pasted('ed25519.pub.asc', 'ed25519.sig.asc'),
    expect,
  });

  assert.equal(shown.handle, 'ed25519@example.test');
  assert.deepEqual(known.calls, [at(ed25519)]);

  // The same key, never uploaded. It signed for the same address, and that on its own is
  // not something anybody confirmed, so the fingerprint stands in for it.
  const absent = await provider().verify({
    artifact: await pasted('ed25519.pub.asc', 'ed25519.sig.asc'),
    expect,
  });

  assert.equal(absent.handle, '1347 D93F EB13 42AF');
  assert.equal(absent.id, ed25519);
});

test('a minted key cannot put somebody else’s address beside a real proof', async () => {
  // A key made this morning, self-signing "Verity Bank Support <support@bank.example>".
  // The signature over the line is real and the self-certification is real; what is
  // missing is anybody at that address ever having agreed to it. Printing it on a badge
  // is the whole attack, and it costs seconds to mount.
  const minted = await provider().verify({
    artifact: await pasted('impostor.pub.asc', 'impostor.sig.asc'),
    expect,
  });

  assert.equal(minted.id, impostor);
  assert.equal(minted.handle, '8CEF D26F AEDE 3108');
  assert.ok(!JSON.stringify(minted).includes('bank.example'));

  // Nor can an address be put on a key by serving it alongside one: the served copy is
  // only a courier for what the held key signed, and it was never confirmed either.
  const forged = keyserver({
    [at(ed25519)]: { status: 200, body: await fixture('forged-uid.pub.asc') },
  });

  const account = await pgpProvider(forged).verify({
    artifact: await pasted('ed25519.pub.asc', 'ed25519.sig.asc'),
    expect,
  });

  assert.equal(account.handle, 'ed25519@example.test');
  assert.ok(!JSON.stringify(account).includes('bank.example'));
  assert.ok(!JSON.stringify(account).includes('subkey@example.test'));
});

test('a keyserver that is down or lying costs the address, never the proof', async () => {
  const artifact = await pasted('ed25519.pub.asc', 'ed25519.sig.asc');

  // Unreachable. Nobody has confirmed anything as far as this backend can tell, and the
  // proof never depended on the keyserver, so the proof still stands.
  const broken = await pgpProvider(
    keyserver({ [at(ed25519)]: { status: 500, body: 'oh no' } }),
  ).verify({ artifact, expect });

  assert.equal(broken.handle, '1347 D93F EB13 42AF');
  assert.equal(broken.id, ed25519);

  // Answering with a different key entirely buys nothing either.
  const swapped = await pgpProvider(
    keyserver({ [at(ed25519)]: { status: 200, body: await fixture('impostor.pub.asc') } }),
  ).verify({ artifact, expect });

  assert.equal(swapped.handle, '1347 D93F EB13 42AF');
  assert.ok(!JSON.stringify(swapped).includes('bank.example'));
});

test('a key with no confirmed address at all is named by its fingerprint', async () => {
  // A keyserver serves the addresses it has confirmed and strips the rest, so a key can
  // arrive with none. It is still a key, and it is still named by its fingerprint.
  const stripped = keyserver({
    [at(ed25519)]: { status: 200, body: await fixture('nouid.pub.asc') },
  });

  const account = await pgpProvider(stripped).verify({
    artifact: await pasted('nouid.pub.asc', 'ed25519.sig.asc'),
    expect,
  });

  assert.equal(account.handle, '1347 D93F EB13 42AF');
  assert.equal(account.id, ed25519);
});

test('a signature for a different line, key or flow proves nothing', async () => {
  const instance = provider();

  await assert.rejects(
    instance.verify({
      artifact: await pasted('ed25519.pub.asc', 'ed25519.sig.asc'),
      expect: 'Verity proof for Site: a different token',
    }),
  );

  // The signed message and the key must belong together.
  await assert.rejects(
    instance.verify({ artifact: await pasted('rsa.pub.asc', 'ed25519.sig.asc'), expect }),
  );

  // The line has to stand on its own, not be swallowed by a sentence that was signed.
  const buried = (await pasted('ed25519.pub.asc', 'ed25519.sig.asc')).replace(
    expect,
    `I do not agree that ${expect} is true`,
  );

  await assert.rejects(instance.verify({ artifact: buried, expect }));

  for (const junk of ['', 'hello', await fixture('ed25519.pub.asc')])
    await assert.rejects(
      instance.verify({ artifact: junk, expect }),
      `accepted ${junk.slice(0, 20)}`,
    );
});

test('a subkey signature is accepted, and a stapled one is not', async () => {
  const subkey = '1AAE015081900B9E11C8968B6D424D5A9415E9D3';

  // Signing with a subkey is what gpg does unprompted, so it has to work.
  const confirmed = keyserver({
    [at(subkey)]: { status: 200, body: await fixture('subkey.pub.asc') },
  });

  const account = await pgpProvider(confirmed).verify({
    artifact: await pasted('subkey.pub.asc', 'subkey.sig.asc'),
    expect,
  });

  assert.equal(account.id, subkey);
  assert.equal(account.handle, 'subkey@example.test');

  // That same subkey and binding, appended to somebody else's key. Believing it would
  // let anyone who can copy a published key sign as its holder.
  await assert.rejects(
    provider().verify({ artifact: await pasted('stapled.pub.asc', 'subkey.sig.asc'), expect }),
  );
});

test('a revocation the keyserver serves is believed only because the key signed it', async () => {
  const held = await fixture('revoked-before.pub.asc');
  const fingerprint = '6767116C8A6B4240B176E0B4CF1941B6DA901270';
  const account = { id: fingerprint, handle: '', profileUrl: '' };

  // Nothing published there yet, which is not the same as nothing having been revoked.
  const absent = keyserver();

  assert.equal(await pgpProvider(absent).withdrawn!(account, held), false);
  assert.deepEqual(absent.calls, [at(fingerprint)]);

  // The same key, unrevoked.
  const quiet = keyserver({ [at(fingerprint)]: { status: 200, body: held } });

  assert.equal(await pgpProvider(quiet).withdrawn!(account, held), false);

  // The key carrying its own revocation.
  const gone = keyserver({
    [at(fingerprint)]: { status: 200, body: await fixture('revoked-after.pub.asc') },
  });

  assert.equal(await pgpProvider(gone).withdrawn!(account, held), true);
});

test('a keyserver cannot revoke a key by answering for it', async () => {
  const held = await fixture('revoked-before.pub.asc');
  const fingerprint = '6767116C8A6B4240B176E0B4CF1941B6DA901270';
  const account = { id: fingerprint, handle: '', profileUrl: '' };

  // A different key, revoked, served under the fingerprint that was asked for. The
  // revocation is real, but it is not this key's, and the answer must not depend on the
  // keyserver having been honest about which key it sent.
  const swapped = keyserver({
    [at(fingerprint)]: { status: 200, body: await fixture('ed25519.pub.asc') },
  });

  assert.equal(await pgpProvider(swapped).withdrawn!(account, held), false);

  // An outage is not a revocation, and must not be read as one.
  const broken = keyserver({ [at(fingerprint)]: { status: 500, body: 'oh no' } });

  await assert.rejects(pgpProvider(broken).withdrawn!(account, held));

  // A proof that is not the key it is supposed to be is not consulted at all.
  const other = keyserver();

  assert.equal(
    await pgpProvider(other).withdrawn!(account, await fixture('ed25519.pub.asc')),
    false,
  );

  assert.deepEqual(other.calls, []);
});

test('the keyserver is configurable and must be reached over https', async () => {
  assert.throws(() => pgpProvider({ keyserver: 'http://keys.example' }));

  const custom = keyserver();
  const instance = pgpProvider({ ...custom, keyserver: 'https://keys.example' });
  const held = await fixture('ed25519.pub.asc');

  // Both questions go to the configured host, and the holder is told which one that is.
  assert.equal(await instance.withdrawn!({ id: ed25519, handle: '', profileUrl: '' }, held), false);
  assert.deepEqual(custom.calls, [`https://keys.example/vks/v1/by-fingerprint/${ed25519}`]);
  assert.match(written(instance.instructions(expect)), /keys\.example/);

  // A stored proof that will not parse never reaches the network.
  await assert.rejects(
    instance.withdrawn!({ id: ed25519, handle: '', profileUrl: '' }, 'not a key'),
  );

  assert.equal(custom.calls.length, 1);
});

test('a domain publishing the key for its own mailbox confirms the address', async () => {
  const key = await fixture('ed25519.pub.asc');

  // Nothing on the keyserver, but the domain owning the mailbox publishes this very key
  // at the address derived from it. That is the domain itself saying the two belong
  // together, which is a better answer than a third party's confirmation, not a worse one.
  const domain = keyserver({ [wkd[0]!]: { status: 200, body: key } });

  assert.equal(
    (
      await pgpProvider(domain).verify({
        artifact: await pasted('ed25519.pub.asc', 'ed25519.sig.asc'),
        expect,
      })
    ).handle,
    'ed25519@example.test',
  );

  // The keyserver was asked first, then the directory's more specific location.
  assert.deepEqual(domain.calls, [at(ed25519), wkd[0]]);

  // Domains that delegate use the subdomain; those that do not answer on the domain
  // itself, so both are tried before giving up.
  const direct = keyserver({ [wkd[1]!]: { status: 200, body: key } });

  assert.equal(
    (
      await pgpProvider(direct).verify({
        artifact: await pasted('ed25519.pub.asc', 'ed25519.sig.asc'),
        expect,
      })
    ).handle,
    'ed25519@example.test',
  );

  assert.deepEqual(direct.calls, [at(ed25519), wkd[0], wkd[1]]);
});

test('a directory is read as packets, which is how the scheme actually serves keys', async () => {
  const packets = dearmor(await fixture('ed25519.pub.asc'), 'PUBLIC KEY BLOCK');

  assert.ok(packets.length > 0);
  assert.notEqual(packets[0], '-'.charCodeAt(0));

  const binary = keyserver({ [wkd[0]!]: { status: 200, body: packets } });

  assert.equal(
    (
      await pgpProvider(binary).verify({
        artifact: await pasted('ed25519.pub.asc', 'ed25519.sig.asc'),
        expect,
      })
    ).handle,
    'ed25519@example.test',
  );
});

test('a domain publishing some other key confirms nothing', async () => {
  // The mailbox's domain answers, but with a key that is not this one. It has said
  // nothing about this key, so there is nothing to show but the fingerprint.
  const wrong = keyserver({
    [wkd[0]!]: { status: 200, body: await fixture('impostor.pub.asc') },
    [wkd[1]!]: { status: 200, body: 'not a key at all' },
  });

  const account = await pgpProvider(wrong).verify({
    artifact: await pasted('ed25519.pub.asc', 'ed25519.sig.asc'),
    expect,
  });

  assert.equal(account.handle, '1347 D93F EB13 42AF');
  assert.equal(account.id, ed25519);
  assert.deepEqual(wrong.calls, [at(ed25519), wkd[0], wkd[1]]);
});

test('a keyserver answer settles it, and an unaskable address is never fetched', async () => {
  // Confirmed at the first place asked, so somebody else's host is left alone.
  const known = keyserver({
    [at(ed25519)]: { status: 200, body: await fixture('ed25519.pub.asc') },
  });

  await pgpProvider(known).verify({
    artifact: await pasted('ed25519.pub.asc', 'ed25519.sig.asc'),
    expect,
  });

  assert.deepEqual(known.calls, [at(ed25519)]);

  // The impostor's address is on bank.example, and its key is on no keyserver. A
  // directory there could confirm it, so it is asked, and it says nothing.
  const minted = keyserver();

  const account = await pgpProvider(minted).verify({
    artifact: await pasted('impostor.pub.asc', 'impostor.sig.asc'),
    expect,
  });

  assert.equal(account.handle, '8CEF D26F AEDE 3108');
  assert.ok(!JSON.stringify(account).includes('bank.example'));
  assert.equal(minted.calls.length, 3);
  assert.ok(minted.calls.every((url) => url.startsWith('https://')));
});

test('a directory named by a stranger is never read through the unguarded fetch', async (t) => {
  const calls: string[] = [];

  t.mock.method(globalThis, 'fetch', async (input: string | URL) => {
    calls.push(String(input));

    return new Response('not found', { status: 404 });
  });

  const account = await pgpProvider().verify({
    artifact: await pasted('ed25519.pub.asc', 'ed25519.sig.asc'),
    expect,
  });

  // The keyserver is the operator's and goes through fetch; the directory's host is not,
  // and goes through the transport that checks where it resolves.
  assert.deepEqual(calls, [at(ed25519)]);
  assert.equal(account.id, ed25519);
});

test('a body is read only as far as a key could need, and every one is let go of', async () => {
  let opened = 0;
  let cancelled = 0;

  // Every answer is a body that never ends: an error from the keyserver, a refusal from
  // one directory location and an endless "key" from the other. Reading any of them to
  // the end would never return.
  const replies: Record<string, number> = { [at(ed25519)]: 503, [wkd[0]!]: 404, [wkd[1]!]: 200 };

  const endless = (async (input: string | URL) => {
    opened += 1;

    const body = new ReadableStream<Uint8Array>({
      pull: (controller) => controller.enqueue(new Uint8Array(4096)),
      cancel: () => {
        cancelled += 1;
      },
    });

    return new Response(body, { status: replies[String(input)] ?? 404 });
  }) as unknown as typeof fetch;

  const account = await pgpProvider({ fetch: endless }).verify({
    artifact: await pasted('ed25519.pub.asc', 'ed25519.sig.asc'),
    expect,
  });

  assert.equal(account.id, ed25519);
  assert.equal(opened, 3);
  assert.equal(cancelled, 3);
});
