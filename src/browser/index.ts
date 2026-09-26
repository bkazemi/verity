import type { Evidence } from '../core/index.js';
import { badgeShown, renderBadge, renderBadgeMessage, renderBadgePending } from './badge.js';
import { openEvidenceDialog } from './evidence-dialog.js';

export type { Evidence } from '../core/index.js';

export interface Result {
  outcome: 'complete' | 'cancelled' | 'failed';
  connectionId?: string;
}

/**
 * The most recent evidence read for a host, kept whether or not it changed the pill: a
 * renewal moves dates the pill never shows, and the dialog opens on those dates.
 */
const latest = new WeakMap<HTMLElement, Evidence>();

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
    async mountBadge(
      element: HTMLElement,
      { connectionId, evidence }: { connectionId: string; evidence?: Evidence },
    ) {
      // Evidence already in hand renders at once. Otherwise a host with nothing to show
      // gets the waiting pill, whose frame and mark the finished badge keeps; a host that
      // already shows a badge keeps it up until the check answers, so a periodic refresh
      // never blinks the pill through an interim state.
      if (!evidence && !badgeShown(element)) renderBadgePending(element);

      try {
        const e = evidence ?? (await client.getConnection(connectionId));

        if (!validEvidence(e)) throw new Error('Invalid evidence response');

        if (e.visibility !== 'public') throw new Error('Unavailable');

        // Validate both links before rendering any provider details.
        safeUrl(e.external.profileUrl);
        safeUrl(e.evidenceUrl);
        latest.set(element, e);
        const badge = renderBadge(element, e);

        // Nothing changed: the pill on screen, and its handler, still stand.
        if (!badge) return;

        badge.setAttribute('aria-haspopup', 'dialog');

        // Assigned rather than added: the pill is kept across renders, so a listener per
        // render would stack up on the same element.
        badge.onclick = (event: MouseEvent) => {
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

          // The pill was drawn from this record, so the dialog opens on it at full size
          // and the check below either leaves it alone or replaces it.
          const read = latest.get(element) ?? e;

          openEvidenceDialog(
            element,
            async () => {
              const fresh = await client.getConnection(read.id);

              if (fresh.visibility !== 'public') throw new Error('Unavailable');

              safeUrl(fresh.evidenceUrl);
              safeUrl(fresh.external.profileUrl);

              if (fresh.local.profileUrl) safeUrl(fresh.local.profileUrl);

              return fresh;
            },
            readable(read),
          );
        };
      } catch {
        latest.delete(element);
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

/**
 * The record as the dialog would draw it, or nothing if any link in it may not be
 * rendered. The pill checks the two links it shows itself; the dialog shows one more.
 */
function readable(evidence: Evidence): Evidence | undefined {
  try {
    safeUrl(evidence.evidenceUrl);
    safeUrl(evidence.external.profileUrl);

    if (evidence.local.profileUrl) safeUrl(evidence.local.profileUrl);

    return evidence;
  } catch {
    return undefined;
  }
}

function safeUrl(value: string) {
  const url = new URL(value);

  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid URL');

  return url.href;
}

/**
 * Both sides must be described, because a half-filled record would let a renderer imply a
 * method for a side that never reported one.
 */
function validAttestations(value: unknown): boolean {
  if (!record(value)) return false;

  return (
    validAttestation(value.local) &&
    Array.isArray(value.external) &&
    value.external.length > 0 &&
    value.external.every(validAttestation)
  );
}

function validAttestation(attestation: unknown): boolean {
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
    ['id', 'provider', 'providerName', 'siteName', 'verifierName', 'evidenceUrl'].every(
      (k) => typeof value[k] === 'string',
    ) &&
    ['label', 'reference'].every(
      (k) => typeof (value.local as Record<string, unknown>)[k] === 'string',
    ) &&
    ['id', 'handle', 'profileUrl'].every(
      (k) => typeof (value.external as Record<string, unknown>)[k] === 'string',
    ) &&
    (value.local.profileUrl === undefined || typeof value.local.profileUrl === 'string') &&
    validAttestations(value.attestations) &&
    (value.local.kind === undefined || typeof value.local.kind === 'string') &&
    (value.external.kind === undefined ||
      ['account', 'key', 'page'].includes(String(value.external.kind))) &&
    (value.revokedAt === undefined ||
      (typeof value.revokedAt === 'number' && Number.isFinite(value.revokedAt))) &&
    ['verified', 'unconfirmed', 'expired', 'revoked'].includes(String(value.status)) &&
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
      /**
       * Evidence an embed already fetched, handed over before the badge is presented so
       * its first paint is the finished pill rather than a placeholder replaced a round
       * trip later. It seeds one paint only; every later refresh is fetched.
       */
      evidence?: Evidence;

      /**
       * A badge may be placed before its connection is known: it then waits, showing the
       * pill's own frame, until `connection-id` names what it presents.
       */
      static observedAttributes = ['backend-url', 'connection-id'];

      private timer?: ReturnType<typeof setInterval>;
      private queued = false;

      connectedCallback() {
        this.present();
        this.timer = setInterval(() => this.refresh(), 30000);
      }

      disconnectedCallback() {
        clearInterval(this.timer);
      }

      attributeChangedCallback() {
        this.present();
      }

      /**
       * Deferred by a microtask, so an embed that sets the backend, the connection and the
       * evidence one after another is drawn once, from all three, before anything paints.
       */
      private present() {
        if (this.queued) return;

        this.queued = true;

        queueMicrotask(() => {
          this.queued = false;

          if (!this.isConnected) return;

          const seed = this.evidence;

          this.evidence = undefined;
          this.refresh(validEvidence(seed) && seed.visibility === 'public' ? seed : undefined);
        });
      }

      private refresh(evidence?: Evidence) {
        const backendUrl = this.getAttribute('backend-url'),
          connectionId = this.getAttribute('connection-id');

        if (!connectionId) {
          renderBadgePending(this);

          return;
        }

        if (backendUrl) void init({ backendUrl }).mountBadge(this, { connectionId, evidence });
      }
    },
  );
}
