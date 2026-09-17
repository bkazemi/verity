import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  identities,
  Malformed,
  readCertificate,
  readCleartext,
  revoked,
  signed,
} from '../src/server/openpgp.js';

/**
 * Every fixture is real GnuPG output rather than something this repository encoded, so the
 * reader is held against the format as it is actually produced, not as it is described.
 */
const fixture = (name: string) =>
  readFile(new URL(`./fixtures/pgp/${name}`, import.meta.url), 'utf8');

const message = 'Verity proof for Site: aGVsbG8td29ybGQtdGVzdC10b2tlbg';

const ed25519 = '7FDEB37E4F6EAD8E2FEFD8511347D93FEB1342AF';

const rsa = 'EF5F48AF2A27A1E9C4C1620A033980BF75474649';

test('a key names itself by fingerprint and its signature over a message checks out', async () => {
  for (const [name, fingerprint, algorithm] of [
    ['ed25519', ed25519, 22],
    ['rsa', rsa, 1],
  ] as const) {
    const certificate = readCertificate(await fixture(`${name}.pub.asc`));
    const cleartext = readCleartext(await fixture(`${name}.sig.asc`));

    assert.equal(certificate.key.fingerprint, fingerprint);
    assert.equal(certificate.key.algorithm, algorithm);
    assert.equal(certificate.key.version, 4);
    assert.ok(certificate.key.created > 0);

    // The message reads back exactly, which is the point of the cleartext form.
    assert.equal(cleartext.text.trim(), message);
    assert.equal(await signed(certificate, cleartext), true);
  }
});

test('a signature is bound to its own key and its own message', async () => {
  const ed = readCertificate(await fixture('ed25519.pub.asc'));
  const other = readCertificate(await fixture('rsa.pub.asc'));

  // The right message under the wrong key proves nothing.
  assert.equal(await signed(other, readCleartext(await fixture('ed25519.sig.asc'))), false);
  assert.equal(await signed(ed, readCleartext(await fixture('rsa.sig.asc'))), false);

  const tampered = (await fixture('ed25519.sig.asc')).replace(message, `${message}x`);

  assert.equal(await signed(ed, readCleartext(tampered)), false);

  // A message cannot be extended after the fact either.
  const extended = (await fixture('ed25519.sig.asc')).replace(
    '-----BEGIN PGP SIGNATURE-----',
    'and also everything else\n-----BEGIN PGP SIGNATURE-----',
  );

  assert.equal(await signed(ed, readCleartext(extended)), false);
});

test("the format's escaping and trailing whitespace rules decide whether a signature holds", async () => {
  const certificate = readCertificate(await fixture('ed25519.pub.asc'));
  const cleartext = readCleartext(await fixture('ed25519.tricky.asc'));

  // A leading dash is escaped on the wire and must come back as it was written.
  assert.match(cleartext.text, /^- dashed line$/m);
  assert.ok(!cleartext.text.includes('- - dashed'));

  // Trailing whitespace survives into the text but is not part of what was signed.
  assert.match(cleartext.text, /aGVsbG8td29ybGQtdGVzdC10b2tlbg {3}$/m);
  assert.ok(!new TextDecoder().decode(cleartext.data).includes('  \r\n'));
  assert.equal(await signed(certificate, cleartext), true);
});

test('a revocation counts only because the key signed it, never because it arrived', async () => {
  const before = readCertificate(await fixture('revoked-before.pub.asc'));
  const after = readCertificate(await fixture('revoked-after.pub.asc'));

  assert.equal(before.key.fingerprint, after.key.fingerprint);
  assert.equal(await revoked(before), false);
  assert.equal(await revoked(after), true);

  // A revocation is one key's statement about itself. Handed over with somebody else's
  // key attached it says nothing, which is what lets it travel over an untrusted channel:
  // a hostile keyserver can withhold a revocation but it cannot move one.
  const planted = { ...after, key: readCertificate(await fixture('ed25519.pub.asc')).key };

  assert.equal(planted.key.fingerprint, ed25519);
  assert.ok(planted.signatures.some((signature) => signature.type === 0x20));
  assert.equal(await revoked(planted), false);
});

test('malformed and hostile input is refused rather than half-read', async () => {
  const armored = await fixture('ed25519.pub.asc');

  for (const bad of [
    '',
    'not armored at all',
    '-----BEGIN PGP PUBLIC KEY BLOCK-----\n\nnot base64!!\n-----END PGP PUBLIC KEY BLOCK-----',
    // A corrupted body no longer matches the checksum the armor carries.
    armored.replace(/^([A-Za-z0-9+/]{20})/m, 'AAAAAAAAAAAAAAAAAAAA'),
    // A header line that is not one, so the header section never closes.
    armored.replace('\n\n', '\nnot a header at all\n\n'),
    `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${'A'.repeat(70000)}\n-----END PGP PUBLIC KEY BLOCK-----`,
  ]) {
    assert.throws(() => readCertificate(bad), Malformed, `accepted: ${bad.slice(0, 40)}`);
  }

  // Headers are a normal part of the armor, and a keyserver adds one to every key it
  // serves, so carrying them must not disturb what follows.
  const commented = armored.replace('\n\n', '\nComment: served by somebody\n\n');

  assert.equal(readCertificate(commented).key.fingerprint, ed25519);

  // A signature block where the key should be is still not a key.
  const signature = await fixture('ed25519.sig.asc');

  assert.throws(() => readCertificate(signature), Malformed);
  assert.throws(() => readCleartext(armored), Malformed);
});

test('a signing subkey counts, but only where the primary key vouched for it', async () => {
  const certificate = readCertificate(await fixture('subkey.pub.asc'));
  const cleartext = readCleartext(await fixture('subkey.sig.asc'));

  // Signing with a subkey is what gpg does by default, without ever mentioning it.
  assert.equal(certificate.key.fingerprint, '1AAE015081900B9E11C8968B6D424D5A9415E9D3');
  assert.equal(certificate.subkeys.length, 1);
  assert.equal(cleartext.text.trim(), message);
  assert.equal(await signed(certificate, cleartext), true);

  // The same subkey and its real binding, stapled onto somebody else's primary key. A
  // published key passes through hands that can append to it, so position proves nothing:
  // without checking the binding this would let anyone sign as anyone.
  const stapled = readCertificate(await fixture('stapled.pub.asc'));

  assert.equal(stapled.key.fingerprint, ed25519);
  assert.equal(stapled.subkeys.length, 1);
  assert.equal(await signed(stapled, cleartext), false);
});

test('a name counts only where the key signed for it, however it arrived', async () => {
  const honest = readCertificate(await fixture('ed25519.pub.asc'));

  assert.deepEqual(await identities(honest), ['Verity Test Ed25519 <ed25519@example.test>']);

  // The same key republished with two names added: one simply appended with nothing on
  // it, and one carrying a genuine certification that a different key made. Both are
  // present, neither was said by this key, so neither is a name it answers to.
  const forged = readCertificate(await fixture('forged-uid.pub.asc'));

  assert.equal(forged.key.fingerprint, ed25519);
  assert.equal(forged.userIds.length, 3);
  assert.deepEqual(await identities(forged), ['Verity Test Ed25519 <ed25519@example.test>']);

  // A key can also arrive with no name at all, which is what a keyserver serves when it
  // has confirmed none of them.
  const anonymous = readCertificate(await fixture('nouid.pub.asc'));

  assert.equal(anonymous.key.fingerprint, ed25519);
  assert.deepEqual(await identities(anonymous), []);

  // Stripping the names leaves the key itself, and the signature over the message stands.
  assert.equal(await signed(anonymous, readCleartext(await fixture('ed25519.sig.asc'))), true);
});
