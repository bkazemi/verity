import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  fingerprint,
  identities,
  Malformed,
  readCertificate,
  readCleartext,
  revoked,
  signed,
} from '../src/server/openpgp.js';

/**
 * Every fixture is real GnuPG output rather than something this repository encoded, so the
 * library is held against the format as it is actually produced, not as it is described.
 */
const fixture = (name: string) =>
  readFile(new URL(`./fixtures/pgp/${name}`, import.meta.url), 'utf8');

const message = 'Verity proof for Site: aGVsbG8td29ybGQtdGVzdC10b2tlbg';

const ed25519 = '7FDEB37E4F6EAD8E2FEFD8511347D93FEB1342AF';

const rsa = 'EF5F48AF2A27A1E9C4C1620A033980BF75474649';

test('a key names itself by fingerprint and its signature over a message checks out', async () => {
  for (const [name, expected] of [
    ['ed25519', ed25519],
    ['rsa', rsa],
  ] as const) {
    const certificate = await readCertificate(await fixture(`${name}.pub.asc`));
    const cleartext = await readCleartext(await fixture(`${name}.sig.asc`));

    assert.equal(fingerprint(certificate), expected);

    // The message reads back exactly, which is the point of the cleartext form.
    assert.equal(cleartext.getText().trim(), message);
    assert.equal(await signed(certificate, cleartext), true);
  }
});

test('a signature is bound to its own key and its own message', async () => {
  const ed = await readCertificate(await fixture('ed25519.pub.asc'));
  const other = await readCertificate(await fixture('rsa.pub.asc'));

  // The right message under the wrong key proves nothing.
  assert.equal(await signed(other, await readCleartext(await fixture('ed25519.sig.asc'))), false);
  assert.equal(await signed(ed, await readCleartext(await fixture('rsa.sig.asc'))), false);

  const tampered = (await fixture('ed25519.sig.asc')).replace(message, `${message}x`);

  assert.equal(await signed(ed, await readCleartext(tampered)), false);

  // A message cannot be extended after the fact either.
  const extended = (await fixture('ed25519.sig.asc')).replace(
    '-----BEGIN PGP SIGNATURE-----',
    'and also everything else\n-----BEGIN PGP SIGNATURE-----',
  );

  assert.equal(await signed(ed, await readCleartext(extended)), false);
});

test("the format's escaping and trailing whitespace rules decide whether a signature holds", async () => {
  const certificate = await readCertificate(await fixture('ed25519.pub.asc'));
  const cleartext = await readCleartext(await fixture('ed25519.tricky.asc'));

  // A leading dash is escaped on the wire and must come back as it was written.
  assert.match(cleartext.getText(), /^- dashed line$/m);
  assert.ok(!cleartext.getText().includes('- - dashed'));

  // Trailing whitespace is not part of what was signed, and the signature holds without it.
  assert.equal(await signed(certificate, cleartext), true);
});

test('a revocation counts only because the key signed it, never because it arrived', async () => {
  const before = await readCertificate(await fixture('revoked-before.pub.asc'));
  const after = await readCertificate(await fixture('revoked-after.pub.asc'));

  assert.equal(fingerprint(before), fingerprint(after));
  assert.equal(await revoked(before), false);
  assert.equal(await revoked(after), true);

  // A revocation is one key's statement about itself. Handed over with somebody else's
  // key attached it says nothing, which is what lets it travel over an untrusted channel:
  // a hostile keyserver can withhold a revocation but it cannot move one.
  const planted = await readCertificate(await fixture('ed25519.pub.asc'));

  planted.revocationSignatures.push(...after.revocationSignatures);

  assert.equal(fingerprint(planted), ed25519);
  assert.ok(planted.revocationSignatures.length > 0);
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
    `-----BEGIN PGP PUBLIC KEY BLOCK-----\n\n${'A'.repeat(70000)}\n-----END PGP PUBLIC KEY BLOCK-----`,
  ]) {
    await assert.rejects(readCertificate(bad), Malformed, `accepted: ${bad.slice(0, 40)}`);
  }

  // Headers are a normal part of the armor, and a keyserver adds one to every key it
  // serves, so carrying them must not disturb what follows.
  const commented = armored.replace('\n\n', '\nComment: served by somebody\n\n');

  assert.equal(fingerprint(await readCertificate(commented)), ed25519);

  // A signature block where the key should be is still not a key.
  const signature = await fixture('ed25519.sig.asc');

  await assert.rejects(readCertificate(signature), Malformed);
  await assert.rejects(readCleartext(armored), Malformed);
});

test('a signing subkey counts, but only where the primary key vouched for it', async () => {
  const certificate = await readCertificate(await fixture('subkey.pub.asc'));
  const cleartext = await readCleartext(await fixture('subkey.sig.asc'));

  // Signing with a subkey is what gpg does by default, without ever mentioning it.
  assert.equal(fingerprint(certificate), '1AAE015081900B9E11C8968B6D424D5A9415E9D3');
  assert.equal(certificate.subkeys.length, 1);
  assert.equal(cleartext.getText().trim(), message);
  assert.equal(await signed(certificate, cleartext), true);

  // The same subkey and its real binding, stapled onto somebody else's primary key. A
  // published key passes through hands that can append to it, so position proves nothing:
  // without checking the binding this would let anyone sign as anyone.
  const stapled = await readCertificate(await fixture('stapled.pub.asc'));

  assert.equal(fingerprint(stapled), ed25519);
  assert.equal(stapled.subkeys.length, 1);
  assert.equal(await signed(stapled, cleartext), false);

  // A signing subkey also has to sign back to its primary, or somebody else's subkey could
  // be bound under a key it never agreed to. gpg always adds that back-signature; the same
  // genuine binding without it counts for nothing.
  const unsigned = await readCertificate(await fixture('subkey.pub.asc'));

  unsigned.subkeys[0]!.bindingSignatures[0]!.embeddedSignature = null;
  assert.equal(await signed(unsigned, cleartext), false);
});

test('a name counts only where the key signed for it, however it arrived', async () => {
  const honest = await readCertificate(await fixture('ed25519.pub.asc'));

  assert.deepEqual(await identities(honest), ['Verity Test Ed25519 <ed25519@example.test>']);

  // The same key republished with two names added: one simply appended with nothing on
  // it, and one carrying a genuine certification that a different key made. Both are
  // present, neither was said by this key, so neither is a name it answers to.
  const forged = await readCertificate(await fixture('forged-uid.pub.asc'));

  assert.equal(fingerprint(forged), ed25519);
  assert.equal(forged.users.length, 3);
  assert.deepEqual(await identities(forged), ['Verity Test Ed25519 <ed25519@example.test>']);

  // A key can also arrive with no name at all, which is what a keyserver serves when it
  // has confirmed none of them.
  const anonymous = await readCertificate(await fixture('nouid.pub.asc'));

  assert.equal(fingerprint(anonymous), ed25519);
  assert.deepEqual(await identities(anonymous), []);

  // Stripped of its names, though, the key has lost the self-signatures that say what it
  // may be used for and until when, so it no longer vouches for a message.
  assert.equal(
    await signed(anonymous, await readCleartext(await fixture('ed25519.sig.asc'))),
    false,
  );
});

test('an expired key proves nothing now, whatever it signed while it was valid', async () => {
  // Made in 2020 with a one-day lifetime, and signed with on its first day.
  const certificate = await readCertificate(await fixture('expired.pub.asc'));
  const cleartext = await readCleartext(await fixture('expired.sig.asc'));

  assert.equal(cleartext.getText().trim(), message);
  assert.equal(await signed(certificate, cleartext), false);
});

test('a SHA-1 signature is refused from a key whose other signatures hold', async () => {
  const certificate = await readCertificate(await fixture('digest.pub.asc'));

  assert.equal(
    await signed(certificate, await readCleartext(await fixture('digest-sha512.sig.asc'))),
    true,
  );

  assert.equal(
    await signed(certificate, await readCleartext(await fixture('digest-sha1.sig.asc'))),
    false,
  );
});
