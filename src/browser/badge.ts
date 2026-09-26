import { externalName, statusLabel, type Evidence } from '../core/index.js';
import { paintMark, verificationMark } from './mark.js';
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
  a[href]:hover { background: var(--verity-hover, #f3f6f4); border-color: var(--verity-border, #dce2e0); }
  .badge:focus-visible { outline: 2px solid #357ce5; outline-offset: 2px; }
  .name { font-weight: 600; overflow-wrap: anywhere; min-width: 0; }
  .label { display: none; font-size: 11px; color: var(--verity-muted, #65726c); }
  .badge:hover .label, .badge:focus-within .label { display: inline; }
  .icon { display: grid; place-items: center; flex-shrink: 0; width: 20px; height: 20px; border-radius: 50%; font-size: 12px; font-weight: 750; }
  .mark { display: block; flex-shrink: 0; width: 20px; height: 20px; }
  .mark.pending { opacity: .45; }
  /* A dim ring where the account will go; it only spins where motion is welcome. */
  .spinner {
    flex-shrink: 0; width: 14px; height: 14px; border-radius: 50%;
    border: 2px solid currentColor; opacity: .3;
  }
  .divider { flex-shrink: 0; width: 1px; height: 12px; background: var(--verity-border, #dce2e0); }
  .provider { display: block; flex-shrink: 0; width: 14px; height: 14px; }
  .expired .icon { color: #815a12; background: #fbefce; }
  .revoked .icon, .message .icon { color: #626d69; background: #edf0ee; }
  .message { color: var(--verity-muted, #65726c); }
  @media (prefers-reduced-motion: no-preference) {
    a { transition: background .12s, border-color .12s; }
    /* The mark is drawn before the answer arrives, so it resolves rather than swaps. */
    .mark, .mark path { transition: opacity .18s ease, stroke .18s ease; }
    .spinner { border-top-color: transparent; opacity: .4; animation: verity-spin .7s linear infinite; }
  }
  @keyframes verity-spin { to { transform: rotate(360deg); } }
`;

/** Built once: a re-render adopts the same sheet rather than reparsing the CSS. */
let sheet: CSSStyleSheet | undefined;

interface Frame {
  host: HTMLElement;
  root: ShadowRoot;
  pill?: HTMLElement;
  mark?: SVGSVGElement;
}

/** The shadow host already built inside an element, kept so refreshes reuse it. */
const frames = new WeakMap<HTMLElement, Frame>();

/** Marks the waiting pill, which shows no message of its own. */
const pendingKey = '\u0000pending';

/** What each host currently shows, so an unchanged refresh can leave it alone. */
const shown = new WeakMap<HTMLElement, string>();
const messages = new WeakMap<HTMLElement, string>();

function badgeSheet(): CSSStyleSheet {
  if (!sheet) {
    sheet = new CSSStyleSheet();
    sheet.replaceSync(styles);
  }

  return sheet;
}

/**
 * The pill to draw into, emptied and ready. Everything that survives a state change is
 * kept: the shadow root and its styles, the pill box itself, and the mark inside it. A
 * badge that was pending and is now verified therefore resolves in place, rather than
 * being torn down and built again where the reader can see it happen.
 */
function frame(element: HTMLElement, state: string): { pill: HTMLElement; mark: SVGSVGElement } {
  let frame = frames.get(element);

  shown.delete(element);
  messages.delete(element);

  if (frame?.host.parentNode !== element) {
    const host = document.createElement('span');
    const root = host.attachShadow({ mode: 'open' });

    root.adoptedStyleSheets = [badgeSheet()];
    frame = { host, root };
    frames.set(element, frame);
    element.replaceChildren(host);
  }

  const tag = state === 'message' ? 'span' : 'a';

  if (!frame.pill || frame.pill.tagName.toLowerCase() !== tag) {
    frame.pill = document.createElement(tag);
    frame.mark = undefined;
    frame.root.replaceChildren(frame.pill);
  }

  for (const attribute of [
    'href',
    'rel',
    'title',
    'tabindex',
    'role',
    'aria-label',
    'aria-haspopup',
  ])
    frame.pill.removeAttribute(attribute);

  frame.pill.onclick = null;
  frame.pill.className = `badge ${state}`;
  frame.mark ??= verificationMark('pending');

  // The mark stays where it is, as the pill's first child: a node taken out and put back
  // is styled afresh, and its colours would jump rather than resolve. Callers append what
  // follows it.
  if (frame.mark.parentNode !== frame.pill) frame.pill.replaceChildren(frame.mark);
  else while (frame.mark.nextSibling) frame.mark.nextSibling.remove();

  return { pill: frame.pill, mark: frame.mark };
}

/**
 * Whether what this host was last given is still in it. A page that empties the host
 * itself gets a badge drawn again rather than one skipped as already shown.
 */
function intact(element: HTMLElement): boolean {
  const frame = frames.get(element);

  return frame?.host.parentNode === element && frame.pill?.parentNode === frame.root;
}

/** Whether a host is currently presenting a badge of its own. */
export function badgeShown(element: HTMLElement): boolean {
  return intact(element) && shown.has(element);
}

/** Everything the pill draws: equal keys mean an identical pill. */
function renderKey(evidence: Evidence, current: boolean, label: string): string {
  return JSON.stringify([
    evidence.provider,
    evidence.providerName,
    externalName(evidence.external),
    evidence.evidenceUrl,
    evidence.verifierName,
    evidence.local.label,
    evidence.status,
    current,
    label,
  ]);
}

function span(className: string, text: string): HTMLSpanElement {
  const element = document.createElement('span');

  element.className = className;
  element.textContent = text;

  return element;
}

/**
 * The pill before there is anything to say in it: its own frame and mark, drawn in the
 * page's text colour because no verification has been read yet, and a spinner standing in
 * for the account this is about. Nothing here is replaced when the answer arrives.
 */
export function renderBadgePending(element: HTMLElement): void {
  if (intact(element) && messages.get(element) === pendingKey) return;

  const { pill, mark } = frame(element, 'pending');

  paintMark(mark, 'pending');
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-label', 'Checking verification');
  const divider = span('divider', '');

  divider.setAttribute('aria-hidden', 'true');
  const spinner = span('spinner', '');

  spinner.setAttribute('aria-hidden', 'true');
  pill.append(divider, spinner);
  messages.set(element, pendingKey);
}

export function renderBadgeMessage(element: HTMLElement, message: string): void {
  if (intact(element) && messages.get(element) === message) return;

  const { pill, mark } = frame(element, 'message');

  paintMark(mark, 'inactive');
  pill.setAttribute('tabindex', '0');
  pill.setAttribute('role', 'status');
  pill.setAttribute('aria-label', message);
  const icon = span('icon', '–');

  icon.setAttribute('aria-hidden', 'true');
  const divider = span('divider', '');

  divider.setAttribute('aria-hidden', 'true');
  pill.append(divider, span('label', message), icon);
  messages.set(element, message);
}

/**
 * Draws the pill, or returns null when the host already shows exactly this evidence:
 * a periodic refresh that changes nothing must not disturb what is on screen.
 */
export function renderBadge(element: HTMLElement, evidence: Evidence): HTMLAnchorElement | null {
  const provider = evidence.providerName;
  const current = evidence.status === 'verified' && evidence.expiresAt > Date.now();
  const state = current ? 'verified' : evidence.status === 'revoked' ? 'revoked' : 'expired';

  const label = statusLabel(evidence, Date.now());

  const key = renderKey(evidence, current, label);

  if (intact(element) && shown.get(element) === key) return null;

  const handle = externalName(evidence.external);
  const { pill, mark } = frame(element, state);
  const badge = pill as HTMLAnchorElement;

  paintMark(mark, current ? 'current' : 'inactive');
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
  const logo = providerMark(evidence.provider);

  // A provider with no mark of its own is named instead, so the pill never drops it.
  badge.append(divider, logo ?? span('name', provider), span('name', handle));

  if (!current) {
    const icon = span('icon', state === 'expired' ? '◷' : '–');

    icon.setAttribute('aria-hidden', 'true');
    badge.append(span('label', label), icon);
  }

  shown.set(element, key);

  return badge;
}
