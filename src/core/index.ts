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
