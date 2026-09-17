import type { ArtifactProvider, ExternalAccount } from '../core/index.js';

/**
 * Proves control of a GitHub account by having its holder publish a given line in a public
 * gist. No app registration, no client secret, and no token: the proof is a public document
 * anyone can fetch, so a reader can repeat this check without trusting the backend that ran
 * it. The unauthenticated API allows sixty requests an hour per address, which bounds how
 * often connections using this method can be rechecked.
 */
export function githubGistProvider(options: { fetch?: typeof fetch } = {}): ArtifactProvider {
  const request = options.fetch ?? fetch;

  return {
    id: 'github',
    name: 'GitHub',
    method: 'attestation',
    instructions: (expect) =>
      `Create a public gist at https://gist.github.com containing this line exactly, then paste the gist address below: ${expect}`,
    async verify({ artifactUrl, expect }): Promise<ExternalAccount> {
      const url = new URL(artifactUrl);

      // The holder chooses this url, so nothing outside gist.github.com is ever fetched.
      if (url.protocol !== 'https:' || url.host !== 'gist.github.com')
        throw new Error('Not a gist address');

      const id = url.pathname.split('/').filter(Boolean).at(-1) ?? '';

      if (!/^[0-9a-f]{20,32}$/.test(id)) throw new Error('Not a gist address');

      const response = await request(`https://api.github.com/gists/${id}`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Verity-V0' },
        signal: AbortSignal.timeout(15000),
      });

      const gist: unknown = await response.json();

      if (!response.ok || !isRecord(gist)) throw new Error('Gist unavailable');

      // A secret gist proves nothing a reader could check for themselves.
      if (gist.public !== true) throw new Error('Gist is not public');

      const owner = gist.owner;

      if (
        !isRecord(owner) ||
        !Number.isSafeInteger(owner.id) ||
        Number(owner.id) <= 0 ||
        typeof owner.login !== 'string' ||
        !/^[a-zA-Z0-9-]+$/.test(owner.login)
      )
        throw new Error('Invalid gist owner');

      if (!isRecord(gist.files) || !contains(gist.files, expect))
        throw new Error('Gist does not contain the expected line');

      return {
        id: String(owner.id),
        handle: owner.login,
        profileUrl: `https://github.com/${owner.login}`,
      };
    },
  };
}

/** A truncated file is not proof: the part that would have matched may be the part omitted. */
function contains(files: Record<string, unknown>, expect: string): boolean {
  return Object.values(files).some(
    (file) =>
      isRecord(file) &&
      file.truncated !== true &&
      typeof file.content === 'string' &&
      file.content.includes(expect),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
