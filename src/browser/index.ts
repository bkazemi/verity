import type { Evidence } from '../core/index.js';
import { renderBadge, renderBadgeMessage } from './badge.js';
import { openEvidenceDialog } from './evidence-dialog.js';

export type { Evidence } from '../core/index.js';

export interface Result {
  outcome: 'complete' | 'cancelled' | 'failed';
  connectionId?: string;
}

export function init({ backendUrl }: { backendUrl: string }) {
  const base = new URL(backendUrl, location.href);

  if (!['https:', 'http:'].includes(base.protocol)) throw new Error('Invalid backend URL');

  base.pathname = base.pathname.replace(/\/$/, '');

  async function request(path: string, data?: Record<string, string>): Promise<unknown> {
    const response = await fetch(`${base.href}${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...(data
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          }
        : {}),
    });

    if (!response.ok) throw new Error('Verity request unavailable');

    return response.json();
  }

  const client = {
    async connect({ provider }: { provider: string }): Promise<Result> {
      if (base.origin !== location.origin)
        throw new Error('Management requires a same-origin backend');

      const popup = window.open('about:blank', '_blank', 'popup,width=600,height=750');

      if (!popup) throw new Error('Allow popups to verify');

      try {
        const data = await request('/connect', { provider });

        if (
          !record(data) ||
          typeof data.url !== 'string' ||
          new URL(data.url).origin !== base.origin
        )
          throw new Error('Invalid flow URL');

        return await new Promise<Result>((resolve) => {
          const finish = (result: Result) => {
            clearInterval(timer);
            clearTimeout(timeout);
            window.removeEventListener('message', receive);
            popup.close();
            resolve(result);
          };

          const receive = (event: MessageEvent) => {
            if (
              event.origin !== base.origin ||
              event.source !== popup ||
              !record(event.data) ||
              event.data.type !== 'verity-result'
            )
              return;

            const value = event.data;

            if (value.outcome === 'complete' && typeof value.connectionId === 'string')
              finish({ outcome: 'complete', connectionId: value.connectionId });
            else finish({ outcome: value.outcome === 'cancelled' ? 'cancelled' : 'failed' });
          };

          const timer = setInterval(() => {
            if (popup.closed) finish({ outcome: 'cancelled' });
          }, 500);

          const timeout = setTimeout(() => finish({ outcome: 'failed' }), 11 * 60000);

          window.addEventListener('message', receive);
          popup.location.href = data.url as string;
        });
      } catch (error) {
        popup.close();

        throw error;
      }
    },
    /** The site's current public connections, so an embed need not hardcode ids. */
    async listPublished(): Promise<Evidence[]> {
      const data = await request('/published');

      if (!Array.isArray(data) || !data.every(validEvidence))
        throw new Error('Invalid evidence response');

      return data;
    },
    async getConnection(id: string): Promise<Evidence> {
      const data = await request(`/connections/${encodeURIComponent(id)}?format=json`);

      if (!validEvidence(data)) throw new Error('Invalid evidence response');

      return data;
    },
    async mountBadge(element: HTMLElement, { connectionId }: { connectionId: string }) {
      renderBadgeMessage(element, 'Checking…');

      try {
        const e = await client.getConnection(connectionId);

        if (e.visibility !== 'public') throw new Error('Unavailable');

        // Validate both links before rendering any provider details.
        safeUrl(e.external.profileUrl);
        safeUrl(e.evidenceUrl);
        const badge = renderBadge(element, e);

        badge.setAttribute('aria-haspopup', 'dialog');

        badge.addEventListener('click', (event) => {
          if (
            event.button !== 0 ||
            event.ctrlKey ||
            event.metaKey ||
            event.shiftKey ||
            event.altKey ||
            typeof HTMLDialogElement === 'undefined'
          )
            return;

          event.preventDefault();

          openEvidenceDialog(element, async () => {
            const fresh = await client.getConnection(e.id);

            if (fresh.visibility !== 'public') throw new Error('Unavailable');

            safeUrl(fresh.evidenceUrl);
            safeUrl(fresh.external.profileUrl);

            if (fresh.local.profileUrl) safeUrl(fresh.local.profileUrl);

            return fresh;
          });
        });
      } catch {
        renderBadgeMessage(element, 'Unavailable');
      }
    },
    disconnect: (id: string) => request(`/connections/${encodeURIComponent(id)}/disconnect`, {}),
    issueShare: (id: string) => request(`/connections/${encodeURIComponent(id)}/share`, {}),
    revokeShare: (id: string) => request(`/connections/${encodeURIComponent(id)}/share-revoke`, {}),
  };

  return client;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function safeUrl(value: string) {
  const url = new URL(value);

  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid URL');

  return url.href;
}

/**
 * Absent means an older backend, which is allowed. Present means both sides must be
 * described, because a half-filled record would let a renderer imply a method for a side
 * that never reported one.
 */
function validAttestations(value: unknown): boolean {
  if (value === undefined) return true;

  if (!record(value)) return false;

  return ['local', 'external'].every((side) => {
    const attestation = value[side];

    if (!record(attestation)) return false;

    return (
      ['backend', 'provider'].includes(String(attestation.by)) &&
      typeof attestation.method === 'string' &&
      typeof attestation.confirmedAt === 'number' &&
      Number.isFinite(attestation.confirmedAt) &&
      (attestation.expect === undefined || typeof attestation.expect === 'string') &&
      // Rendered as a link later, so only http(s) may ever reach an href.
      (attestation.artifactUrl === undefined || httpUrl(attestation.artifactUrl))
    );
  });
}

function httpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;

  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function validEvidence(value: unknown): value is Evidence {
  if (!record(value) || !record(value.local) || !record(value.external)) return false;

  return (
    ['id', 'provider', 'siteName', 'verifierName', 'evidenceUrl'].every(
      (k) => typeof value[k] === 'string',
    ) &&
    ['label', 'reference'].every(
      (k) => typeof (value.local as Record<string, unknown>)[k] === 'string',
    ) &&
    ['id', 'handle', 'profileUrl'].every(
      (k) => typeof (value.external as Record<string, unknown>)[k] === 'string',
    ) &&
    (value.local.profileUrl === undefined || typeof value.local.profileUrl === 'string') &&
    (value.providerName === undefined || typeof value.providerName === 'string') &&
    validAttestations(value.attestations) &&
    (value.local.kind === undefined || typeof value.local.kind === 'string') &&
    (value.external.kind === undefined ||
      ['account', 'key'].includes(String(value.external.kind))) &&
    (value.revokedAt === undefined ||
      (typeof value.revokedAt === 'number' && Number.isFinite(value.revokedAt))) &&
    ['verified', 'expired', 'revoked'].includes(String(value.status)) &&
    ['public', 'unlisted'].includes(String(value.visibility)) &&
    ['authenticatedAt', 'approvedAt', 'expiresAt'].every(
      (k) => typeof value[k] === 'number' && Number.isFinite(value[k]),
    )
  );
}

if (typeof customElements !== 'undefined' && !customElements.get('verity-badge')) {
  customElements.define(
    'verity-badge',
    class extends HTMLElement {
      private timer?: ReturnType<typeof setInterval>;

      connectedCallback() {
        this.refresh();
        this.timer = setInterval(() => this.refresh(), 30000);
      }

      disconnectedCallback() {
        clearInterval(this.timer);
      }

      private refresh() {
        const backendUrl = this.getAttribute('backend-url'),
          connectionId = this.getAttribute('connection-id');

        if (backendUrl && connectionId)
          void init({ backendUrl }).mountBadge(this, { connectionId });
      }
    },
  );
}
