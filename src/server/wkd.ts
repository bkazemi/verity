import { createHash } from 'node:crypto';

/** Z-Base-32, which is not RFC 4648's alphabet: the spec picked this one for legibility. */
const alphabet = 'ybndrfg8ejkmcpqxot1uwisza345h769';

/**
 * Domain suffixes that must never be fetched. The address comes off a key a stranger
 * pasted, so it names the host, and these are the names that can resolve to something
 * inside the network running this. Reserved suffixes that resolve nowhere are left alone:
 * asking about them is pointless rather than dangerous, and they are what tests use.
 */
const reserved = ['local', 'internal', 'localhost', 'home', 'lan', 'corp', 'intranet'];

function zbase32(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  // A twenty byte digest is exactly thirty two characters, so nothing is ever left over.
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31];

  return out;
}

/**
 * Splits an address into the parts the directory is addressed by. The local part is
 * lowercased and hashed rather than sent, which is the point of the scheme: a domain can
 * answer for an address without publishing a list of the addresses it has.
 */
function parts(address: string): { local: string; domain: string } | undefined {
  const at = address.lastIndexOf('@');

  if (at < 1 || at === address.length - 1) return undefined;

  const local = address.slice(0, at);
  const domain = address.slice(at + 1).toLowerCase();

  // A host, not an address literal and not something that resolves inside the network.
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain))
    return undefined;

  if (/^[\d.]+$/.test(domain) || reserved.includes(domain.split('.').pop()!)) return undefined;

  if (local.length > 100 || domain.length > 253) return undefined;

  return { local, domain };
}

/**
 * Where a domain would publish the key for one of its addresses, most specific first. The
 * advanced form lives on a subdomain a mail operator can delegate without touching the
 * main site; the direct form is on the domain itself. Both are tried because both are in
 * use, and either one answering is the domain answering.
 */
export function wkdUrls(address: string): string[] {
  const split = parts(address);

  if (!split) return [];

  const hashed = zbase32(
    Uint8Array.from(createHash('sha1').update(split.local.toLowerCase(), 'utf8').digest()),
  );

  const query = `?l=${encodeURIComponent(split.local)}`;

  return [
    `https://openpgpkey.${split.domain}/.well-known/openpgpkey/${split.domain}/hu/${hashed}${query}`,
    `https://${split.domain}/.well-known/openpgpkey/hu/${hashed}${query}`,
  ];
}
