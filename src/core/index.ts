export type Visibility = 'public' | 'unlisted';

export type Status = 'verified' | 'expired' | 'revoked';

/** What a site links: one of its accounts, a single page, or the site itself. */
export type LocalKind = 'account' | 'page' | 'site';

/** id is private and must never be reassigned. reference is durable and public-safe. */
export interface LocalAccount {
  id: string;
  /** Absent means the site did not say. Renderers must not assume an account. */
  kind?: LocalKind;
  label: string;
  reference: string;
  /** Canonical URL for the linked subject: a profile, a page, or the site root. */
  profileUrl?: string;
}

export interface ExternalAccount {
  id: string;
  handle: string;
  profileUrl: string;
}

/**
 * How control of one side was shown. A provider is who an account belongs to; a method is
 * how control of it was demonstrated, and the two multiply rather than enumerate: one
 * provider may support several methods and one method spans providers.
 *
 * `declared` is the site asserting a subject from its own records. That is not a weaker
 * form of the others: a site is the only authority on its own namespace, so no external
 * source could improve on it. The rest publish an artifact a reader can fetch.
 */
export type Method = 'declared' | 'oauth' | 'attestation' | 'dns' | 'wellknown' | 'signature';

/** Who vouches for one side: this backend from its own records, or the account's provider. */
export type Attester = 'backend' | 'provider';

/**
 * How one side of a link was established. `artifactUrl` is present only when the method
 * leaves a public proof, which is what lets a reader check the claim without trusting
 * this backend, and lets another installation reverify it independently.
 */
export interface Attestation {
  by: Attester;
  method: Method;
  /** Public location of the proof. Never a sharing link or any other secret. */
  artifactUrl?: string;
  /** What a reader should expect to find at artifactUrl, such as a challenge token. */
  expect?: string;
  /**
   * When this side was last confirmed. For `declared` and `oauth` that is the moment it
   * was established; artifact methods drift out of date and are reconfirmed on a schedule.
   */
  confirmedAt: number;
}

/** Each side of a link is attested separately, by different parties under different methods. */
export interface Attestations {
  local: Attestation;
  external: Attestation;
}

export interface Connection {
  id: string;
  local: LocalAccount;
  external: ExternalAccount;
  provider: string;
  visibility: Visibility;
  visibilityApprovedAt: number;
  authenticatedAt: number;
  approvedAt: number;
  expiresAt: number;
  revokedAt?: number;
  revocationReason?: string;
  /** Absent on records written before methods were recorded; evidence infers those. */
  attestations?: Attestations;
}

export interface Flow {
  id: string;
  stateHash: string;
  bindingHash: string;
  verifier?: string;
  kind: 'connect' | 'renew' | 'revoke' | 'visibility' | 'share-revoke';
  local?: LocalAccount;
  connectionId?: string;
  phase: 'pending' | 'exchanging' | 'approval' | 'complete' | 'cancelled' | 'failed';
  expiresAt: number;
  external?: ExternalAccount;
  authenticatedAt?: number;
  resultId?: string;
}

export interface Share {
  connectionId: string;
  tokenHash: string;
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
}

export interface Audit {
  id: string;
  connectionId?: string;
  flowId?: string;
  action: string;
  actor: 'local' | 'external';
  at: number;
  visibility?: Visibility;
}

export interface Records {
  connections: Connection;
  flows: Flow;
  shares: Share;
  audit: Audit;
}

export interface Transaction {
  get<K extends keyof Records>(kind: K, id: string): Promise<Records[K] | undefined>;
  put<K extends keyof Records>(kind: K, id: string, value: Records[K]): Promise<void>;
  delete(kind: keyof Records, id: string): Promise<void>;
  list<K extends keyof Records>(kind: K): Promise<Records[K][]>;
}

/** Must serialize concurrent transactions and roll back all writes on rejection. */
export interface Storage {
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
}

export interface Provider {
  id: string;
  name: string;
  /**
   * How this implementation demonstrates control. Absent means `oauth`, the redirect and
   * code exchange the interface below describes. A second implementation may carry the
   * same id with a different method: one provider, more than one way to prove it.
   */
  method?: Method;
  authorizationUrl(input: { state: string; challenge: string; redirectUri: string }): string;
  authenticate(input: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<ExternalAccount>;
}

export interface Evidence {
  id: string;
  local: Omit<LocalAccount, 'id'>;
  external: ExternalAccount;
  provider: string;
  /** Display name from the provider implementation; absent from older backends. */
  providerName?: string;
  /**
   * How each side was established, so a reader can weigh them separately instead of
   * reading one undifferentiated "verified". Absent from older backends.
   */
  attestations?: Attestations;
  siteName: string;
  verifierName: string;
  visibility: Visibility;
  status: Status;
  authenticatedAt: number;
  approvedAt: number;
  visibilityApprovedAt: number;
  expiresAt: number;
  revokedAt?: number;
  evidenceUrl: string;
}

export function status(connection: Connection, now: number): Status {
  if (connection.revokedAt !== undefined) return 'revoked';

  return now >= connection.expiresAt ? 'expired' : 'verified';
}

/**
 * How to describe one side's proof in plain words. It names the attester and the method
 * together and does not rank them: whether a given proof is convincing is the reader's
 * judgement, which is the reason for publishing it rather than a verdict about it.
 *
 * An unrecognised method returns nothing, so a renderer omits the line instead of
 * describing a proof it does not understand.
 */
export function attestationLabel(
  method: string,
  names: { site: string; provider: string },
): string | undefined {
  return {
    declared: `Stated by ${names.site}`,
    oauth: `Signed in with ${names.provider}`,
    attestation: `Published a proof on ${names.provider}`,
    dns: 'Proved with a DNS record',
    wellknown: 'Proved with a file on the domain',
    signature: 'Proved with a signature',
  }[method];
}
