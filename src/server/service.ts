import { createHash, randomBytes } from 'node:crypto';
import {
  fresh,
  freshnessMs,
  isArtifactProvider,
  providerMethod,
  Refused,
  status,
  type ArtifactProvider,
  type Attestation,
  type Attestations,
  type Connection,
  type Evidence,
  type ExternalAccount,
  type Flow,
  type LocalAccount,
  type Method,
  type Provider,
  type Records,
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
  /**
   * The methods this instance offers. Several may share a provider id: `githubProvider()`,
   * `githubGistProvider()` and `githubLinkProvider()` are three ways to show one GitHub
   * account, and a record shown by more than one keeps them all. The first is the default.
   */
  providers: Provider[];
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
  readonly providers: Provider[];

  constructor(readonly options: ServiceOptions) {
    this.now = options.now ?? Date.now;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.providers = options.providers;

    // A flow names its method by provider id and method, so that pair must say which.
    const keys = this.providers.map((p) => `${p.id} ${providerMethod(p)}`);

    if (!keys.length || new Set(keys).size !== keys.length)
      throw new Error('Configure each provider method once');

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

  /**
   * The configured method a caller asked for: a provider id and, where that provider is
   * shown more than one way, which way. Nothing asked for means the first configured.
   */
  resolve(provider?: string, method?: string): Provider {
    const found = this.providers.find(
      (p) =>
        (provider === undefined || p.id === provider) &&
        (method === undefined || providerMethod(p) === method),
    );

    if (!found) throw new Unavailable();

    return found;
  }

  /** The method a flow was started with. A flow from before methods were recorded ran the first. */
  providerOf(flow: Flow): Provider {
    return flow.provider === undefined
      ? this.providers[0]!
      : this.resolve(flow.provider, flow.method);
  }

  async start(
    local?: LocalAccount,
    connectionId?: string,
    kind: Flow['kind'] = 'connect',
    choice: { provider?: string; method?: string } = {},
  ) {
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

    const provider = await this.transaction(async (tx) => {
      // Whose link this is. A flow against an existing connection may carry no local
      // subject of its own, and the record is the authority on it in any case.
      let subject = local;

      let connection: Connection | undefined;

      if (kind !== 'connect') {
        connection = await tx.get('connections', connectionId!);

        // No account disclosure at entry; only the matching provider account can inspect later.
        if (
          !connection ||
          connection.revokedAt !== undefined ||
          (['visibility', 'renew'].includes(kind) && connection.local.id !== local?.id)
        )
          throw new Unavailable();

        subject = connection.local;
      }

      const provider = this.chosen(kind, choice, connection);

      flow.provider = provider.id;
      flow.method = providerMethod(provider);
      const artifact = isArtifactProvider(provider) ? provider : undefined;

      // Unguessable and per-flow, so an artifact published for one flow cannot complete
      // another, and naming the site means the holder can see what they are agreeing to
      // before they publish anything. A method that points back at the subject has no such
      // freedom: the subject's address is the whole claim, so that method states it here
      // and gives up per-flow uniqueness for a standing link that is read again on a
      // schedule instead.
      if (artifact)
        flow.expect = artifact.expect
          ? artifact.expect(subject!)
          : `Verity proof for ${this.options.siteName}: ${secret()}`;

      await tx.put('flows', flow.id, flow);

      return provider;
    });

    const artifact = isArtifactProvider(provider) ? provider : undefined;

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
          authorizationUrl: (provider as RedirectProvider).authorizationUrl({
            state,
            challenge: hash(verifier),
            redirectUri: `${this.baseUrl}/callback`,
          }),
        };
  }

  /**
   * Which method a flow runs. A flow on an existing record stays in that record's
   * namespace, and without a choice it uses the method the record was first shown by.
   *
   * Removing a link from the external side takes a method whose proof is fresh. A standing
   * proof, such as a link back, is there for anyone to point at: handing one back shows
   * the link exists, not that whoever handed it back holds the account.
   */
  private chosen(
    kind: Flow['kind'],
    choice: { provider?: string; method?: string },
    connection?: Connection,
  ): Provider {
    let provider: Provider;

    if (choice.provider === undefined && choice.method === undefined && connection) {
      const main = connection.attestations?.external[0].method ?? 'oauth';

      provider =
        this.providers.find((p) => p.id === connection.provider && providerMethod(p) === main) ??
        this.resolve(connection.provider);
    } else provider = this.resolve(choice.provider, choice.method);

    if (connection && provider.id !== connection.provider) throw new Unavailable();

    if (
      ['revoke', 'share-revoke'].includes(kind) &&
      isArtifactProvider(provider) &&
      provider.expect
    )
      throw new Unavailable();

    return provider;
  }

  /**
   * Accepts what the holder hands back: the address they published the flow's string at,
   * or the proof itself. Both are holder-supplied, so the provider decides what counts.
   */
  async submit(id: string, binding: string, artifact: string): Promise<string> {
    const { provider, expect } = await this.transaction(async (tx) => {
      const flow = await this.bound(tx, id, binding);
      const provider = this.providerOf(flow);

      if (flow.phase !== 'pending' || !flow.expect || !isArtifactProvider(provider))
        throw new Unavailable();

      flow.phase = 'exchanging';
      await tx.put('flows', id, flow);

      return { provider, expect: flow.expect };
    });

    try {
      const external = await provider.verify({ artifact, expect });

      await this.established(id, binding, external, artifact);
    } catch (error) {
      await this.failed(id, error);
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
    return this.transaction((tx) => this.bound(tx, id, binding));
  }

  async callback(state: string, binding: string, code?: string): Promise<string> {
    const id = hash(state);

    const claimed = await this.transaction(async (tx) => {
      const flow = await this.bound(tx, id, binding);

      if (flow.phase !== 'pending' || isArtifactProvider(this.providerOf(flow)))
        throw new Unavailable();

      flow.phase = code ? 'exchanging' : 'cancelled';
      const verifier = flow.verifier!;

      delete flow.verifier;
      await tx.put('flows', id, flow);

      return { provider: this.providerOf(flow) as RedirectProvider, verifier };
    });

    if (!code) return id;

    try {
      const external = await claimed.provider.authenticate({
        code,
        verifier: claimed.verifier,
        redirectUri: `${this.baseUrl}/callback`,
      });

      await this.established(id, binding, external);
    } catch (error) {
      await this.failed(id, error);
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
    artifact?: string,
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

    await this.transaction(async (tx) => {
      const flow = await this.bound(tx, id, binding);

      if (flow.phase !== 'exchanging') throw new Unavailable();

      if (flow.kind !== 'connect') {
        const connection = await tx.get('connections', flow.connectionId!);

        if (
          !connection ||
          connection.provider !== this.providerOf(flow).id ||
          connection.revokedAt !== undefined
        )
          throw new Unavailable();

        if (!matches(flow.kind, connection.external, external))
          throw new Refused('This is a different account from the one this connection links');

        flow.local = connection.local;
      }

      flow.external = external;
      flow.artifact = artifact;
      flow.authenticatedAt = this.now();
      flow.phase = 'approval';
      await tx.put('flows', id, flow);
    });
  }

  /**
   * A failed check leaves the flow dead rather than retryable in place. Only a `Refused`
   * reason is kept: any other error may describe this backend rather than the proof.
   */
  private async failed(id: string, error: unknown) {
    await this.transaction(async (tx) => {
      const flow = await tx.get('flows', id);

      if (flow?.phase === 'exchanging') {
        flow.phase = 'failed';
        flow.reason = error instanceof Refused ? error.message : undefined;
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

    return this.transaction(async (tx) => {
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
      const provider = this.providerOf(flow);
      const joined = flow.kind === 'connect' ? await this.joins(tx, flow) : undefined;

      if (joined) {
        // Another way of showing an account this subject is already linked to. The record
        // keeps its id, its visibility and the method it was first shown by; this one is
        // added beneath it, and like a renewal it extends the record it just reproved.
        connection = joined;
        this.recordMethod(connection, flow, provider);
      } else if (flow.kind === 'connect') {
        // The id exists before the record does, because a hosted proof is addressed by it.
        const connectionId = secret();

        connection = {
          id: connectionId,
          local: flow.local!,
          external: flow.external!,
          provider: provider.id,
          visibility,
          visibilityApprovedAt: this.now(),
          authenticatedAt: flow.authenticatedAt!,
          approvedAt: this.now(),
          expiresAt: this.now() + (this.options.validityMs ?? 30 * 86400000),
          attestations: {
            local: this.declared(),
            external: [this.attestation(flow, provider, connectionId)],
          },
          proof: hosted(provider) ? flow.artifact : undefined,
        };
      } else {
        const existing = await tx.get('connections', flow.connectionId!);

        if (
          !existing ||
          existing.revokedAt !== undefined ||
          !matches(flow.kind, existing.external, flow.external!)
        )
          throw new Unavailable();

        connection = existing;

        if (flow.kind !== 'renew') await this.invalidateShare(tx, connection.id);

        if (flow.kind === 'renew') {
          // Re-approval of the same pair extends the record rather than minting a new
          // id, so embeds and evidence urls published earlier keep resolving. The
          // subject snapshot refreshes because the holder just approved what it shows.
          if (flow.local!.id !== existing.local.id) throw new Unavailable();

          this.recordMethod(connection, flow, provider);
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

  /** Every read of a connection goes through here, so a record in an older shape is upgraded. */
  private transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.options.storage.transaction((tx) => work(upgraded(tx)));
  }

  /**
   * The methods a reader is shown. An additional method whose proof has gone unread no
   * longer shows anything, so it is left out until it reads again; the main one is
   * never left out, because the record's status already says what became of it.
   */
  private shown(connection: Connection): Attestations {
    if (!connection.attestations)
      // Records written before methods were stored still have a known method: the site
      // declared its subject and the provider ran the redirect flow, the only one built.
      return {
        local: { by: 'backend', method: 'declared', confirmedAt: connection.approvedAt },
        external: [{ by: 'provider', method: 'oauth', confirmedAt: connection.authenticatedAt }],
      };

    const [main, ...rest] = connection.attestations.external;

    return {
      ...connection.attestations,
      external: [main, ...rest.filter((a) => fresh(a, this.now(), this.freshness))],
    };
  }

  evidence(connection: Connection): Evidence {
    const { id: _privateId, ...local } = connection.local;

    return {
      id: connection.id,
      local,
      external: connection.external,
      provider: connection.provider,
      providerName: this.providerName(connection.provider),
      attestations: this.shown(connection),
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
   * The live record a connect flow reproves by another method, if there is one: the same
   * subject linked to the same account on the same provider, first shown some other way.
   * The same method again is a second record, as it always was; renewing is how that
   * one is extended.
   */
  private async joins(tx: Transaction, flow: Flow): Promise<Connection | undefined> {
    const provider = this.providerOf(flow);

    return (await tx.list('connections'))
      .filter(
        (c) =>
          c.revokedAt === undefined &&
          c.local.id === flow.local!.id &&
          c.provider === provider.id &&
          (c.attestations?.external[0].method ?? 'oauth') !== providerMethod(provider) &&
          sameAccount(c.external, flow.external!) &&
          // A record first shown by a proof naming the subject's old address is a record
          // of that address. Joining it would show its proof beside the new one.
          (!c.attestations || this.names(c, c.attestations.external[0], flow.local!)),
      )
      .sort((a, b) => b.approvedAt - a.approvedAt)[0];
  }

  /**
   * The record a connect flow awaiting approval would add its method to, so the approval
   * page can say so: the holder is not creating a link but reproving one, and the
   * visibility already chosen for it stands.
   */
  async joining(flow: Flow): Promise<Connection | undefined> {
    if (flow.kind !== 'connect' || flow.phase !== 'approval') return undefined;

    return this.transaction((tx) => this.joins(tx, flow));
  }

  /**
   * Records that a flow just showed the record's account again. Shown by the method the
   * record was first shown by, it replaces that one; shown another way, it takes that
   * method's place after it, or joins the end. Either way the holder approved it and the
   * site reasserted its subject, so the record is extended and its subject refreshed.
   */
  private recordMethod(connection: Connection, flow: Flow, provider: Provider) {
    const attestation = this.attestation(flow, provider, connection.id);

    const [main, ...rest] = connection.attestations?.external ?? [
      { by: 'provider', method: 'oauth', confirmedAt: connection.authenticatedAt },
    ];

    connection.local = flow.local!;
    connection.approvedAt = this.now();
    connection.expiresAt = this.now() + (this.options.validityMs ?? 30 * 86400000);
    connection.revocationReason = undefined;

    if (attestation.method === main.method) {
      connection.authenticatedAt = flow.authenticatedAt!;

      // The account is taken as this method just named it. A recheck asks the same method
      // about the new proof and compares ids exactly, and an address read with different
      // case names the same profile under a different id.
      connection.external = flow.external!;

      connection.attestations = { local: this.declared(), external: [attestation, ...rest] };
    } else {
      // A proof that named the subject's old address proves nothing about its new one,
      // and rereading it would go on confirming a link to where the subject used to be.
      const others = rest.filter((a) => this.names(connection, a, flow.local!));
      const at = others.findIndex((a) => a.method === attestation.method);

      // A method already listed keeps its place: the order is the order each was first used.
      if (at < 0) others.push(attestation);
      else others[at] = attestation;

      connection.attestations = { local: this.declared(), external: [main, ...others] };
    }

    if (hosted(provider)) connection.proof = flow.artifact;
  }

  /**
   * Whether a proof still names the subject as it is now. A method that has the holder
   * publish something derived from the subject, as a link back publishes its address,
   * proved the subject as it was then; one whose proof is a token minted per flow names no
   * subject, and holds whatever the subject's address becomes.
   */
  private names(connection: Connection, attestation: Attestation, local: LocalAccount): boolean {
    const provider = this.providers.find(
      (p) => p.id === connection.provider && providerMethod(p) === attestation.method,
    );

    if (attestation.expect === undefined || !provider || !isArtifactProvider(provider)) return true;

    if (!provider.expect) return true;

    try {
      return provider.expect(local) === attestation.expect;
    } catch {
      return false;
    }
  }

  /** The site is the only authority on its own namespace, so it declares the local subject. */
  private declared(): Attestation {
    return { by: 'backend', method: 'declared', confirmedAt: this.now() };
  }

  /** How the provider established the external account, by whatever method the flow ran. */
  private attestation(flow: Flow, provider: Provider, connectionId: string): Attestation {
    const external: Attestation = {
      by: 'provider',
      method: providerMethod(provider),
      confirmedAt: flow.authenticatedAt!,
    };

    // Only a published proof has somewhere for a reader to go, and it is kept with what
    // they should find there so the same check can be run again later. Where that is
    // depends on who holds it: an address the holder published, or this backend's own
    // copy when the proof is a document that stands up wherever it is read.
    if (flow.artifact && isArtifactProvider(provider)) {
      const hosted = provider.artifact === 'document';

      external.artifactUrl = hosted
        ? `${this.baseUrl}/connections/${connectionId}/proof`
        : flow.artifact;

      external.expect = flow.expect;

      if (hosted) external.hosted = true;
    }

    return external;
  }

  /**
   * The proof itself, for a method whose artifact this backend publishes. It is as public
   * as the evidence it belongs to and no more: an unlisted record's proof is the holder's
   * to hand out, exactly like the evidence page it is linked from.
   */
  async proof(id: string, local?: LocalAccount): Promise<string> {
    return this.transaction(async (tx) => {
      const connection = await tx.get('connections', id);

      if (
        !connection?.proof ||
        (connection.visibility !== 'public' && connection.local.id !== local?.id)
      )
        throw new Unavailable();

      return connection.proof;
    });
  }

  /** A record from a provider this instance no longer configures keeps its raw id. */
  private providerName(provider: string): string {
    return this.providers.find((p) => p.id === provider)?.name ?? provider;
  }

  async read(id: string, local?: LocalAccount): Promise<Evidence> {
    return this.transaction(async (tx) => {
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
    return this.transaction(async (tx) =>
      (await tx.list('connections'))
        .filter((c) => c.visibility === 'public')
        .map((c) => this.evidence(c))
        .filter((e) => e.status === 'verified'),
    );
  }

  async mine(local: LocalAccount): Promise<Evidence[]> {
    return this.transaction(async (tx) =>
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
    await this.transaction(async (tx) => {
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

    return this.transaction(async (tx) => {
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
    return this.transaction(async (tx) => {
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
   * Asks again about proofs, because unlike a sign-in they can stop being true with nobody
   * told. What that means depends on who holds the proof:
   *
   * A proof published elsewhere is reread. The holder deletes the gist and this record
   * would otherwise go on claiming it, so continued silence ages the connection out.
   *
   * A proof this backend hosts cannot go missing, so there is nothing to reread. What can
   * still change is the identity behind it, and a method that has somewhere to say so is
   * asked. A holder who publishes a revocation for their key has withdrawn it, which is a
   * revocation of the connection rather than a proof gone stale.
   *
   * A failed read writes nothing. One refusal is not evidence the proof is gone, and a
   * provider being down must not revoke anyone; it is continued silence that ages a
   * connection out through `status`, and a single later success undoes that. Revocation
   * stays what it is, something a party chose.
   *
   * `budget` bounds the reads per run, since providers rate-limit and the alarm this runs
   * on is shared. Oldest first, so nothing starves however many connections are waiting.
   *
   * Returns how many were confirmed. A connection revoked here is not one of them.
   */
  async recheck(budget = 5): Promise<number> {
    if (budget <= 0) return 0;

    const interval = this.options.recheckMs ?? 86400000;
    const now = this.now();

    const due = await this.transaction(async (tx) =>
      (await tx.list('connections'))
        .filter((c) => c.revokedAt === undefined && c.expiresAt > now && c.attestations)
        .flatMap((connection) =>
          connection
            .attestations!.external.map((attestation) => ({
              connection,
              attestation,
              provider: this.rereads(connection, attestation),
            }))
            .filter(
              (item): item is Due =>
                item.provider !== undefined && item.attestation.confirmedAt + interval <= now,
            ),
        )
        .sort((a, b) => a.attestation.confirmedAt - b.attestation.confirmedAt)
        .slice(0, budget),
    );

    let confirmed = 0;

    // Serially and outside any transaction: storage here serializes writes, so holding one
    // open across a fetch would stall every other request behind the slowest provider.
    for (const item of due) confirmed += await this.reread(item);

    return confirmed;
  }

  /**
   * The configured method that can ask again about one attestation, or nothing when there
   * is nothing to ask: no published proof, a method this instance no longer runs, or a
   * hosted proof whose method has nowhere to hear of a withdrawal.
   */
  private rereads(connection: Connection, attestation: Attestation): ArtifactProvider | undefined {
    if (!attestation.artifactUrl || !attestation.expect) return undefined;

    const provider = this.providers.find(
      (p) => p.id === connection.provider && providerMethod(p) === attestation.method,
    );

    if (!provider || !isArtifactProvider(provider)) return undefined;

    if (provider.artifact === 'location') return attestation.hosted ? undefined : provider;

    return provider.withdrawn && connection.proof ? provider : undefined;
  }

  /** Asks about one proof and records the answer. Returns 1 when it confirmed. */
  private async reread({ connection, attestation, provider }: Due): Promise<number> {
    const { artifactUrl, expect, method } = attestation;
    const main = attestation === connection.attestations!.external[0];
    let withdrawn = false;

    try {
      if (provider.artifact === 'document')
        withdrawn = await this.deadline(
          provider.withdrawn!(connection.external, connection.proof!),
        );
      else {
        const external = await this.deadline(
          provider.verify({ artifact: artifactUrl!, expect: expect! }),
        );

        // The proof must still be the same holder's. An account that changed hands has
        // not reproved anything, whatever is published at the old address.
        if (
          main
            ? external.id !== connection.external.id
            : !sameAccount(connection.external, external)
        )
          return 0;
      }
    } catch {
      return 0;
    }

    return this.transaction(async (tx) => {
      const current = await tx.get('connections', connection.id);

      // It may have been revoked or reproved while the fetch was in flight.
      if (!current?.attestations || current.revokedAt !== undefined) return 0;

      const [first, ...rest] = current.attestations.external;
      const held = main ? first : rest.find((a) => a.method === method);

      if (held?.method !== method || held.artifactUrl !== artifactUrl) return 0;

      // The holder said this identity is no longer theirs, which is a choice, not decay.
      if (withdrawn) {
        current.revokedAt = this.now();
        current.revocationReason = 'withdrawn';
        await tx.put('connections', connection.id, current);
        await this.invalidateShare(tx, connection.id);
        await this.audit(tx, connection.id, 'revoke', 'external');

        return 0;
      }

      held.confirmedAt = this.now();

      await tx.put('connections', connection.id, current);

      return 1;
    });
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

    await this.transaction(async (tx) => {
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

/** One proof waiting to be read again, and the method that reads it. */
interface Due {
  connection: Connection;
  attestation: Attestation;
  provider: ArtifactProvider;
}

/**
 * Whether two methods named the same account. Where both carry an id their provider
 * issued, that id settles it. A method that learns only an address, as a link back does,
 * names the account by its profile, so against one of those the profiles are compared:
 * the account behind the number GitHub issued is the one at that address for as long as
 * the address is theirs. Only accounts compare this way; a page or a key is named by
 * nothing but itself.
 */
function sameAccount(a: ExternalAccount, b: ExternalAccount): boolean {
  if (a.id === b.id) return true;

  if (![a.kind, b.kind].every((kind) => kind === undefined || kind === 'account')) return false;

  if (a.id !== a.profileUrl && b.id !== b.profileUrl) return false;

  return profile(a.profileUrl) === profile(b.profileUrl);
}

/**
 * Wraps a transaction so records read through it are in the current shape. They are
 * rewritten in that shape the next time they are put.
 */
function upgraded(tx: Transaction): Transaction {
  return {
    get: async (kind, id) => upgrade(kind, await tx.get(kind, id)),
    put: (kind, id, value) => tx.put(kind, id, value),
    delete: (kind, id) => tx.delete(kind, id),
    list: async (kind) => (await tx.list(kind)).map((value) => upgrade(kind, value)!),
  };
}

/** Methods stored under an earlier name. */
const renamed: Record<string, Method> = { attestation: 'gist' };

type Stored = Attestation & { method: string };

/**
 * Brings one stored record up to date. Connections written before `external` became a
 * list held the main method there alone and the rest under `further`, and connections
 * and flows may name a method by an earlier name.
 */
function upgrade<K extends keyof Records>(kind: K, value: Records[K] | undefined) {
  if (!value) return value;

  const method = (stored: Stored): Attestation => ({
    ...stored,
    method: renamed[stored.method] ?? (stored.method as Method),
  });

  if (kind === 'flows') {
    const flow = value as Flow;

    return (
      flow.method && renamed[flow.method] ? { ...flow, method: renamed[flow.method] } : flow
    ) as Records[K];
  }

  if (kind !== 'connections') return value;

  const attestations = (value as Connection).attestations as
    { local: Stored; external: Stored | Stored[]; further?: Stored[] } | undefined;

  if (!attestations) return value;

  const external = Array.isArray(attestations.external)
    ? attestations.external
    : [attestations.external, ...(attestations.further ?? [])];

  return {
    ...value,
    attestations: {
      local: method(attestations.local),
      external: external.map(method),
    },
  } as Records[K];
}

/**
 * Whether a flow of this kind showed the record's account. Removal from the external side
 * is started and approved by nobody local, so it takes the provider-issued id alone: a
 * profile address can change hands, and its next owner must not be able to remove the
 * last one's record. The weaker match is only for flows the local holder approves.
 */
function matches(kind: Flow['kind'], held: ExternalAccount, shown: ExternalAccount): boolean {
  if (kind === 'revoke' || kind === 'share-revoke') return held.id === shown.id;

  return sameAccount(held, shown);
}

/** A profile address as it compares. Handles are compared without case, as providers issue them. */
function profile(url: string): string {
  return url.replace(/\/+$/, '').toLowerCase();
}

/** Whether a method hands over a proof for this backend to publish. */
function hosted(provider: Provider): boolean {
  return isArtifactProvider(provider) && provider.artifact === 'document';
}
