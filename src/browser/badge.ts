import type { Evidence } from '../core/index.js';
import { verificationMark } from './mark.js';
import { providerMark } from './provider-mark.js';

const styles = `
  :host { display: inline-block; max-width: 100%; vertical-align: middle; }
  * { box-sizing: border-box; }
  .badge {
    display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 3px 5px;
    border: 1px solid var(--verity-border, #dce2e0); border-radius: 6px;
    background: var(--verity-surface, #fff); color: var(--verity-text, #202c29);
    font: var(--verity-font-size, 13px)/1.35
      var(--verity-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
    text-decoration: none;
  }
  a:hover { background: var(--verity-hover, #f3f6f4); border-color: var(--verity-border, #dce2e0); }
  .badge:focus-visible { outline: 2px solid #357ce5; outline-offset: 2px; }
  .name { font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
  .label { display: none; font-size: 11px; color: var(--verity-muted, #65726c); }
  .badge:hover .label, .badge:focus-within .label { display: inline; }
  .icon { display: grid; place-items: center; flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%; font-size: 12px; font-weight: 750; }
  .mark { display: block; flex-shrink: 0; width: 20px; height: 20px; }
  .divider { flex-shrink: 0; width: 1px; height: 12px; background: var(--verity-border, #dce2e0); }
  .provider { display: block; flex-shrink: 0; width: 14px; height: 14px; }
  .expired .icon { color: #815a12; background: #fbefce; }
  .revoked .icon, .message .icon { color: #626d69; background: #edf0ee; }
  .message { color: var(--verity-muted, #65726c); }
  @media (prefers-reduced-motion: no-preference) { a { transition: background .12s, border-color .12s; } }
`;

function frame(element: HTMLElement, state: string): HTMLElement {
  const host = document.createElement('span');
  const root = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();

  sheet.replaceSync(styles);
  root.adoptedStyleSheets = [sheet];
  const badge = document.createElement(state === 'message' ? 'span' : 'a');

  badge.className = `badge ${state}`;
  root.append(badge);
  element.replaceChildren(host);

  return badge;
}

function span(className: string, text: string): HTMLSpanElement {
  const element = document.createElement('span');

  element.className = className;
  element.textContent = text;

  return element;
}

export function renderBadgeMessage(element: HTMLElement, message: string): void {
  const badge = frame(element, 'message');

  badge.setAttribute('tabindex', '0');
  badge.setAttribute('role', 'status');
  badge.setAttribute('aria-label', message);
  const icon = span('icon', '–');

  icon.setAttribute('aria-hidden', 'true');
  const divider = span('divider', '');

  divider.setAttribute('aria-hidden', 'true');
  badge.append(verificationMark(true), divider, span('label', message), icon);
}

export function renderBadge(element: HTMLElement, evidence: Evidence): HTMLAnchorElement {
  const provider = evidence.providerName ?? evidence.provider;
  const current = evidence.status === 'verified' && evidence.expiresAt > Date.now();
  const state = current ? 'verified' : evidence.status === 'revoked' ? 'revoked' : 'expired';

  const label = {
    verified: 'Verified',
    expired: 'Expired',
    revoked: 'Revoked',
  }[state];

  const handle = `@${evidence.external.handle.replace(/^@/, '')}`;
  const badge = frame(element, state) as HTMLAnchorElement;
  const mark = verificationMark(!current);

  badge.href = evidence.evidenceUrl;
  badge.rel = 'noreferrer';

  badge.setAttribute(
    'aria-label',
    `${provider} ${handle}: ${label} | via: ${evidence.verifierName} | inspect verification`,
  );

  // The provider and handle are already visible in the pill itself.
  badge.title = `${label} | via: ${evidence.verifierName} | Inspect verification for ${evidence.local.label}`;
  const divider = span('divider', '');

  divider.setAttribute('aria-hidden', 'true');
  badge.append(mark, divider, providerMark(evidence.provider, provider), span('name', handle));

  if (!current) {
    const icon = span('icon', state === 'expired' ? '◷' : '–');

    icon.setAttribute('aria-hidden', 'true');
    badge.append(span('label', label), icon);
  }

  return badge;
}
