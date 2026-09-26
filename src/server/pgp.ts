import { Refused, type ArtifactProvider, type ExternalAccount } from '../core/index.js';
import {
  fingerprint,
  identities,
  readCertificate,
  readCleartext,
  readKey,
  revoked,
  signed,
  type Certificate,
} from './openpgp.js';
import { discard, readBounded } from './body.js';
import { pinnable, publicFetch } from './public-fetch.js';
import { wkdUrls } from './wkd.js';

/** How much of a served key is read. Enough for a key and its signatures, and no more. */
const maxKeyBytes = 65536;

/**
 * Proves control of an OpenPGP key by having the holder sign the flow's line with it.
 *
 * A key has no provider. Nobody operates it, nobody can hand it to somebody else, and there
 * is no account table anywhere to consult: the fingerprint is the identity. That makes this
 * the one method where the proof needs no registration, no credentials, and no third party
 * at all, and where the address the proof came from means nothing. So the holder hands over
 * the proof itself and this backend publishes it, rather than pointing at somewhere to read.
 *
 * Two questions are asked of the network and neither answer is trusted, because both are
 * rechecked against the key this backend already holds. Has this key been withdrawn, which
 * only the key can say and a keyserver can only carry; and is there an address on it that
 * somebody other than its holder stands behind.
 *
 * The second question has two sources. A keyserver that confirms addresses publishes one
 * only after somebody reading mail there asked it to. A web key directory is stronger
 * still: the domain that owns the mailbox publishes the key itself, at an address derived
 * from the mailbox, so nobody outside that domain is being taken at their word.
 */
export function pgpProvider(
  options: {
    keyserver?: string;
    /**
     * Replaces the transport for both the keyserver and the web key directory, and with it
     * the check that keeps directory reads out of the network this runs in. Pass one only
     * where it enforces that itself, such as through an egress proxy.
     */
    fetch?: typeof fetch;
  } = {},
): ArtifactProvider {
  const request = options.fetch ?? fetch;

  // The keyserver is the operator's choice; a directory's host is a stranger's, named by
  // an address on their key, so where it resolves is checked on the connection itself.
  // Off Node that cannot be done, and the directory is skipped rather than read unguarded:
  // it only ever upgrades a fingerprint to an address.
  const directory = options.fetch ?? (pinnable() ? publicFetch() : undefined);
  const keyserver = new URL(options.keyserver ?? 'https://keys.openpgp.org');

  if (keyserver.protocol !== 'https:') throw new Error('Keyserver must be HTTPS');

  /**
   * The key as the keyserver has it, with everything that arrived with it pointed back at
   * the key already held. Nothing in the served copy is believed for having been served.
   */
  async function served(held: Certificate): Promise<Certificate | undefined> {
    const response = await request(
      new URL(`/vks/v1/by-fingerprint/${fingerprint(held)}`, keyserver).href,
      {
        headers: { Accept: 'application/pgp-keys' },
        // Workers refuse 'error'. A redirect comes back as a response that is not ok.
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
      },
    );

    let text: string;

    try {
      // Never uploaded, or since deleted. There is nowhere for anything to be published,
      // which is not the same as nothing having been published anywhere.
      if (response.status === 404) return undefined;

      if (!response.ok) throw new Error('Keyserver unavailable');

      text = new TextDecoder().decode((await readBounded(response, maxKeyBytes)).bytes);
    } finally {
      await discard(response);
    }

    const copy = await readCertificate(text);

    // The packets come from the keyserver, and are only ever checked against this key: the
    // fingerprint is a hash of the key itself, so a copy under it holds the same one.
    return fingerprint(copy) === fingerprint(held) ? copy : undefined;
  }

  /**
   * A key published at a mailbox's own well-known address. Fetched from a host named by a
   * stranger's key, so it is a GET to a fixed path on an https origin at a public address
   * and nothing else: no redirects to follow, a deadline, and a bounded read.
   */
  async function published(url: string): Promise<Certificate | undefined> {
    if (!directory) return undefined;

    const response = await directory(url, {
      headers: { Accept: 'application/octet-stream' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });

    let body: Uint8Array;

    try {
      if (!response.ok) return undefined;

      body = (await readBounded(response, maxKeyBytes)).bytes;
    } finally {
      await discard(response);
    }

    const text = new TextDecoder().decode(body.subarray(0, 40));

    // The scheme says packets. Some hosts serve armour anyway, and both are the same key.
    return text.includes('-----BEGIN')
      ? readCertificate(new TextDecoder().decode(body))
      : readKey(body);
  }

  /**
   * Whether the domain owning one of this key's addresses publishes this very key for it.
   * The address is in the url, so an answer carrying our fingerprint is that domain saying
   * the mailbox and the key belong together. Only addresses the key signed for are asked
   * about, and only a couple of them, since each one costs requests to somebody else's host.
   */
  async function byDomain(held: Certificate): Promise<string | undefined> {
    for (const name of (await identities(held)).slice(0, 2)) {
      const mailbox = address(name);

      for (const url of wkdUrls(mailbox)) {
        try {
          const key = await published(url);

          if (key && fingerprint(key) === fingerprint(held)) return mailbox;
        } catch {
          // Unreachable, redirected, or not a key. The next place, then nothing.
        }
      }
    }

    return undefined;
  }

  /**
   * An address, but only where two parties who cannot stand in for each other have both
   * said it: the key signed for it, and either a keyserver that confirms addresses or the
   * mailbox's own domain publishes the key under it.
   *
   * Either one alone is worth nothing. Minting a key that signs for `support@bank.example`
   * takes seconds, so a self-signed address printed beside a real proof would read as
   * established when nobody had established anything. A keyserver saying it alone is no
   * better, since a served packet is not evidence until the held key has signed it.
   *
   * Together they still say only that somebody could read that mailbox on the day they
   * confirmed it. That is why the fingerprint is carried alongside and never replaced.
   */
  async function confirmed(held: Certificate): Promise<string | undefined> {
    let copy: Certificate | undefined;

    try {
      copy = await served(held);
    } catch {
      // Unreachable. Nothing is concluded from it, and the other source is still asked.
      copy = undefined;
    }

    const [name] = copy ? await identities(copy) : [];

    // The keyserver is asked first because it is one request and answers directly. The
    // directory is the stronger answer, and is what covers a key uploaded nowhere.
    return name ? address(name) : await byDomain(held);
  }

  return {
    id: 'openpgp',
    name: 'OpenPGP',
    method: 'signature',
    artifact: 'document',
    instructions: (expect) => [
      'Sign the line with your key:',
      { code: `printf '%s\\n' '${expect}' | gpg --clearsign` },
      'Export the key that signed it:',
      { code: 'gpg --armor --export YOUR_KEY_ID' },
      'Paste the signed message below, then the key.',
      `Your key shows as its fingerprint. To show an email address instead, confirm it at ${keyserver.host} or publish your key in that domain's web key directory.`,
    ],
    async verify({ artifact, expect }): Promise<ExternalAccount> {
      const certificate = await readCertificate(artifact);
      const message = await readCleartext(artifact);

      if (!(await signed(certificate, message))) throw new Refused('Signature does not check out');

      // The line must stand on its own. A token buried inside a longer sentence was signed
      // too, but it was not necessarily agreed to, and the holder is agreeing to a sentence.
      if (
        !message
          .getText()
          .split('\n')
          .some((line) => line.trim() === expect)
      )
        throw new Refused('Signed message does not contain the line');

      return {
        id: fingerprint(certificate),
        kind: 'key',
        // What a reader recognises is an address, not forty hex digits. It is shown only
        // where it was confirmed, and the fingerprint stands in wherever it was not.
        handle: (await confirmed(certificate)) ?? short(fingerprint(certificate)),
        profileUrl: new URL(`/search?q=0x${fingerprint(certificate)}`, keyserver).href,
      };
    },
    async withdrawn(account, artifact): Promise<boolean> {
      const held = await readCertificate(artifact);

      if (fingerprint(held) !== account.id) return false;

      const copy = await served(held);

      // A revocation counts because the key signed it, not because it was handed over.
      return copy ? revoked(copy) : false;
    },
  };
}

/**
 * The address out of a user id, which is written `Some Name <somebody@example.test>`. The
 * address is the part that was confirmed; the name beside it is decoration anybody could
 * have typed, and showing them together would invite reading the name as established too.
 */
function address(userId: string): string {
  return (userId.match(/<([^>]{1,200})>/)?.[1] ?? userId).trim().slice(0, 200);
}

/** The last sixteen digits, in the groups of four that fingerprints are read in. */
function short(fingerprint: string): string {
  return (fingerprint.slice(-16).match(/.{4}/g) ?? []).join(' ');
}
