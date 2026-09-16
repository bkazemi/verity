import { timingSafeEqual } from 'node:crypto';
import type { DurableObjectStorage } from '@cloudflare/workers-types';
import { hash, secret } from '../src/server/service.js';

const sessionMs = 8 * 3600000;
// Use a normal host-only cookie name. Secure, HttpOnly, SameSite and Path=/
// provide the relevant protections while avoiding __Host-prefix rejection by
// browsers or privacy extensions on workers.dev.
const cookieName = 'verity_owner';

interface Session {
  expiresAt: number;
  keyHash: string;
}

export class OwnerAuth {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly ownerKey: string,
  ) {
    if (!/^[A-Za-z0-9_-]{43,}$/.test(ownerKey))
      throw new Error(
        'OWNER_KEY must be a randomly generated base64url secret of at least 32 bytes',
      );
  }

  private token(request: Request) {
    return request.headers
      .get('cookie')
      ?.split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
  }

  async authenticated(request: Request): Promise<boolean> {
    const token = this.token(request);

    if (!token) return false;

    const session = await this.storage.get<Session>(`owner/session/${hash(token)}`);

    return !!session && session.expiresAt > Date.now() && session.keyHash === hash(this.ownerKey);
  }

  async login(key: string): Promise<string | undefined> {
    if (!timingSafeEqual(Buffer.from(hash(key)), Buffer.from(hash(this.ownerKey)))) return;

    const token = secret();

    await this.storage.delete('owner/rate/v2/login');

    await this.storage.put<Session>(`owner/session/${hash(token)}`, {
      expiresAt: Date.now() + sessionMs,
      keyHash: hash(this.ownerKey),
    });

    return `${cookieName}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${sessionMs / 1000}`;
  }

  async logout(request: Request): Promise<string> {
    const token = this.token(request);

    if (token) await this.storage.delete(`owner/session/${hash(token)}`);

    return `${cookieName}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
  }

  async allow(bucket: 'login' | 'mutation', limit: number, windowMs: number): Promise<boolean> {
    return this.storage.transaction(async (tx) => {
      const key = `owner/rate/v2/${bucket}`;
      const previous = await tx.get<{ count: number; until: number }>(key);

      const next =
        previous && previous.until > Date.now()
          ? previous
          : { count: 0, until: Date.now() + windowMs };

      if (next.count >= limit) return false;

      next.count++;
      await tx.put(key, next);

      return true;
    });
  }

  async prune(): Promise<void> {
    await this.storage.transaction(async (tx) => {
      for (const [key, session] of await tx.list<Session>({ prefix: 'owner/session/' })) {
        if (session.expiresAt <= Date.now() || session.keyHash !== hash(this.ownerKey))
          await tx.delete(key);
      }
    });
  }
}
