import { createHash, randomBytes } from 'node:crypto';
import {
  status,
  type Connection,
  type Evidence,
  type Flow,
  type LocalAccount,
  type Provider,
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

    for (const duration of [options.validityMs, options.flowTtlMs, options.shareTtlMs]) {
      if (duration !== undefined && (!Number.isSafeInteger(duration) || duration <= 0))
        throw new Error('Invalid duration');
    }
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

    await this.options.storage.transaction(async (tx) => {
      if (kind !== 'connect') {
        const connection = await tx.get('connections', connectionId!);

        // No account disclosure at entry; only the matching provider account can inspect later.
        if (
          !connection ||
          connection.revokedAt !== undefined ||
          (kind === 'visibility' && connection.local.id !== local?.id)
        )
          throw new Unavailable();
      }

      await tx.put('flows', flow.id, flow);
    });

    return {
      flowId: flow.id,
      binding,
      authorizationUrl: this.options.provider.authorizationUrl({
        state,
        challenge: hash(verifier),
        redirectUri: `${this.baseUrl}/callback`,
      }),
    };
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
      const external = await this.options.provider.authenticate({
        code,
        verifier: claimed.verifier,
        redirectUri: `${this.baseUrl}/callback`,
      });

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
        flow.authenticatedAt = this.now();
        flow.phase = 'approval';
        await tx.put('flows', id, flow);
      });
    } catch {
      await this.options.storage.transaction(async (tx) => {
        const flow = await tx.get('flows', id);

        if (flow?.phase === 'exchanging') {
          flow.phase = 'failed';
          await tx.put('flows', id, flow);
        }
      });
    }

    return id;
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
        await this.invalidateShare(tx, connection.id);

        if (flow.kind === 'revoke') {
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
      siteName: this.options.siteName,
      verifierName: this.options.verifierName,
      visibility: connection.visibility,
      status: status(connection, this.now()),
      authenticatedAt: connection.authenticatedAt,
      approvedAt: connection.approvedAt,
      visibilityApprovedAt: connection.visibilityApprovedAt,
      expiresAt: connection.expiresAt,
      revokedAt: connection.revokedAt,
      evidenceUrl: `${this.baseUrl}/connections/${connection.id}`,
    };
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
