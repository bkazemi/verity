import { createHash, randomBytes } from 'node:crypto';
import {
  freshnessMs,
  isArtifactProvider,
  status,
  type ArtifactProvider,
  type Attestation,
  type Attestations,
  type Connection,
  type Evidence,
  type ExternalAccount,
  type Flow,
  type LocalAccount,
  type Provider,
  type RedirectProvider,
  type Storage,
  type Transaction,
  type Visibility,
} from '../core/index.js';

export const secret = () => randomBytes(32).toString('base64url');

export const hash = (value: string) => createHash('sha256').update(value).digest('base64url');

export class Unavailable extends Error {
  constructor() {
    super('Unavailable');
  }
}

export interface ServiceOptions {
  storage: Storage;
  provider: Provider;
  baseUrl: string;
  siteName: string;
  verifierName: string;
  profileOrigins: string[];
  validityMs?: number;
  flowTtlMs?: number;
  shareTtlMs?: number;
  /** How stale a published proof may be before it stops counting. Infinity never expires. */
  freshnessMs?: number;
  /** How often recheck() reads a given proof again. Must be well under freshnessMs. */
  recheckMs?: number;
  recheckTimeoutMs?: number;
  now?: () => number;
}

export class VerityService {
  readonly now: () => number;
  readonly baseUrl: string;

  constructor(readonly options: ServiceOptions) {
    this.now = options.now ?? Date.now;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    const url = new URL(this.baseUrl);

    if (
      url.search ||
      url.hash ||
      url.username ||
      url.password ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    )
      throw new Error('Use HTTPS (HTTP allowed on localhost)');

    for (const duration of [
      options.validityMs,
      options.flowTtlMs,
      options.shareTtlMs,
      options.recheckMs,
      options.recheckTimeoutMs,
    ]) {
      if (duration !== undefined && (!Number.isSafeInteger(duration) || duration <= 0))
        throw new Error('Invalid duration');
    }

    if (
      options.freshnessMs !== undefined &&
      options.freshnessMs !== Infinity &&
      (!Number.isSafeInteger(options.freshnessMs) || options.freshnessMs <= 0)
    )
      throw new Error('Invalid duration');

    if (this.freshness <= (options.recheckMs ?? 86400000))
      throw new Error('freshnessMs must exceed recheckMs');
  }

  /** A proof is only as fresh as the schedule that reads it, so both live together. */
  private get freshness(): number {
    return this.options.freshnessMs ?? freshnessMs;
  }

  validateLocal(local: LocalAccount): LocalAccount {
    if (
      ![local.id, local.label, local.reference].every(
        (v) => typeof v === 'string' && v.length > 0 && v.length <= 500,
      )
    )
      throw new Error('Invalid local subject adapter result');

    if (local.kind !== undefined && !['account', 'page', 'site'].includes(local.kind))
      throw new Error('Invalid local subject kind');

    if (local.profileUrl) {
      const url = new URL(local.profileUrl);

      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        !this.options.profileOrigins.includes(url.origin)
      )
        throw new Error('Unregistered profile origin');
    }

    return structuredClone(local);
  }

  async start(local?: LocalAccount, connectionId?: string, kind: Flow['kind'] = 'connect') {
    if (kind === 'connect' && !local) throw new Unavailable();

    if (local) local = this.validateLocal(local);

    if (kind !== 'connect' && !connectionId) throw new Unavailable();

    const state = secret(),
      binding = secret(),
      verifier = secret();

    const flow: Flow = {
      id: hash(state),
      stateHash: hash(state),
      bindingHash: hash(binding),
      verifier,
      kind,
      local,
      connectionId,
      phase: 'pending',
      expiresAt: this.now() + (this.options.flowTtlMs ?? 600000),
    };

    const artifact = isArtifactProvider(this.options.provider) ? this.options.provider : undefined;

    // Unguessable and per-flow, so an artifact published for one flow cannot complete
    // another, and naming the site means the holder can see what they are agreeing to
    // before they publish anything.
    if (artifact) flow.expect = `Verity proof for ${this.options.siteName}: ${secret()}`;

    await this.options.storage.transaction(async (tx) => {
      if (kind !== 'connect') {
        const connection = await tx.get('connections', connectionId!);

        // No account disclosure at entry; only the matching provider account can inspect later.
        if (
          !connection ||
          connection.revokedAt !== undefined ||
          (['visibility', 'renew'].includes(kind) && connection.local.id !== local?.id)
        )
          throw new Unavailable();
      }

      await tx.put('flows', flow.id, flow);
    });

    // A redirect provider hands the holder to its own site; an artifact provider tells
    // them what to publish and waits for them to say where they put it.
    return artifact
      ? {
          flowId: flow.id,
          binding,
          expect: flow.expect!,
          instructions: artifact.instructions(flow.expect!),
        }
      : {
          flowId: flow.id,
          binding,
          authorizationUrl: (this.options.provider as RedirectProvider).authorizationUrl({
            state,
            challenge: hash(verifier),
            redirectUri: `${this.baseUrl}/callback`,
          }),
        };
  }

  /**
   * Accepts the location the holder says they published the flow's string at, reads it, and
   * records whose account published it. The url is holder-supplied, so the provider is
   * responsible for refusing anything outside itself.
   */
  async submit(id: string, binding: string, artifactUrl: string): Promise<string> {
    const provider = this.options.provider;

    if (!isArtifactProvider(provider)) throw new Unavailable();

    const expect = await this.options.storage.transaction(async (tx) => {
      const flow = await this.bound(tx, id, binding);

      if (flow.phase !== 'pending' || !flow.expect) throw new Unavailable();

      flow.phase = 'exchanging';
      await tx.put('flows', id, flow);

      return flow.expect;
    });

    try {
      const external = await provider.verify({ artifactUrl, expect });

      await this.established(id, binding, external, artifactUrl);
    } catch {
      await this.failed(id);
    }

    return id;
  }

  private async bound(tx: Transaction, id: string, binding: string): Promise<Flow> {
    const flow = await tx.get('flows', id);

    if (!flow || flow.bindingHash !== hash(binding) || flow.expiresAt <= this.now())
      throw new Unavailable();

    return flow;
  }

  async flow(id: string, binding: string): Promise<Flow> {
    return this.options.storage.transaction((tx) => this.bound(tx, id, binding));
  }

  async callback(state: string, binding: string, code?: string): Promise<string> {
    const id = hash(state);

    const claimed = await this.options.storage.transaction(async (tx) => {
      const flow = await this.bound(tx, id, binding);

      if (flow.phase !== 'pending') throw new Unavailable();

      flow.phase = code ? 'exchanging' : 'cancelled';
      const verifier = flow.verifier!;

      delete flow.verifier;
      await tx.put('flows', id, flow);

      return { flow, verifier };
    });

    if (!code) return id;

    try {
      const external = await (this.options.provider as RedirectProvider).authenticate({
        code,
        verifier: claimed.verifier,
        redirectUri: `${this.baseUrl}/callback`,
      });

      await this.established(id, binding, external);
    } catch {
      await this.failed(id);
    }

    return id;
  }

  /**
   * The identity is established the same way whichever method produced it, so both paths
   * land here: a provider result is never trusted for its shape, and a flow against an
   * existing connection must still be the same account on the same provider.
   */
  private async established(
    id: string,
    binding: string,
    external: ExternalAccount,
    artifactUrl?: string,
  ) {
    if (
      typeof external.id !== 'string' ||
      !external.id ||
      typeof external.handle !== 'string' ||
      !external.handle ||
      typeof external.profileUrl !== 'string' ||
      new URL(external.profileUrl).protocol !== 'https:'
    )
      throw new Unavailable();

    await this.options.storage.transaction(async (tx) => {
      const flow = await this.bound(tx, id, binding);

      if (flow.phase !== 'exchanging') throw new Unavailable();

      if (flow.kind !== 'connect') {
        const connection = await tx.get('connections', flow.connectionId!);

        if (
          !connection ||
          connection.provider !== this.options.provider.id ||
          connection.external.id !== external.id ||
          connection.revokedAt !== undefined
        )
          throw new Unavailable();

        flow.local = connection.local;
      }

      flow.external = external;
      flow.artifactUrl = artifactUrl;
      flow.authenticatedAt = this.now();
      flow.phase = 'approval';
      await tx.put('flows', id, flow);
    });
  }

  /** A failed check leaves the flow dead rather than retryable in place. */
  private async failed(id: string) {
    await this.options.storage.transaction(async (tx) => {
      const flow = await tx.get('flows', id);

      if (flow?.phase === 'exchanging') {
        flow.phase = 'failed';
        await tx.put('flows', id, flow);
      }
    });
  }

  async approve(
    id: string,
    binding: string,
    local: LocalAccount | undefined,
    visibility: Visibility,
    cancel = false,
  ) {
    if (!['public', 'unlisted'].includes(visibility)) throw new Unavailable();

    return this.options.storage.transaction(async (tx) => {
      const flow = await this.bound(tx, id, binding);

      if (
        !['revoke', 'share-revoke'].includes(flow.kind) &&
        (!local || local.id !== flow.local?.id)
      )
        throw new Unavailable();

      if (flow.phase === 'complete') return flow.resultId!;

      if (flow.phase !== 'approval') throw new Unavailable();

      if (cancel) {
        flow.phase = 'cancelled';
        await tx.put('flows', id, flow);

        return undefined;
      }

      let connection: Connection;

      if (flow.kind === 'connect') {
        connection = {
          id: secret(),
          local: flow.local!,
          external: flow.external!,
          provider: this.options.provider.id,
          visibility,
          visibilityApprovedAt: this.now(),
          authenticatedAt: flow.authenticatedAt!,
          approvedAt: this.now(),
          expiresAt: this.now() + (this.options.validityMs ?? 30 * 86400000),
          attestations: this.attestations(flow),
        };
      } else {
        const existing = await tx.get('connections', flow.connectionId!);

        if (
          !existing ||
          existing.revokedAt !== undefined ||
          existing.external.id !== flow.external!.id
        )
          throw new Unavailable();

        connection = existing;

        if (flow.kind !== 'renew') await this.invalidateShare(tx, connection.id);

        if (flow.kind === 'renew') {
          // Re-approval of the same pair extends the record rather than minting a new
          // id, so embeds and evidence urls published earlier keep resolving. The
          // subject snapshot refreshes because the holder just approved what it shows.
          if (flow.local!.id !== existing.local.id) throw new Unavailable();

          connection.local = flow.local!;
          connection.authenticatedAt = flow.authenticatedAt!;
          connection.approvedAt = this.now();
          connection.expiresAt = this.now() + (this.options.validityMs ?? 30 * 86400000);
          connection.revocationReason = undefined;
          // Both sides were just re-established: the holder reauthenticated and the site
          // reasserted the subject it displays. A visibility change re-establishes neither.
          connection.attestations = this.attestations(flow);
        } else if (flow.kind === 'revoke') {
          connection.revokedAt = this.now();
          connection.revocationReason = 'external';
        } else if (flow.kind === 'visibility') {
          connection.visibility = visibility;
          connection.visibilityApprovedAt = this.now();
        }
      }

      await tx.put('connections', connection.id, connection);

      await this.audit(
        tx,
        connection.id,
        flow.kind,
        ['revoke', 'share-revoke'].includes(flow.kind) ? 'external' : 'local',
        id,
        connection.visibility,
      );

      flow.phase = 'complete';
      flow.resultId = connection.id;
      await tx.put('flows', id, flow);

      return connection.id;
    });
  }

  evidence(connection: Connection): Evidence {
    const { id: _privateId, ...local } = connection.local;

    return {
      id: connection.id,
      local,
      external: connection.external,
      provider: connection.provider,
      providerName: this.providerName(connection.provider),
      attestations: connection.attestations ?? {
        // Records written before methods were stored still have a known method: the site
        // declared its subject and the provider ran the redirect flow, the only one built.
        local: { by: 'backend', method: 'declared', confirmedAt: connection.approvedAt },
        external: { by: 'provider', method: 'oauth', confirmedAt: connection.authenticatedAt },
      },
      siteName: this.options.siteName,
      verifierName: this.options.verifierName,
      visibility: connection.visibility,
      status: status(connection, this.now(), this.freshness),
      authenticatedAt: connection.authenticatedAt,
      approvedAt: connection.approvedAt,
      visibilityApprovedAt: connection.visibilityApprovedAt,
      expiresAt: connection.expiresAt,
      revokedAt: connection.revokedAt,
      evidenceUrl: `${this.baseUrl}/connections/${connection.id}`,
    };
  }

  /**
   * A link's two sides are vouched for by different parties. The site is the only authority
   * on its own namespace, so it declares the local subject; the provider establishes the
   * external account by whatever method its implementation uses.
   */
  private attestations(flow: Flow): Attestations {
    const external: Attestation = {
      by: 'provider',
      method: this.options.provider.method ?? 'oauth',
      confirmedAt: flow.authenticatedAt!,
    };

    // Only a published proof has somewhere for a reader to go, and it is kept with what
    // they should find there so the same check can be run again later.
    if (flow.artifactUrl) {
      external.artifactUrl = flow.artifactUrl;
      external.expect = flow.expect;
    }

    return { local: { by: 'backend', method: 'declared', confirmedAt: this.now() }, external };
  }

  /** A record from a provider this instance no longer configures keeps its raw id. */
  private providerName(provider: string): string {
    return this.options.provider.id === provider ? this.options.provider.name : provider;
  }

  async read(id: string, local?: LocalAccount): Promise<Evidence> {
    return this.options.storage.transaction(async (tx) => {
      const connection = await tx.get('connections', id);

      if (!connection || (connection.visibility !== 'public' && connection.local.id !== local?.id))
        throw new Unavailable();

      return this.evidence(connection);
    });
  }

  /**
   * Every connection this site has published. Public evidence is already world-readable
   * one id at a time; listing it lets an embed follow the current connections instead of
   * hardcoding an id that dies whenever one is revoked and replaced. Unlisted records are
   * never included: they must not appear in any directory listing.
   */
  async published(): Promise<Evidence[]> {
    return this.options.storage.transaction(async (tx) =>
      (await tx.list('connections'))
        .filter((c) => c.visibility === 'public')
        .map((c) => this.evidence(c))
        .filter((e) => e.status === 'verified'),
    );
  }

  async mine(local: LocalAccount): Promise<Evidence[]> {
    return this.options.storage.transaction(async (tx) =>
      (await tx.list('connections'))
        .filter((c) => c.local.id === local.id)
        .map((c) => this.evidence(c)),
    );
  }

  private async owned(tx: Transaction, id: string, local: LocalAccount) {
    const connection = await tx.get('connections', id);

    if (!connection || connection.local.id !== local.id) throw new Unavailable();

    return connection;
  }

  async revoke(id: string, local: LocalAccount): Promise<void> {
    await this.options.storage.transaction(async (tx) => {
      const connection = await this.owned(tx, id, local);

      if (connection.revokedAt !== undefined) return;

      connection.revokedAt = this.now();
      connection.revocationReason = 'local';
      await tx.put('connections', id, connection);
      await this.invalidateShare(tx, id);
      await this.audit(tx, id, 'revoke', 'local');
    });
  }

  async share(
    id: string,
    local: LocalAccount,
    revoke = false,
  ): Promise<{ url: string; expiresAt: number } | undefined> {
    const token = secret();

    return this.options.storage.transaction(async (tx) => {
      const connection = await this.owned(tx, id, local);

      if (connection.visibility !== 'unlisted' || connection.revokedAt !== undefined)
        throw new Unavailable();

      await this.invalidateShare(tx, id);

      if (revoke) {
        await this.audit(tx, id, 'share-revoke', 'local');

        return;
      }

      const expiresAt = this.now() + (this.options.shareTtlMs ?? 7 * 86400000);

      await tx.put('shares', id, {
        connectionId: id,
        tokenHash: hash(token),
        createdAt: this.now(),
        expiresAt,
      });

      await this.audit(tx, id, 'share-issue', 'local');

      return { url: `${this.baseUrl}/s/${token}`, expiresAt };
    });
  }

  async shared(token: string) {
    return this.options.storage.transaction(async (tx) => {
      const share = (await tx.list('shares')).find((s) => s.tokenHash === hash(token));

      if (!share || share.revokedAt !== undefined || share.expiresAt <= this.now())
        throw new Unavailable();

      const connection = await tx.get('connections', share.connectionId);

      if (!connection || connection.visibility !== 'unlisted' || connection.revokedAt !== undefined)
        throw new Unavailable();

      return {
        ...this.evidence(connection),
        evidenceUrl: `${this.baseUrl}/s/${token}`,
        linkExpiresAt: share.expiresAt,
      };
    });
  }

  /**
   * Reads published proofs again, because unlike a sign-in they can stop being true with
   * nobody told: the holder deletes the gist and the record here would go on claiming it.
   *
   * A failed read writes nothing. One refusal is not evidence the proof is gone, and a
   * provider being down must not revoke anyone; it is continued silence that ages a
   * connection out through `status`, and a single later success undoes that. Revocation
   * stays what it is, something a party chose.
   *
   * `budget` bounds the reads per run, since providers rate-limit and the alarm this runs
   * on is shared. Oldest first, so nothing starves however many connections are waiting.
   */
  async recheck(budget = 5): Promise<number> {
    const provider = this.options.provider;

    if (!isArtifactProvider(provider) || budget <= 0) return 0;

    const interval = this.options.recheckMs ?? 86400000;
    const now = this.now();

    const due = await this.options.storage.transaction(async (tx) =>
      (await tx.list('connections'))
        .filter(
          (c) =>
            c.revokedAt === undefined &&
            c.expiresAt > now &&
            c.provider === provider.id &&
            c.attestations?.external.artifactUrl &&
            c.attestations.external.expect &&
            c.attestations.external.confirmedAt + interval <= now,
        )
        .sort((a, b) => a.attestations!.external.confirmedAt - b.attestations!.external.confirmedAt)
        .slice(0, budget),
    );

    let confirmed = 0;

    // Serially and outside any transaction: storage here serializes writes, so holding one
    // open across a fetch would stall every other request behind the slowest provider.
    for (const connection of due) {
      const { artifactUrl, expect } = connection.attestations!.external;

      try {
        const external = await this.deadline(
          provider.verify({ artifactUrl: artifactUrl!, expect: expect! }),
        );

        // The proof must still be the same holder's. An account that changed hands has not
        // reproved anything, whatever is published at the old address.
        if (external.id !== connection.external.id) continue;
      } catch {
        continue;
      }

      await this.options.storage.transaction(async (tx) => {
        const current = await tx.get('connections', connection.id);

        // It may have been revoked or reproved while the fetch was in flight.
        if (!current?.attestations || current.revokedAt !== undefined) return;

        if (current.attestations.external.artifactUrl !== artifactUrl) return;

        current.attestations.external.confirmedAt = this.now();
        // For an artifact method this field means last confirmed, not first authenticated.
        current.authenticatedAt = this.now();
        await tx.put('connections', connection.id, current);
      });

      confirmed += 1;
    }

    return confirmed;
  }

  /** A provider that never answers must not hold up the maintenance run behind it. */
  private deadline<T>(work: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;

    return Promise.race([
      work.finally(() => clearTimeout(timer)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Unavailable()), this.options.recheckTimeoutMs ?? 10000);
      }),
    ]);
  }

  /** Run periodically. Pending secrets expire immediately; historical evidence defaults to 90 days. */
  async prune(retentionMs = 90 * 86400000): Promise<void> {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) throw new Error('Invalid retention');

    await this.options.storage.transaction(async (tx) => {
      const now = this.now();

      for (const flow of await tx.list('flows'))
        if (flow.expiresAt <= now) await tx.delete('flows', flow.id);

      for (const connection of await tx.list('connections')) {
        if ((connection.revokedAt ?? connection.expiresAt) + retentionMs <= now) {
          await tx.delete('connections', connection.id);
          await tx.delete('shares', connection.id);
        }
      }

      for (const event of await tx.list('audit'))
        if (event.at + retentionMs <= now) await tx.delete('audit', event.id);
    });
  }

  private async invalidateShare(tx: Transaction, id: string) {
    const share = await tx.get('shares', id);

    if (share) {
      share.revokedAt = this.now();
      await tx.put('shares', id, share);
    }
  }

  private async audit(
    tx: Transaction,
    connectionId: string,
    action: string,
    actor: 'local' | 'external',
    flowId?: string,
    visibility?: Visibility,
  ) {
    const id = secret();

    await tx.put('audit', id, {
      id,
      connectionId,
      flowId,
      action,
      actor,
      at: this.now(),
      visibility,
    });
  }
}
