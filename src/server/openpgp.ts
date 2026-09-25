/**
 * The few questions Verity asks of OpenPGP, answered by OpenPGP.js: whether a cleartext
 * signature was made by a given key, whether a key carries its own revocation, and which
 * names the key signed for itself. The format's rules on when a valid signature still does
 * not count — expiry, subkey back-signatures, key flags, critical subpackets — are the
 * library's, since they are exactly what a partial reader gets wrong.
 */

import {
  config as defaults,
  enums,
  readCleartextMessage,
  readKey as readOpenpgpKey,
  verify as verifyMessage,
  type CleartextMessage,
  type Key,
} from 'openpgp';

/** A key or signature arrives as text from a stranger, so every input is bounded first. */
const maxArmorBytes = 65536;

/**
 * SHA-1 is refused for every signature, not only for messages as the library's defaults
 * have it: chosen prefix collisions against it are practical, and a binding or a user id
 * certification is as much a statement worth forging as the message is.
 */
const config = {
  ...defaults,
  rejectHashAlgorithms: new Set([
    ...defaults.rejectHashAlgorithms,
    enums.hash.sha1,
    enums.hash.md5,
    enums.hash.ripemd,
  ]),
  rejectMessageHashAlgorithms: new Set([
    ...defaults.rejectMessageHashAlgorithms,
    enums.hash.sha1,
    enums.hash.md5,
    enums.hash.ripemd,
  ]),
};

export class Malformed extends Error {
  constructor(what: string, options?: ErrorOptions) {
    super(`Malformed OpenPGP ${what}`, options);
  }
}

export type Certificate = Key;

export type Cleartext = CleartextMessage;

/**
 * The one armored block of the named kind out of text that may hold others: a holder
 * pastes the signed message and the key together, and the library reads only the first
 * block it meets.
 */
function block(text: string, begin: string, end: string, what: string): string {
  if (text.length > maxArmorBytes) throw new Malformed(what);

  const start = text.indexOf(`-----BEGIN PGP ${begin}-----`);
  const stop = text.indexOf(`-----END PGP ${end}-----`, start);

  if (start < 0 || stop < 0) throw new Malformed(what);

  return text.slice(start, stop + `-----END PGP ${end}-----`.length);
}

async function malformed<T>(what: string, read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    throw error instanceof Malformed ? error : new Malformed(what, { cause: error });
  }
}

/** The public key in armored text, wherever in the text its block is. */
export function readCertificate(armored: string): Promise<Certificate> {
  return malformed('key', async () => {
    const key = await readOpenpgpKey({
      armoredKey: block(armored, 'PUBLIC KEY BLOCK', 'PUBLIC KEY BLOCK', 'key'),
      config,
    });

    if (key.isPrivate()) throw new Malformed('key');

    return key;
  });
}

/** A public key as bare packets, which is how a web key directory serves one. */
export function readKey(data: Uint8Array): Promise<Certificate> {
  if (data.byteLength > maxArmorBytes) return Promise.reject(new Malformed('key'));

  return malformed('key', async () => {
    const key = await readOpenpgpKey({ binaryKey: data, config });

    if (key.isPrivate()) throw new Malformed('key');

    return key;
  });
}

/** The signed message in armored text, wherever in the text its block is. */
export function readCleartext(armored: string): Promise<Cleartext> {
  return malformed('signed message', () =>
    readCleartextMessage({
      cleartextMessage: block(armored, 'SIGNED MESSAGE', 'SIGNATURE', 'signed message'),
      config,
    }),
  );
}

/** The key's fingerprint, in the upper case it is read aloud in. */
export function fingerprint(certificate: Certificate): string {
  return certificate.getFingerprint().toUpperCase();
}

/**
 * Whether the key says of itself that it is no longer to be used. A revocation only counts
 * when the key signed it, which is what lets it travel over any channel at all: a hostile
 * keyserver can withhold one, but it cannot manufacture one.
 */
export async function revoked(certificate: Certificate): Promise<boolean> {
  return certificate.isRevoked(undefined, undefined, undefined, config);
}

/**
 * The names this key has signed for itself and not withdrawn, in the order they were
 * published. A user id is only ever the holder's own claim about where to find them, but
 * it is a claim the key made, and without checking that, anyone could append a name to a
 * copy of a published key and have it read back as though its holder had written it.
 *
 * It says nothing about whether the address works or who reads it. That is not something a
 * key can establish about itself, and this does not pretend otherwise.
 */
export async function identities(certificate: Certificate): Promise<string[]> {
  const found: string[] = [];

  for (const user of certificate.users) {
    if (!user.userID) continue;

    try {
      await user.verify(undefined, config);
      found.push(user.userID.userID);
    } catch {
      // Never signed by this key, withdrawn, or expired.
    }
  }

  return found;
}

/**
 * Whether this key made this message, under a signature that says it signed a document, and
 * with a key fit to make it today: not expired, not revoked, and where a subkey made it, one
 * the primary key bound for signing and that signed back.
 *
 * Today, and not when the signature says it was made. The library judges a signature by the
 * key as it stood at the signature's own creation time, which is right for an archive and
 * wrong here: that time is the signer's to write, so a key that expired years ago could sign
 * a fresh line dated to when it was valid.
 */
export async function signed(certificate: Certificate, message: Cleartext): Promise<boolean> {
  const documents = [enums.signature.binary, enums.signature.text];

  const { signatures } = await verifyMessage({
    message,
    verificationKeys: certificate,
    config,
  });

  for (const { keyID, signature, verified } of signatures) {
    try {
      const [packet] = (await signature).packets;

      if (!documents.includes(packet!.signatureType!)) continue;

      if (!(await verified)) continue;

      await certificate.getSigningKey(keyID, new Date(), undefined, config);

      return true;
    } catch {
      // Made by another key, not valid, or by a key not fit to sign today. Another
      // signature on the message may still be this key's.
    }
  }

  return false;
}
