import type {
  Records,
  Storage,
  Transaction,
  RedirectProvider,
  ArtifactProvider,
} from '../src/core/index.js';

export class MemoryStorage implements Storage {
  rows = new Map<string, unknown>();
  private tail: Promise<unknown> = Promise.resolve();

  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    const operation = this.tail.then(async () => {
      const rows = structuredClone(this.rows);

      const result = await work({
        async get<K extends keyof Records>(kind: K, id: string) {
          return structuredClone(rows.get(`${kind}:${id}`)) as Records[K] | undefined;
        },
        async put(kind, id, value) {
          rows.set(`${kind}:${id}`, structuredClone(value));
        },
        async delete(kind, id) {
          rows.delete(`${kind}:${id}`);
        },
        async list<K extends keyof Records>(kind: K) {
          return [...rows]
            .filter(([key]) => key.startsWith(`${kind}:`))
            .map(([, value]) => structuredClone(value) as Records[K]);
        },
      });

      this.rows = rows;

      return result;
    });

    this.tail = operation.catch(() => {});

    return operation;
  }
}

export const alice = {
  id: 'private-local-1',
  label: 'Alice',
  reference: 'member-1',
  profileUrl: 'https://site.test/users/1',
};

export const bob = { id: 'private-local-2', label: 'Bob', reference: 'member-2' };

/** A link whose local side is a page rather than one of the site's accounts. */
export const projectPage = {
  id: 'private-local-3',
  kind: 'page' as const,
  label: 'Verity project page',
  reference: 'site.test/projects/verity',
  profileUrl: 'https://site.test/projects/verity',
};

export function fakeProvider(): RedirectProvider & { calls: number; externalId: string } {
  return {
    id: 'github',
    name: 'GitHub',
    calls: 0,
    externalId: '42',
    authorizationUrl({ state, challenge, redirectUri }) {
      return `https://provider.test/authorize?${new URLSearchParams({ state, challenge, redirect_uri: redirectUri })}`;
    },
    async authenticate() {
      this.calls++;

      return {
        id: this.externalId,
        handle: 'known-alice',
        profileUrl: 'https://github.com/known-alice',
      };
    },
  };
}

/** Holder-paced counterpart to fakeProvider: nothing is fetched, the artifact is a map. */
export function fakeArtifactProvider(): ArtifactProvider & {
  artifacts: Map<string, string>;
  externalId: string;
  calls: number;
} {
  const artifacts = new Map<string, string>();

  return {
    id: 'notes',
    name: 'Notes',
    method: 'attestation',
    artifact: 'location',
    artifacts,
    externalId: '42',
    calls: 0,
    instructions: (expect) => `Publish this line: ${expect}`,
    verify({ artifact, expect }) {
      this.calls += 1;

      if (new URL(artifact).host !== 'notes.test') throw new Error('Not a notes address');

      if (artifacts.get(artifact) !== expect) throw new Error('Line not found');

      return Promise.resolve({
        id: this.externalId,
        handle: 'alice',
        profileUrl: 'https://notes.test/alice',
      });
    },
  };
}

/**
 * A provider whose proof this backend publishes rather than reads. Nothing is fetched to
 * establish it; the only thing left to ask later is whether the holder withdrew the
 * identity, which is what `gone` stands in for.
 */
export function fakeDocumentProvider(): ArtifactProvider & {
  gone: boolean;
  fail: boolean;
  externalId: string;
  calls: number;
} {
  return {
    id: 'keys',
    name: 'Keys',
    method: 'signature',
    artifact: 'document',
    gone: false,
    fail: false,
    externalId: 'FINGERPRINT',
    calls: 0,
    instructions: (expect) => `Sign this line and paste the result: ${expect}`,
    verify({ artifact, expect }) {
      if (!artifact.includes(expect)) throw new Error('Line not signed');

      return Promise.resolve({
        id: this.externalId,
        handle: 'AAAA BBBB',
        profileUrl: 'https://keys.test/AAAABBBB',
      });
    },
    withdrawn() {
      this.calls += 1;

      if (this.fail) throw new Error('Keyserver unavailable');

      return Promise.resolve(this.gone);
    },
  };
}
