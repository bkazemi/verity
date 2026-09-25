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
  /**
   * What the other side is. Absent means an account, which is what a provider issues and
   * can reassign. A key is not an account: nobody issued it and nobody can hand it over.
   * A page is an address that was read and nothing more: a method that only fetches a
   * document learns what it says, never whose account the address is.
   */
  kind?: 'account' | 'key' | 'page';
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
export type Method =
  'declared' | 'oauth' | 'attestation' | 'backlink' | 'dns' | 'wellknown' | 'signature';

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
  /**
   * True when this backend serves the proof itself rather than reading it somewhere else.
   * A hosted proof cannot go missing behind our back, so it never needs reconfirming.
   */
  hosted?: boolean;
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
  /** How the external account was first shown. It stays the main one for the record's life. */
  external: Attestation;
  /**
   * Every other method the same external account has since been shown by, in the order
   * each was first used, at most one per method. They corroborate the main one and never
   * replace it: a record is still judged by `external`.
   */
  further?: Attestation[];
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
  /** The proof itself, for a method whose artifact this backend publishes rather than reads. */
  proof?: string;
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
  /**
   * The string an artifact must contain. Public by design: the holder publishes it. It is
   * unguessable and per-flow, so an artifact made for one flow cannot complete another.
   */
  expect?: string;
  /** What the holder handed back: an address to read, or the proof itself. */
  artifact?: string;
  /**
   * Which configured method the flow runs: the provider's id and its method. Absent on
   * flows written by a backend that had only one, which is the first one configured.
   */
  provider?: string;
  method?: Method;
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

/**
 * Proves control by sending the holder to the provider and back in one round trip. The
 * provider is the only party that sees the holder's credentials, and nothing is published.
 */
export interface RedirectProvider {
  id: string;
  name: string;
  /** Absent means oauth, the shape this interface describes. */
  method?: 'oauth';
  authorizationUrl(input: { state: string; challenge: string; redirectUri: string }): string;
  authenticate(input: {
    code: string;
    verifier: string;
    redirectUri: string;
  }): Promise<ExternalAccount>;
}

/**
 * Proves control by having the holder publish a given string somewhere only they can write,
 * then reading it back. It is holder-paced rather than one round trip, it needs no
 * registration with the provider, and it leaves a proof a reader can check for themselves.
 */
export interface ArtifactProvider {
  id: string;
  name: string;
  method: Exclude<Method, 'declared' | 'oauth'>;
  /**
   * What the holder must publish, for a method that does not get to choose it. A backlink
   * says the far side points at this exact subject, so the subject's own address is the
   * whole of what is proved and a per-flow token could not be part of it. Absent means the
   * backend mints an unguessable string instead, which is what a method wants when any
   * fresh artifact will do. Throw when the subject cannot be proved this way at all.
   */
  expect?(local: LocalAccount): string;
  /**
   * Where the proof lives. `location` means the holder publishes it somewhere only they
   * can write and hands back an address, so the address is half of what is proved.
   * `document` means they hand back the proof itself and this backend publishes it,
   * because a signature proves itself and where it was typed proves nothing at all.
   */
  artifact: 'location' | 'document';
  /**
   * Told to the holder verbatim. Must name what they are publishing and where. Returned in
   * pieces so a renderer can set a command as one: a command is copied character for
   * character, and prose that reflows is prose a holder cannot safely copy.
   */
  instructions(expect: string): Instruction[];
  /**
   * Reads what the holder handed back and returns whose it is. Must confirm it contains
   * `expect`. A `location` provider must also refuse any address outside itself, since
   * the holder chooses that address and an unpinned fetch is an open proxy.
   */
  verify(input: { artifact: string; expect: string }): Promise<ExternalAccount>;
  /**
   * Whether the holder has since withdrawn the identity itself, wherever such a statement
   * is published. This revokes the connection, so it must be something the holder stated
   * and this provider verified, never something a third party merely asserted.
   */
  withdrawn?(account: ExternalAccount, artifact: string): Promise<boolean>;
}

/** A piece of what the holder is told: a paragraph, or something they run or publish as is. */
export type Instruction = string | { code: string };

export type Provider = RedirectProvider | ArtifactProvider;

/** Only an artifact provider is holder-paced, and only it needs a url handed back. */
export function isArtifactProvider(provider: Provider): provider is ArtifactProvider {
  return 'verify' in provider;
}

/** How a provider shows control. A redirect provider that names none is oauth. */
export function providerMethod(provider: Provider): Method {
  return provider.method ?? 'oauth';
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

/**
 * How long a published proof stays good without being read again. An artifact method is
 * only true while the artifact is still there, and the holder can delete it without
 * telling anyone, so a confirmation is a heartbeat rather than a permanent fact.
 */
export const freshnessMs = 7 * 86400000;

/**
 * `freshness` bounds how stale a published proof may be before it stops counting. A
 * backend that never rechecks must leave it unbounded, since an unread proof going stale
 * is a statement about the recheck, and claiming one that never ran would be a lie.
 */
export function status(connection: Connection, now: number, freshness = freshnessMs): Status {
  if (connection.revokedAt !== undefined) return 'revoked';

  if (now >= connection.expiresAt) return 'expired';

  const external = connection.attestations?.external;

  if (external && !fresh(external, now, freshness)) return 'expired';

  return 'verified';
}

/**
 * Whether one method still counts. A sign-in happened once and stays happened. A proof
 * that has not been read lately is unconfirmed rather than disproved, which is why this
 * reverses the moment it reads again.
 */
export function fresh(attestation: Attestation, now: number, freshness = freshnessMs): boolean {
  return (
    !attestation.artifactUrl ||
    attestation.hosted === true ||
    freshness === Infinity ||
    now < attestation.confirmedAt + freshness
  );
}

/**
 * The word for a record's state. It separates the two ways one stops counting: an approval
 * that ran out is over until the holder renews it, while a proof that has not been read
 * lately is only unconfirmed and says so again the moment it reads. Both are `expired` as
 * a status, since a reader should act the same way, but they do not mean the same thing.
 */
export function statusLabel(evidence: Pick<Evidence, 'status' | 'expiresAt'>, now: number): string {
  if (evidence.status === 'revoked') return 'Revoked';

  if (evidence.status === 'verified' && evidence.expiresAt > now) return 'Verified';

  return evidence.expiresAt > now ? 'Unconfirmed' : 'Expired';
}

/**
 * What to call a link's local side, and what to write as its value. When the site itself is
 * what was linked there is no subject on it to name, so the site is the value rather than a
 * label above some other thing. An absent kind means the site did not say, so nothing is
 * assumed about one.
 */
export function localSide(
  local: Pick<LocalAccount, 'kind' | 'label'>,
  siteName: string,
): { heading: string; value: string } {
  if (local.kind === 'site') return { heading: 'Website', value: siteName };

  const heading: Record<string, string> = {
    account: `Account on ${siteName}`,
    page: `Page on ${siteName}`,
  };

  return { heading: heading[local.kind ?? ''] ?? siteName, value: local.label };
}

/**
 * How to write an external subject's name. The @ that marks a handle is a claim that there
 * is an account behind it, issued by somebody who could also take it away. A key has no
 * account and no handle: it is named by its own fingerprint, so it is written as it is. A
 * page is named by its address for the same reason, since fetching one says where it is
 * and never who holds it.
 */
export function externalName(external: ExternalAccount): string {
  return external.kind === undefined || external.kind === 'account'
    ? `@${external.handle.replace(/^@/, '')}`
    : external.handle;
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
    backlink: `Linked back to ${names.site}`,
    dns: 'Proved with a DNS record',
    wellknown: 'Proved with a file on the domain',
    signature: 'Proved with a signature',
  }[method];
}
