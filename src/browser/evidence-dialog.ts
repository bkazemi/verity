import { attestationLabel, type Attestation, type Evidence } from '../core/index.js';
import { verificationMark } from './mark.js';
import { providerMark } from './provider-mark.js';

const openDialogs = new WeakMap<HTMLElement, HTMLDialogElement>();

const styles = `
  * { box-sizing: border-box; }
  dialog { width: min(460px, calc(100vw - 32px)); max-height: calc(100dvh - 40px); margin: auto; padding: 24px; border: 1px solid #dce2de; border-radius: 16px; background: #fff; color: #23312b; box-shadow: 0 24px 90px #10201935; font: 13px/1.6 system-ui, sans-serif; }
  dialog::backdrop { background: #15271f66; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
  h2 { margin: 0; font-size: 18px; font-weight: 650; letter-spacing: -.3px; }
  button { width: 32px; height: 32px; border: 1px solid #dce2de; border-radius: 8px; background: #fff; color: #52645a; font: 20px system-ui, sans-serif; cursor: pointer; }
  button:hover { background: #f2f5f1; }
  a { color: #245f43; text-underline-offset: 3px; overflow-wrap: anywhere; }
  a:focus-visible, button:focus-visible { outline: 2px solid #357ce5; outline-offset: 3px; }
  .summary { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
  .mark { width: 36px; height: 36px; flex-shrink: 0; }
  .provider { width: 14px; height: 14px; }
  .state { font-size: 14px; font-weight: 650; line-height: 1.4; }
  .muted { color: #6b786f; font-size: 12px; }
  .account { padding: 14px 16px; border: 1px solid #e0e6df; border-radius: 10px; margin-top: 12px; }
  .account h3 { display: flex; align-items: center; gap: 6px; margin: 0 0 3px; color: #6b786f; font-size: 11px; font-weight: 550; }
  .account a, .account strong { font-weight: 650; font-size: 14px; }
  .reference { margin-top: 2px; }
  .method { margin-top: 8px; }
  .proof { margin-top: 2px; }
  .joiner { display: block; width: 20px; height: 20px; margin: 8px auto -4px; color: #90a096; }
  dl { margin: 16px 0 0; padding-top: 12px; border-top: 1px solid #e5e9e3; display: grid; grid-template-columns: auto 1fr; gap: 5px 16px; font-size: 11px; }
  dt { color: #6b786f; }
  dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
  .explanation { margin-top: 16px; }
`;

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
  const element = document.createElement(tag);

  element.textContent = text;
  element.className = className;

  return element;
}

/** Joins the two cards: the link itself, drawn rather than described. */
function linkMark(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');

  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('class', 'joiner');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const d of [
    'M10.5 7.5 13 5a4.95 4.95 0 0 1 7 7l-2.5 2.5',
    'M13.5 16.5 11 19a4.95 4.95 0 0 1-7-7l2.5-2.5',
    'M9 15l6-6',
  ]) {
    const path = document.createElementNS(namespace, 'path');

    path.setAttribute('d', d);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2');
    path.setAttribute('stroke-linecap', 'round');
    svg.append(path);
  }

  return svg;
}

/**
 * The heading and value for the local card. When the site itself is what was linked
 * there is no subject on it to name, so the site is the value and not a label above
 * some other thing. An absent kind means the site did not say, so nothing is assumed.
 */
function localSide(evidence: Evidence): { heading: string; value: string } {
  const { kind } = evidence.local;

  if (kind === 'site') return { heading: 'Website', value: evidence.siteName };

  const heading: Record<string, string> = {
    account: `Account on ${evidence.siteName}`,
    page: `Page on ${evidence.siteName}`,
  };

  return { heading: heading[kind ?? ''] ?? evidence.siteName, value: evidence.local.label };
}

/**
 * Names how one side was established, inside that side's card. A method that published a
 * proof links it, so a reader can check the claim without taking this backend's word for
 * it. The methods are named, never ranked: which ones convince is the reader's call.
 */
function attestationNote(
  attestation: Attestation | undefined,
  names: { site: string; provider: string },
): HTMLElement[] {
  const label = attestation && attestationLabel(attestation.method, names);

  if (!attestation || !label) return [];

  const note = node('div', label, 'muted method');

  // Evidence is rejected before it reaches here unless every artifact url is http(s).
  if (!attestation.artifactUrl) return [note];

  const proof = node('div', '', 'muted proof');
  const link = node('a', 'View the proof');

  link.href = attestation.artifactUrl;
  link.rel = 'noreferrer';

  proof.append(link);

  return [note, proof];
}

/** Seconds are noise on a record measured in days, and every time here reads the same way. */
function moment(time: number) {
  return new Date(time).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Both sides of a link render as the same card, so a reader can see it is a pair.
 * `extra` carries evidence belonging to that side alone: a provider authenticates and
 * expires on its own terms, and a second provider on the same subject would differ.
 */
function accountCard(
  heading: Node[],
  name: string,
  reference: string | undefined,
  url?: string,
  ...extra: HTMLElement[]
) {
  const card = node('section', '', 'account');
  const title = node('h3');
  const value = node(url ? 'a' : 'strong', name);

  title.append(...heading);

  if (value instanceof HTMLAnchorElement) {
    value.href = url!;
    value.rel = 'noreferrer';
  }

  card.append(title, value);

  if (reference) card.append(node('div', reference, 'muted reference'));

  card.append(...extra);

  return card;
}

function render(content: HTMLElement, evidence: Evidence) {
  const current = evidence.status === 'verified' && evidence.expiresAt > Date.now();
  const status = current ? 'Verified' : evidence.status === 'revoked' ? 'Revoked' : 'Expired';
  const provider = evidence.providerName ?? evidence.provider;
  const summary = node('div', '', 'summary');
  const copy = node('div');

  copy.append(node('div', status, 'state'), node('div', `via: ${evidence.verifierName}`, 'muted'));

  summary.append(verificationMark(!current), copy);
  const dates = node('dl');
  const dateRows: [string, number][] = [['Approved', evidence.approvedAt]];

  if (evidence.status === 'revoked') {
    if (evidence.revokedAt !== undefined) dateRows.push(['Revoked on', evidence.revokedAt]);
  } else {
    dateRows.push([current ? 'Valid until' : 'Expired on', evidence.expiresAt]);
  }

  // When an artifact was last read belongs with the other times, not inside a sentence.
  // Only artifact methods drift: a sign-in is established once and does not go stale.
  if (evidence.attestations?.external.artifactUrl)
    dateRows.push(['Last checked', evidence.attestations.external.confirmedAt]);

  for (const [label, time] of dateRows) {
    dates.append(node('dt', label), node('dd', moment(time)));
  }

  const names = { site: evidence.siteName, provider };

  // Each card says what it is. Without that the pair is two unlabelled boxes.
  const local = localSide(evidence);

  const localCard = accountCard(
    [document.createTextNode(local.heading)],
    local.value,
    // The heading names the site and the label names the subject, so the site's own
    // reference adds a third line saying the same thing. The provider id on the other
    // card stays: that one is the provider's identifier, not the site's own wording.
    undefined,
    evidence.local.profileUrl,
    ...attestationNote(evidence.attestations?.local, names),
  );

  const externalCard = accountCard(
    [providerMark(evidence.provider, provider), document.createTextNode(provider)],
    `@${evidence.external.handle.replace(/^@/, '')}`,
    evidence.external.id,
    evidence.external.profileUrl,
    // Status first, then how it was shown, then when. The proof explains the state
    // above it, so it cannot sit before that state has been given.
    summary,
    ...attestationNote(evidence.attestations?.external, names),
    dates,
  );

  content.replaceChildren(
    localCard,
    linkMark(),
    externalCard,
    // Nothing below the cards may name a provider. Approval, method and dates belong to
    // the card they came from, and a second provider on this subject gets its own card.
    node(
      'p',
      'Verification does not guarantee legal identity, trustworthiness, or permanent ownership.',
      'muted explanation',
    ),
  );
}

/** Fetch fresh, permitted evidence; native dialog supplies focus containment and Escape dismissal. */
export function openEvidenceDialog(opener: HTMLElement, load: () => Promise<Evidence>): void {
  const existing = openDialogs.get(opener);

  if (existing?.open) {
    existing.focus();

    return;
  }

  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();

  sheet.replaceSync(styles);
  root.adoptedStyleSheets = [sheet];
  const dialog = node('dialog');
  const heading = node('h2', 'Verification details');
  const close = node('button', '×');
  const header = node('header');
  const content = node('div', 'Checking verification…');

  heading.id = 'verity-dialog-title';
  dialog.setAttribute('aria-labelledby', heading.id);
  close.type = 'button';
  close.setAttribute('aria-label', 'Close verification details');
  content.setAttribute('aria-live', 'polite');
  header.append(heading, close);
  dialog.append(header, content);
  root.append(dialog);
  document.body.append(host);
  openDialogs.set(opener, dialog);

  let refreshing = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  const refresh = async () => {
    if (refreshing) return;

    refreshing = true;

    try {
      const evidence = await load();

      if (!dialog.open) return;

      clearTimeout(expiryTimer);
      render(content, evidence);
      const remaining = evidence.expiresAt - Date.now();

      if (evidence.status === 'verified' && remaining > 0 && remaining <= 30000) {
        expiryTimer = setTimeout(() => {
          if (dialog.open) render(content, evidence);
        }, remaining);
      }
    } catch {
      clearTimeout(expiryTimer);

      if (dialog.open)
        content.replaceChildren(
          node('p', 'Verification unavailable. Please close this dialog and try again.'),
        );
    } finally {
      refreshing = false;
    }
  };

  const interval = setInterval(() => {
    void refresh();
  }, 30000);

  close.addEventListener('click', () => dialog.close());

  dialog.addEventListener('click', (event) => {
    const bounds = dialog.getBoundingClientRect();

    if (
      event.target === dialog &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    )
      dialog.close();
  });

  dialog.addEventListener(
    'close',
    () => {
      clearInterval(interval);
      clearTimeout(expiryTimer);
      openDialogs.delete(opener);
      host.remove();
      opener.firstElementChild?.shadowRoot?.querySelector<HTMLElement>('a, [tabindex]')?.focus();
    },
    { once: true },
  );

  dialog.showModal();
  void refresh();
}
