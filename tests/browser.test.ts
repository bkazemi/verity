import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

class Element {
  children: Element[] = [];
  private text = '';
  href = '';
  rel = '';
  className = '';
  shadowRoot?: Element;
  tagName = '';
  attributes: Record<string, string> = {};
  listeners: Record<string, ((event: unknown) => unknown)[]> = {};
  id = '';
  type = '';
  open = false;

  find(tag: string): Element[] {
    return [
      ...(this.tagName === tag ? [this] : []),
      ...this.children.flatMap((child) => child.find(tag)),
      ...(this.shadowRoot?.find(tag) ?? []),
    ];
  }

  addEventListener(type: string, handler: (event: unknown) => unknown) {
    (this.listeners[type] ??= []).push(handler);
  }

  removeEventListener() {}

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  focus() {}

  remove() {}

  /** Every element under this one, including through shadow roots. */
  all(): Element[] {
    return [this, ...this.children.flatMap((c) => c.all()), ...(this.shadowRoot?.all() ?? [])];
  }

  attachShadow() {
    this.shadowRoot = new Element();

    return this.shadowRoot;
  }

  append(...children: Element[]) {
    this.children.push(...children);
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  links(): Element[] {
    return [
      ...(this.tagName === 'a' ? [this] : []),
      ...this.children.flatMap((c) => c.links()),
      ...(this.shadowRoot?.links() ?? []),
    ];
  }

  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }

  get textContent(): string {
    if (this.tagName === 'style') return '';

    return (
      this.text +
      this.children.map((c) => c.textContent).join('') +
      (this.shadowRoot?.textContent ?? '')
    );
  }

  replaceChildren(...children: Element[]) {
    this.text = '';
    this.children = children;
  }
}

test('distributed badge renders current/expired/revoked evidence and fails closed on private or malformed results', async () => {
  const asset = await readFile(new URL('../dist/verity.js', import.meta.url), 'utf8');

  let evidence: Record<string, unknown> = {
    id: 'original',
    provider: 'github',
    providerName: 'GitHub',
    siteName: 'Example',
    verifierName: 'Self-hosted Example',
    local: { label: 'Original account', reference: 'member-1' },
    external: { id: '42', handle: '<Alice>', profileUrl: 'https://github.com/alice' },
    evidenceUrl: 'https://site.test/api/verity/connections/original',
    status: 'verified',
    visibility: 'public',
    authenticatedAt: 1,
    approvedAt: 1,
    expiresAt: Date.now() + 60000,
  };

  const context = vm.createContext({
    URL,
    CSSStyleSheet: class {
      replaceSync() {}
    },
    location: { href: 'https://site.test/profile', origin: 'https://site.test' },
    document: {
      createElementNS: (_namespace: string, tag: string) => {
        const element = new Element();

        element.tagName = tag;

        return element;
      },
      createElement: (tag: string) => {
        const element = new Element();

        element.tagName = tag;

        return element;
      },
      createTextNode: (text: string) => {
        const el = new Element();

        el.textContent = text;

        return el;
      },
    },
    fetch: async () => ({ ok: true, json: async () => evidence }),
  });

  vm.runInContext(asset, context);

  const client = context.Verity.init({ backendUrl: '/api/verity' }) as {
    mountBadge(element: Element, options: { connectionId: string }): Promise<void>;
  };

  const element = new Element();

  await client.mountBadge(element, { connectionId: 'copied-badge' });
  assert.ok(!element.textContent.includes('Account verification'));
  assert.equal(element.textContent, '@<Alice>');

  assert.match(
    element.links()[0]!.attributes['aria-label']!,
    /GitHub @<Alice>: Verified \| via: Self-hosted Example/,
  );

  assert.equal(element.links().length, 1);
  const logo = element.find('svg');

  assert.equal(logo.length, 2);
  assert.equal(logo[1]!.attributes['viewBox'], '0 0 16 16');
  assert.equal(logo[0]!.attributes['viewBox'], '-4 -4 264 264');

  assert.deepEqual(
    logo[0]!.find('path').map((path) => path.attributes['stroke']),
    ['#D3444C', '#149766'],
  );

  assert.ok(!element.textContent.includes('✓'));
  assert.equal(element.links().at(-1)!.href, 'https://site.test/api/verity/connections/original');
  evidence = { ...evidence, expiresAt: 1 };
  await client.mountBadge(element, { connectionId: 'original' });
  assert.match(element.textContent, /Expired/);
  assert.equal(element.find('svg').length, 2);

  assert.deepEqual(
    element
      .find('svg')[0]!
      .find('path')
      .map((path) => path.attributes['stroke']),
    ['#149766', '#D3444C'],
  );

  assert.equal(element.find('svg')[0]!.find('path')[1]!.attributes['stroke-dasharray'], '108 176');
  assert.equal(element.links()[0]!.children.at(-1)!.className, 'icon');

  // A proof nobody has been able to read lately has not reached its expiry, and saying
  // "expired" of a record still inside its window would be the wrong thing to have said.
  evidence = { ...evidence, status: 'expired', expiresAt: Date.now() + 60000 };
  await client.mountBadge(element, { connectionId: 'original' });
  assert.match(element.textContent, /Unconfirmed/);
  assert.ok(!element.textContent.includes('Expired'));
  evidence = { ...evidence, status: 'revoked', expiresAt: 1 };
  await client.mountBadge(element, { connectionId: 'original' });
  assert.match(element.textContent, /Revoked/);
  assert.equal(element.find('svg').length, 2);

  assert.deepEqual(
    element
      .find('svg')[0]!
      .find('path')
      .map((path) => path.attributes['stroke']),
    ['#149766', '#D3444C'],
  );

  assert.equal(element.find('svg')[0]!.find('path')[1]!.attributes['stroke-dasharray'], '108 176');
  assert.equal(element.links()[0]!.children.at(-1)!.className, 'icon');

  const declared = { by: 'backend', method: 'declared', confirmedAt: 1 };

  // A well-formed pair of attestations changes nothing about how the badge renders.
  evidence = {
    ...evidence,
    attestations: {
      local: declared,
      external: {
        by: 'provider',
        method: 'attestation',
        artifactUrl: 'https://gist.github.com/alice/abc',
        expect: 'verity-token',
        confirmedAt: 2,
      },
    },
  };

  await client.mountBadge(element, { connectionId: 'original' });
  assert.equal(element.links().length, 1);

  for (const changes of [
    { visibility: 'unlisted' },
    { external: { id: '42', handle: 'alice', profileUrl: 'javascript:alert(1)' } },
    { expiresAt: 'tomorrow' },
    // One side described and the other missing would let a renderer imply a method
    // for a side that never reported one.
    { attestations: { local: declared } },
    { attestations: { local: declared, external: { ...declared, by: 'nobody' } } },
    // An artifact url is rendered as a link, so only http(s) may ever reach an href.
    {
      attestations: {
        local: declared,
        external: { ...declared, by: 'provider', artifactUrl: 'javascript:alert(1)' },
      },
    },
  ]) {
    const previous = evidence;

    evidence = { ...previous, ...changes };
    await client.mountBadge(element, { connectionId: 'original' });
    assert.match(element.textContent, /Unavailable/);
    assert.equal(element.links().length, 0);

    assert.deepEqual(
      element
        .find('svg')[0]!
        .find('path')
        .map((path) => path.attributes['stroke']),
      ['#149766', '#D3444C'],
    );

    assert.ok(!element.textContent.includes('<Alice>'));
    evidence = previous;
  }
});

/**
 * Mounts a badge, clicks it, and returns the dialog it opened. Attestations vary per case
 * because how each side was established is the thing under test; everything else is fixed.
 */
async function renderDialog(
  attestations?: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  const asset = await readFile(new URL('../dist/verity.js', import.meta.url), 'utf8');

  const evidence = {
    id: 'c1',
    provider: 'github',
    providerName: 'GitHub',
    siteName: 'site.test',
    verifierName: 'verifier.test',
    local: {
      label: 'Alice',
      reference: 'site.test author',
      profileUrl: 'https://site.test/about/',
    },
    external: { id: '11813054', handle: 'alice', profileUrl: 'https://github.com/alice' },
    evidenceUrl: 'https://verifier.test/api/verity/connections/c1',
    status: 'verified',
    visibility: 'public',
    authenticatedAt: 1,
    approvedAt: 1,
    expiresAt: Date.now() + 60000,
    attestations,
    ...overrides,
  };

  const body = new Element();

  const element = (tag: string) => {
    const created = new Element();

    created.tagName = tag;

    return created;
  };

  const context = vm.createContext({
    URL,
    Date,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    CSSStyleSheet: class {
      replaceSync() {}
    },
    // The renderer branches on these, so the stub must satisfy instanceof.
    HTMLElement: { [Symbol.hasInstance]: (value: unknown) => value instanceof Element },
    HTMLAnchorElement: {
      [Symbol.hasInstance]: (value: unknown) => (value as Element)?.tagName === 'a',
    },
    HTMLDialogElement: {
      [Symbol.hasInstance]: (value: unknown) => (value as Element)?.tagName === 'dialog',
    },
    location: { href: 'https://site.test/profile', origin: 'https://site.test' },
    document: {
      body,
      createElementNS: (_namespace: string, tag: string) => element(tag),
      createElement: element,
      createTextNode: (text: string) => {
        const created = new Element();

        created.textContent = text;

        return created;
      },
    },
    fetch: async () => ({ ok: true, json: async () => evidence }),
  });

  vm.runInContext(asset, context);

  const client = context.Verity.init({ backendUrl: 'https://verifier.test/api/verity' }) as {
    mountBadge(host: Element, options: { connectionId: string }): Promise<void>;
  };

  const host = new Element();

  await client.mountBadge(host, { connectionId: 'c1' });

  const pill = host.links()[0]!;
  const open = pill.listeners['click']?.[0];

  assert.ok(open, 'the badge opens the dialog on click');
  await open({ button: 0, preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const dialog = body.all().find((found) => found.tagName === 'dialog')!;

  assert.ok(dialog, 'a dialog is attached to the document');

  return {
    dialog,
    cards: dialog.all().filter((found) => found.className.includes('account')),
  };
}

test('the evidence dialog presents both sides of a link as parallel cards', async () => {
  const { dialog, cards } = await renderDialog({
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: {
      by: 'provider',
      method: 'attestation',
      artifactUrl: 'https://gist.github.com/alice/abc',
      expect: 'verity-c1',
      confirmedAt: 2,
    },
  });

  // Both sides render as cards, so neither reads as a caption on the other.
  assert.equal(cards.length, 2);

  const [local, external] = cards as [Element, Element];

  // No kind was supplied, so the card names the site and asserts nothing more.
  assert.match(local.textContent, /site\.test/);
  assert.ok(!local.textContent.includes('Account on'));
  assert.match(local.textContent, /Alice/);
  // The site's own reference would only restate the heading and label.
  assert.ok(!local.textContent.includes('site.test author'));

  assert.match(external.textContent, /GitHub/);
  assert.match(external.textContent, /@alice/);
  assert.match(external.textContent, /11813054/);

  // The old caption assumed the local side was a person's account.
  assert.ok(!dialog.textContent.includes('For Alice on'));
  // The two cards are joined by a link mark, not by words.
  assert.ok(!dialog.textContent.includes('This verification links'));
  assert.equal(dialog.all().filter((e) => e.attributes['class'] === 'joiner').length, 1);

  // Each side says how it was established, on that side, with neither ranked.
  assert.match(local.textContent, /Stated by site\.test/);
  assert.match(external.textContent, /Published a proof on GitHub/);
  assert.ok(!local.textContent.includes('Published a proof'));
  assert.ok(!external.textContent.includes('Stated by'));

  // The proof explains the verified state, so it is read after that state, not before it.
  assert.deepEqual(
    external.children.map((child) => child.className || child.tagName),
    ['h3', 'a', 'muted reference', 'summary', 'muted method', 'muted proof', 'dl'],
  );

  // A published proof is reachable, so a reader can check it without trusting this backend.
  const proof = external.links().find((link) => link.textContent.includes('View the proof'))!;

  assert.equal(proof.href, 'https://gist.github.com/alice/abc');

  // Every time on the card sits in one table, so none of them read as prose.
  assert.deepEqual(
    external
      .find('dl')[0]!
      .children.filter((child) => child.tagName === 'dt')
      .map((child) => child.textContent),
    ['Approved', 'Valid until', 'Last checked'],
  );

  // The flattened sentence described one method for both sides and named neither.
  assert.ok(!dialog.textContent.includes('proved control of it with their provider'));
  assert.ok(!dialog.textContent.includes('does not check'));

  // Nothing below the cards may name a provider: a subject proved a second way gets a
  // second card, and everything under them has to still read correctly when it does.
  const footer = dialog.all().find((found) => found.className === 'muted explanation')!;

  assert.ok(footer, 'the cards are followed by a footer');
  assert.ok(!footer.textContent.includes('GitHub'));
  assert.ok(!footer.textContent.includes('alice'));
  assert.ok(!footer.textContent.includes('site.test'));
});

test('an unrecognised method is omitted rather than described, and oauth offers no proof link', async () => {
  const unknown = await renderDialog({
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: { by: 'provider', method: 'telepathy', confirmedAt: 2 },
  });

  assert.match(unknown.dialog.textContent, /Stated by site\.test/);

  // Nothing is claimed about a method this renderer does not understand.
  assert.ok(!unknown.dialog.textContent.includes('telepathy'));
  assert.ok(!unknown.dialog.textContent.includes('View the proof'));

  // oauth leaves no public artifact, so it is named without offering a link to open.
  const signedIn = await renderDialog({
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: { by: 'provider', method: 'oauth', confirmedAt: 2 },
  });

  assert.match(signedIn.dialog.textContent, /Signed in with GitHub/);
  assert.ok(!signedIn.dialog.textContent.includes('View the proof'));
  assert.ok(!signedIn.dialog.textContent.includes('last checked'));

  // An older backend sends no attestations at all, and the cards simply omit the line.
  const older = await renderDialog();

  assert.equal(older.cards.length, 2);
  assert.ok(!older.dialog.textContent.includes('Stated by'));
  assert.ok(!older.dialog.textContent.includes('Signed in with'));
});

test('a proof gone unread reads as unconfirmed, not as an approval that ran out', async () => {
  const attestations = {
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: {
      by: 'provider',
      method: 'attestation',
      artifactUrl: 'https://gist.github.com/alice/abc',
      confirmedAt: 1,
    },
  };

  const stale = await renderDialog(attestations, { status: 'expired' });

  assert.match(stale.dialog.textContent, /Unconfirmed/);
  assert.ok(!stale.dialog.textContent.includes('Expired'));

  // The approval itself is untouched, so the record still reads forward to its own end.
  assert.match(stale.dialog.textContent, /Valid until/);

  // The proof is still linked: an unread proof is not a withdrawn one.
  assert.match(stale.dialog.textContent, /View the proof/);
  assert.match(stale.dialog.textContent, /Last checked/);

  const lapsed = await renderDialog(attestations, { status: 'expired', expiresAt: 1 });

  assert.match(lapsed.dialog.textContent, /Expired on/);
  assert.ok(!lapsed.dialog.textContent.includes('Unconfirmed'));
});
