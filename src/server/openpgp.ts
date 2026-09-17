/**
 * A deliberately small OpenPGP reader: enough to check that a cleartext signature was made
 * by a given key, and that a key carries its own revocation. It cannot encrypt, decrypt,
 * sign, or judge a web of trust, and it is not a general implementation of the format.
 *
 * It is written out rather than depended on because a library whose whole argument is that
 * a reader can check its claims should not ask them to accept a megabyte of somebody
 * else's cryptography first. Everything here is parsing; the signature checks are WebCrypto's.
 */

import { createHash } from 'node:crypto';

/** A key or signature arrives as text from a stranger, so every input is bounded first. */
const maxArmorBytes = 65536;

const maxPackets = 256;

export class Malformed extends Error {
  constructor(what: string) {
    super(`Malformed OpenPGP ${what}`);
  }
}

/**
 * Signature hashes, by the format's algorithm ids. SHA-1 is missing on purpose: chosen
 * prefix collisions against it are practical, and a proof is exactly the kind of statement
 * worth forging. That is a different question from the v4 fingerprint below, which is also
 * SHA-1 but names a key rather than attesting to anything.
 */
const digests: Record<number, string> = { 8: 'SHA-256', 9: 'SHA-384', 10: 'SHA-512' };

/** Curve OIDs, as they appear in a key's material, to the names WebCrypto knows. */
const curves: Record<string, string> = {
  '2a8648ce3d030107': 'P-256',
  '2b81040022': 'P-384',
  '2b81040023': 'P-521',
  '2b06010401da470f01': 'Ed25519',
  '2b656e': 'X25519',
};

const bytes = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;

  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }

  return out;
};

/** WebCrypto will not take a view that might be shared memory, and none of these are. */
const plain = (data: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(data);

const hex = (data: Uint8Array) =>
  [...data].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const big = (value: number) =>
  new Uint8Array([(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]);

/** The checksum the armor carries. Optional in the current format, checked when present. */
function crc24(data: Uint8Array): number {
  let crc = 0xb704ce;

  for (const byte of data) {
    crc ^= byte << 16;

    for (let bit = 0; bit < 8; bit++) {
      crc <<= 1;

      if (crc & 0x1000000) crc ^= 0x1864cfb;
    }
  }

  return crc & 0xffffff;
}

/**
 * Unwraps one armored block of the named kind. The armor is a container, not a claim: a
 * correct checksum says the text survived copying and nothing more.
 */
export function dearmor(text: string, kind: string): Uint8Array {
  if (text.length > maxArmorBytes) throw new Malformed('armor');

  const begin = `-----BEGIN PGP ${kind}-----`;
  const end = `-----END PGP ${kind}-----`;
  const start = text.indexOf(begin);
  const stop = text.indexOf(end, start + begin.length);

  if (start < 0 || stop < 0) throw new Malformed('armor');

  // The first element is whatever followed the marker on its own line, never a header.
  const lines = text
    .slice(start + begin.length, stop)
    .split(/\r?\n/)
    .slice(1);

  const body: string[] = [];
  let checksum: string | undefined;
  let headers = true;

  for (const raw of lines) {
    const line = raw.trim();

    // Armor headers run until the first blank line; everything after it is base64.
    if (headers) {
      if (!line) headers = false;
      else if (!/^[A-Za-z][\w-]*: /.test(line)) throw new Malformed('armor header');

      continue;
    }

    if (line.startsWith('=')) checksum = line.slice(1);
    else if (line) body.push(line);
  }

  if (headers || !body.length) throw new Malformed('armor');

  const data = decode(body.join(''));

  if (checksum && crc24(data) !== readUint(decode(checksum), 0, 3)) throw new Malformed('checksum');

  return data;
}

function decode(base64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Malformed('base64');

  return Uint8Array.from(Buffer.from(base64, 'base64'));
}

function readUint(data: Uint8Array, at: number, length: number): number {
  if (at + length > data.length) throw new Malformed('packet');

  let value = 0;

  for (let i = 0; i < length; i++) value = value * 256 + data[at + i]!;

  return value;
}

export interface Packet {
  tag: number;
  body: Uint8Array;
}

/**
 * Splits a stream into packets. Both the original and the current header encodings appear
 * in the wild, since a key made years ago is still served exactly as it was written.
 */
export function packets(data: Uint8Array): Packet[] {
  const found: Packet[] = [];
  let at = 0;

  while (at < data.length) {
    if (found.length >= maxPackets) throw new Malformed('stream');

    const header = data[at++]!;

    if (!(header & 0x80)) throw new Malformed('packet header');

    let tag: number;
    let length: number;

    if (header & 0x40) {
      tag = header & 0x3f;

      const first = readUint(data, at++, 1);

      if (first < 192) length = first;
      else if (first < 224) length = ((first - 192) << 8) + readUint(data, at++, 1) + 192;
      else if (first === 255) {
        length = readUint(data, at, 4);
        at += 4;
      } else throw new Malformed('partial length');
    } else {
      tag = (header >> 2) & 0x0f;

      const size = [1, 2, 4][header & 3];

      // An indeterminate length can only mean the rest of the stream.
      if (size === undefined) length = data.length - at;
      else {
        length = readUint(data, at, size);
        at += size;
      }
    }

    if (at + length > data.length) throw new Malformed('packet length');

    found.push({ tag, body: data.subarray(at, at + length) });
    at += length;
  }

  return found;
}

/** A multiprecision integer: a bit count, then that many bits, left-padded to whole bytes. */
function mpi(data: Uint8Array, at: number): { value: Uint8Array; next: number } {
  const bits = readUint(data, at, 2);
  const length = (bits + 7) >> 3;

  if (at + 2 + length > data.length) throw new Malformed('integer');

  return { value: data.subarray(at + 2, at + 2 + length), next: at + 2 + length };
}

export interface PublicKey {
  /** Uppercase hex. A key has no other durable name, and this one is never reassigned. */
  fingerprint: string;
  version: number;
  algorithm: number;
  created: number;
  /** The key material, read per algorithm when a signature is checked against it. */
  material: Uint8Array;
  /** The whole packet body, which the fingerprint and every signature over the key hash. */
  packet: Uint8Array;
}

export interface Signature {
  version: number;
  /** 0x00 and 0x01 sign a document; 0x20 revokes the key that made it. */
  type: number;
  algorithm: number;
  hash: number;
  /** Version through the end of the hashed subpackets: the bytes hashed after the data. */
  hashed: Uint8Array;
  /** Present from version 6 onwards, and hashed before anything else. */
  salt: Uint8Array;
  /** The signature value, already unpacked from whatever integers carried it. */
  value: Uint8Array;
}

/**
 * A subkey as it was published, with the signatures sent alongside it. Whether it belongs
 * to the primary key is not settled by where it was found: anyone can append a packet.
 */
export interface Subkey {
  key: PublicKey;
  bindings: Signature[];
}

/**
 * A name the key claims, with the signatures sent alongside it. A user id is a packet like
 * any other and anyone can append one, so what it says counts for nothing until the key
 * has signed it.
 */
export interface UserId {
  text: string;
  /** The packet body, which a certification over this name hashes. */
  raw: Uint8Array;
  certifications: Signature[];
}

/** A key as published: the key itself, plus whatever was sent alongside it. */
export interface Certificate {
  key: PublicKey;
  /** Claimed subkeys. Each one is checked against the primary before it is believed. */
  subkeys: Subkey[];
  /** Signatures on the key itself, which is where a key revocation is required to be. */
  signatures: Signature[];
  /** Claimed names. Each one is checked against the primary before it is believed. */
  userIds: UserId[];
}

function readPublicKey(body: Uint8Array): PublicKey {
  const version = readUint(body, 0, 1);

  if (version !== 4 && version !== 6) throw new Malformed('key version');

  const created = readUint(body, 1, 4) * 1000;
  const algorithm = readUint(body, 5, 1);
  // Version 6 counts its material so a reader can skip an algorithm it does not know.
  const material = version === 6 ? body.subarray(10, 10 + readUint(body, 6, 4)) : body.subarray(6);

  if (!material.length) throw new Malformed('key material');

  return {
    fingerprint: hex(fingerprint(version, body)).toUpperCase(),
    version,
    algorithm,
    created,
    material,
    packet: body,
  };
}

/**
 * A fingerprint is a hash of the key packet under a fixed frame. Version 4 uses SHA-1,
 * which is not a choice this file gets to make: it is how every key of that age is named,
 * and naming is not attesting. Signatures are held to a stricter standard above.
 */
function fingerprint(version: number, body: Uint8Array): Uint8Array {
  const digest = (algorithm: string, framing: Uint8Array) =>
    Uint8Array.from(createHash(algorithm).update(bytes(framing, body)).digest());

  return version === 6
    ? digest('sha256', bytes(new Uint8Array([0x9b]), big(body.length)))
    : digest('sha1', new Uint8Array([0x99, body.length >> 8, body.length & 255]));
}

function readSignature(body: Uint8Array): Signature {
  const version = readUint(body, 0, 1);

  if (version !== 4 && version !== 6) throw new Malformed('signature version');

  const wide = version === 6 ? 4 : 2;
  const type = readUint(body, 1, 1);
  const algorithm = readUint(body, 2, 1);
  const hash = readUint(body, 3, 1);
  const hashedLength = readUint(body, 4, wide);
  const hashedEnd = 4 + wide + hashedLength;
  const unhashedLength = readUint(body, hashedEnd, wide);
  let at = hashedEnd + wide + unhashedLength + 2;
  let salt = new Uint8Array();

  if (version === 6) {
    const size = readUint(body, at, 1);

    salt = plain(body.subarray(at + 1, at + 1 + size));
    at += 1 + size;
  }

  return {
    version,
    type,
    algorithm,
    hash,
    hashed: body.subarray(0, hashedEnd),
    salt,
    value: signatureValue(algorithm, body, at),
  };
}

/**
 * Unpacks the signature itself. EdDSA and ECDSA carry two halves that must each be padded
 * back to the curve's width, because the encoding drops leading zeroes and WebCrypto
 * expects fixed-width halves.
 */
function signatureValue(algorithm: number, body: Uint8Array, at: number): Uint8Array {
  if (algorithm === 27 || algorithm === 28) return body.subarray(at, at + 64);

  if ([1, 2, 3].includes(algorithm)) return mpi(body, at).value;

  if ([19, 22].includes(algorithm)) {
    const r = mpi(body, at);
    const s = mpi(body, r.next);
    const width = Math.max(r.value.length, s.value.length);
    const out = new Uint8Array(width * 2);

    out.set(r.value, width - r.value.length);
    out.set(s.value, width * 2 - s.value.length);

    return out;
  }

  throw new Malformed('signature algorithm');
}

/**
 * Reads a published key. A signature belongs to whatever packet precedes it, which is the
 * only structure the format has: nothing here is trusted for its position, only sorted by it.
 */
export function readCertificate(armored: string): Certificate {
  return certificate(packets(dearmor(armored, 'PUBLIC KEY BLOCK')));
}

/**
 * The same, for a key that arrived as packets rather than as text. A web key directory
 * serves keys this way, since there is nothing to paste through and nothing to survive.
 */
export function readKey(data: Uint8Array): Certificate {
  return certificate(packets(data));
}

function certificate(found: Packet[]): Certificate {
  const primary = found[0];

  if (primary?.tag !== 6) throw new Malformed('certificate');

  const key = readPublicKey(primary.body);
  const subkeys: Subkey[] = [];
  const signatures: Signature[] = [];
  const userIds: UserId[] = [];
  let current: Signature[] = signatures;

  for (const packet of found.slice(1)) {
    if (packet.tag === 13) {
      userIds.push({
        text: new TextDecoder().decode(packet.body).slice(0, 500),
        raw: packet.body,
        certifications: [],
      });

      current = userIds.at(-1)!.certifications;
    }

    if (packet.tag === 14) {
      subkeys.push({ key: readPublicKey(packet.body), bindings: [] });
      current = subkeys.at(-1)!.bindings;
    }

    // A signature speaks about whatever packet precedes it. Before any of them it speaks
    // about the key itself, which is where a key revocation is required to be.
    if (packet.tag === 2) current.push(readSignature(packet.body));
  }

  return { key, subkeys, signatures, userIds };
}

export interface Cleartext {
  /** The message as written, once the format's escaping is undone. */
  text: string;
  /** The exact bytes the signer hashed, which is not quite the text above. */
  data: Uint8Array;
  signatures: Signature[];
}

/**
 * Reads the cleartext form, where the message stays legible and the signature follows it.
 * Two details decide whether a signature checks out: a line beginning with a dash is
 * escaped and must be unescaped, and trailing whitespace is not signed, because it does
 * not survive being pasted through mail and editors.
 */
export function readCleartext(armored: string): Cleartext {
  if (armored.length > maxArmorBytes) throw new Malformed('armor');

  const begin = '-----BEGIN PGP SIGNED MESSAGE-----';
  const start = armored.indexOf(begin);
  const stop = armored.indexOf('-----BEGIN PGP SIGNATURE-----', start);

  if (start < 0 || stop < 0) throw new Malformed('cleartext');

  const lines = armored.slice(start + begin.length, stop).split(/\r?\n/);
  // From one past the marker's own line ending, so an empty header section still ends.
  const blank = lines.indexOf('', 1);

  if (blank < 0) throw new Malformed('cleartext');

  // The line ending before the signature belongs to the armor, not to the message.
  const body = lines
    .slice(blank + 1, -1)
    .map((line) => (line.startsWith('- ') ? line.slice(2) : line));

  return {
    text: body.join('\n'),
    data: new TextEncoder().encode(body.map((line) => line.replace(/[ \t]+$/, '')).join('\r\n')),
    signatures: packets(dearmor(armored.slice(stop), 'SIGNATURE'))
      .filter((packet) => packet.tag === 2)
      .map((packet) => readSignature(packet.body)),
  };
}

/** The frame a key is hashed under when something signs the key itself. */
function framed(key: PublicKey): Uint8Array {
  return key.version === 6
    ? bytes(new Uint8Array([0x9b]), big(key.packet.length), key.packet)
    : bytes(new Uint8Array([0x99, key.packet.length >> 8, key.packet.length & 255]), key.packet);
}

async function importKey(key: PublicKey, digest: string): Promise<CryptoKey> {
  const { subtle } = globalThis.crypto;

  if ([1, 3].includes(key.algorithm)) {
    const n = mpi(key.material, 0);
    const e = mpi(key.material, n.next);
    const url = (value: Uint8Array) => Buffer.from(value).toString('base64url');

    return subtle.importKey(
      'jwk',
      { kty: 'RSA', n: url(n.value), e: url(e.value) },
      { name: 'RSASSA-PKCS1-v1_5', hash: digest },
      false,
      ['verify'],
    );
  }

  // From version 6 the curve is implied by the algorithm and the point is stored plainly.
  if (key.algorithm === 27)
    return subtle.importKey(
      'raw',
      plain(key.material.subarray(0, 32)),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );

  const size = readUint(key.material, 0, 1);
  const curve = curves[hex(key.material.subarray(1, 1 + size))];
  const point = mpi(key.material, 1 + size).value;

  if (key.algorithm === 22) {
    if (curve !== 'Ed25519' || point[0] !== 0x40) throw new Malformed('curve');

    return subtle.importKey('raw', plain(point.subarray(1)), { name: 'Ed25519' }, false, [
      'verify',
    ]);
  }

  if (key.algorithm === 19 && curve && curve.startsWith('P-'))
    return subtle.importKey('raw', plain(point), { name: 'ECDSA', namedCurve: curve }, false, [
      'verify',
    ]);

  throw new Malformed('key algorithm');
}

/**
 * Checks one signature against one key. What is hashed is the data, then the signature's
 * own hashed half, then a trailer stating how much of it counted, so a signature cannot be
 * lifted onto another message or quietly re-scoped.
 */
export async function verify(
  key: PublicKey,
  signature: Signature,
  data: Uint8Array,
): Promise<boolean> {
  const digest = digests[signature.hash];

  if (!digest) return false;

  const input = bytes(
    signature.salt,
    data,
    signature.hashed,
    new Uint8Array([signature.version, 0xff]),
    big(signature.hashed.length),
  );

  try {
    const { subtle } = globalThis.crypto;
    const imported = await importKey(key, digest);

    // Edwards signatures are made over the digest rather than the message, so the digest
    // is what gets verified; the others let WebCrypto hash the input itself.
    if (imported.algorithm.name === 'Ed25519')
      return await subtle.verify(
        { name: 'Ed25519' },
        imported,
        plain(signature.value),
        new Uint8Array(await subtle.digest(digest, input)),
      );

    return await subtle.verify(
      imported.algorithm.name === 'ECDSA'
        ? { name: 'ECDSA', hash: digest }
        : { name: 'RSASSA-PKCS1-v1_5' },
      imported,
      plain(signature.value),
      input,
    );
  } catch {
    return false;
  }
}

/**
 * Whether the key says of itself that it is no longer to be used. A revocation only counts
 * when the key signed it, which is what lets it travel over any channel at all: a hostile
 * keyserver can withhold one, but it cannot manufacture one.
 */
export async function revoked(certificate: Certificate): Promise<boolean> {
  for (const signature of certificate.signatures) {
    if (signature.type !== 0x20) continue;

    if (await verify(certificate.key, signature, framed(certificate.key))) return true;
  }

  return false;
}

/**
 * Whether the primary key has taken responsibility for this subkey. Position in the stream
 * is not an answer: a published key travels through hands that can append to it, so a
 * subkey counts only where the primary signed a binding for it and did not later withdraw
 * one. Without this check anyone could staple their own signing subkey to someone's key
 * and sign as them.
 */
async function bound(primary: PublicKey, subkey: Subkey): Promise<boolean> {
  const data = bytes(framed(primary), framed(subkey.key));
  let binding = false;

  for (const signature of subkey.bindings) {
    if (signature.type === 0x28 && (await verify(primary, signature, data))) return false;

    if (signature.type === 0x18 && (await verify(primary, signature, data))) binding = true;
  }

  return binding;
}

/**
 * The names this key has signed for itself, in the order they were published. A user id is
 * only ever the holder's own claim about where to find them, but it is a claim the key
 * made, and without checking that, anyone could append a name to a copy of a published key
 * and have it read back as though its holder had written it.
 *
 * It says nothing about whether the address works or who reads it. That is not something a
 * key can establish about itself, and this does not pretend otherwise.
 */
export async function identities(certificate: Certificate): Promise<string[]> {
  const found: string[] = [];

  for (const userId of certificate.userIds) {
    const data = bytes(
      framed(certificate.key),
      new Uint8Array([0xb4]),
      big(userId.raw.length),
      userId.raw,
    );

    const made = async (types: number[]) => {
      for (const signature of userId.certifications)
        if (types.includes(signature.type) && (await verify(certificate.key, signature, data)))
          return true;

      return false;
    };

    // Withdrawn beats certified however the packets happen to be ordered.
    if (await made([0x30])) continue;

    if (await made([0x10, 0x11, 0x12, 0x13])) found.push(userId.text);
  }

  return found;
}

/**
 * Whether this key made this message, under a signature that says it signed a document.
 * A signing subkey counts as the key: most people sign with one without ever being told,
 * and the primary key vouching for it is exactly what a subkey is for.
 */
export async function signed(certificate: Certificate, message: Cleartext): Promise<boolean> {
  for (const signature of message.signatures) {
    if (![0x00, 0x01].includes(signature.type)) continue;

    if (await verify(certificate.key, signature, message.data)) return true;

    for (const subkey of certificate.subkeys) {
      if (
        (await bound(certificate.key, subkey)) &&
        (await verify(subkey.key, signature, message.data))
      )
        return true;
    }
  }

  return false;
}
