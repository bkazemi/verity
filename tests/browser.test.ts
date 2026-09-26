import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

class Element {
  children: Element[] = [];
  private text = '';
  href = '';
  rel = '';
  target = '';
  title = '';
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

  /** Assignment replaces, as it does on a real element. */
  set onclick(handler: ((event: unknown) => unknown) | null) {
    this.listeners['click'] = handler ? [handler] : [];
  }

  get onclick(): ((event: unknown) => unknown) | null {
    return this.listeners['click']?.[0] ?? null;
  }

  removeEventListener() {}

  showModal() {
    this.open = true;
  }

  close() {
    this.open = false;
  }

  focus() {}

  remove() {
    const siblings = this.parentNode?.children;

    if (siblings) siblings.splice(siblings.indexOf(this), 1);

    this.parentNode = undefined;
  }

  get nextSibling(): Element | undefined {
    const siblings = this.parentNode?.children ?? [];

    return siblings[siblings.indexOf(this) + 1];
  }

  /** Every element under this one, including through shadow roots. */
  all(): Element[] {
    return [this, ...this.children.flatMap((c) => c.all()), ...(this.shadowRoot?.all() ?? [])];
  }

  attachShadow() {
    this.shadowRoot = new Element();

    return this.shadowRoot;
  }

  parentNode?: Element;

  append(...children: Element[]) {
    for (const child of children) child.parentNode = this;

    this.children.push(...children);
  }

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  removeAttribute(name: string) {
    delete this.attributes[name];
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
    for (const child of this.children) child.parentNode = undefined;

    for (const child of children) child.parentNode = this;

    this.text = '';
    this.children = children;
  }
}

test('distributed badge renders current/expired/revoked evidence and fails closed on private or malformed results', async () => {
  const asset = await readFile(new URL('../dist/verity.js', import.meta.url), 'utf8');

  let fetches = 0;

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
    attestations: {
      local: { by: 'backend', method: 'declared', confirmedAt: 1 },
      external: [{ by: 'provider', method: 'oauth', confirmedAt: 1 }],
    },
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
    fetch: async () => {
      fetches += 1;

      return { ok: true, json: async () => evidence };
    },
  });

  vm.runInContext(asset, context);

  const client = context.Verity.init({ backendUrl: '/api/verity' }) as {
    mountBadge(
      element: Element,
      options: { connectionId: string; evidence?: unknown },
    ): Promise<void>;
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

  // A refresh keeps the pill on screen while it asks, and finding the same evidence
  // leaves the very same nodes in place: a check nobody needed changes nothing.
  const drawn = element.links()[0]!;
  const refresh = client.mountBadge(element, { connectionId: 'original' });

  assert.equal(element.links()[0], drawn);
  assert.ok(!element.textContent.includes('Checking'));
  await refresh;
  assert.equal(element.links()[0], drawn);

  // Evidence handed over is drawn from what the caller already has, not fetched again.
  const seeded = new Element();
  const asked = fetches;

  await client.mountBadge(seeded, { connectionId: 'original', evidence });
  assert.equal(fetches, asked);
  assert.equal(seeded.textContent, '@<Alice>');
  assert.equal(seeded.links().length, 1);

  // A badge with nothing in hand draws the pill and its mark at once, claiming nothing,
  // and the answer fills that same pill in rather than replacing it.
  const cold = new Element();
  const checking = client.mountBadge(cold, { connectionId: 'original' });
  const frame = cold.find('a')[0]!;
  const mark = cold.find('svg')[0]!;

  assert.equal(frame.className, 'badge pending');
  assert.equal(mark.attributes['class'], 'mark pending');

  assert.deepEqual(
    mark.find('path').map((path) => path.attributes['stroke']),
    ['currentColor', 'currentColor'],
  );

  assert.equal(cold.textContent, '');
  await checking;
  assert.equal(cold.find('a')[0], frame);
  assert.equal(cold.find('svg')[0], mark);
  assert.equal(mark.attributes['class'], 'mark current');

  assert.deepEqual(
    mark.find('path').map((path) => path.attributes['stroke']),
    ['#D3444C', '#149766'],
  );

  assert.equal(cold.textContent, '@<Alice>');

  // Evidence that fails its own checks is not drawn, however it arrived.
  const refused = new Element();

  await client.mountBadge(refused, {
    connectionId: 'original',
    evidence: { ...evidence, expiresAt: 'tomorrow' },
  });

  assert.match(refused.textContent, /Unavailable/);
  assert.equal(refused.links().length, 0);

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

  // A proof nobody has been able to read lately is inside its approval, so it is unconfirmed.
  evidence = { ...evidence, status: 'unconfirmed', expiresAt: Date.now() + 60000 };
  await client.mountBadge(element, { connectionId: 'original' });
  assert.match(element.textContent, /Unconfirmed/);
  assert.ok(!element.textContent.includes('Expired'));

  // A key in the pill: its own mark, its fingerprint, and no @ in front of it.
  evidence = {
    ...evidence,
    status: 'verified',
    provider: 'openpgp',
    providerName: 'OpenPGP',
    external: {
      id: 'FPR',
      kind: 'key',
      handle: 'alice@example.test',
      profileUrl: 'https://k.test',
    },
  };

  await client.mountBadge(element, { connectionId: 'original' });

  const pill: string = element.textContent;

  // The address a reader knows, written as it is. An @ in front would read as
  // @alice@example.test, and it was never a handle to begin with.
  assert.equal(pill, 'alice@example.test');
  assert.ok(!pill.startsWith('@'));
  assert.ok(!pill.includes('OpenPGP'));
  assert.equal(element.find('svg').length, 2);
  assert.equal(element.find('svg')[1]!.attributes['class'], 'provider');

  evidence = {
    ...evidence,
    provider: 'github',
    providerName: 'GitHub',
    external: { id: '42', handle: '<Alice>', profileUrl: 'https://github.com/alice' },
    status: 'revoked',
    expiresAt: 1,
  };

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
      external: [
        {
          by: 'provider',
          method: 'gist',
          artifactUrl: 'https://gist.github.com/alice/abc',
          expect: 'verity-token',
          confirmedAt: 2,
        },
      ],
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
    { attestations: undefined },
    { providerName: undefined },
    { attestations: { local: declared } },
    { attestations: { local: declared, external: [{ ...declared, by: 'nobody' }] } },
    // The first method is the one a record is judged by, so there must be one.
    { attestations: { local: declared, external: [] } },
    // An artifact url is rendered as a link, so only http(s) may ever reach an href.
    {
      attestations: {
        local: declared,
        external: [{ ...declared, by: 'provider', artifactUrl: 'javascript:alert(1)' }],
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

    assert.ok(!(element.textContent as string).includes('<Alice>'));
    evidence = previous;
  }
});

/**
 * Mounts a badge, clicks it, and returns the dialog it opened. Attestations vary per case
 * because how each side was established is the thing under test; everything else is fixed.
 */
async function renderDialog(
  attestations: Record<string, unknown>,
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
  open({ button: 0, preventDefault() {} });

  const opened = body.all().find((found) => found.tagName === 'dialog')!;

  // The dialog is drawn from the record the pill holds before it is shown, so it opens
  // at its full size rather than growing out of a one-line placeholder.
  assert.ok(opened, 'a dialog is attached to the document');
  assert.ok(!opened.textContent.includes('Checking verification'));
  assert.match(opened.textContent, /Verification does not guarantee/);
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
    external: [
      {
        by: 'provider',
        method: 'gist',
        artifactUrl: 'https://gist.github.com/alice/abc',
        expect: 'verity-c1',
        confirmedAt: 2,
      },
    ],
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
    ['h3', 'a', 'muted reference', 'summary', 'muted method', 'dl'],
  );

  // A published proof is reachable, so a reader can check it without trusting this backend.
  // The method's name is the link, and its title says where it leads and when it was read.
  const proof = external
    .links()
    .find((link) => link.textContent === 'Published a proof on GitHub')!;

  assert.equal(proof.href, 'https://gist.github.com/alice/abc');
  assert.match(proof.title, /^View the proof at gist\.github\.com \| Last checked /);

  // Every link out of the dialog opens beside it: the record is read against what it
  // links to, and following one in place would take the reader off the page.
  for (const link of dialog.links()) {
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noreferrer');
  }

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
    external: [{ by: 'provider', method: 'telepathy', confirmedAt: 2 }],
  });

  assert.match(unknown.dialog.textContent, /Stated by site\.test/);

  // Nothing is claimed about a method this renderer does not understand.
  assert.ok(!unknown.dialog.textContent.includes('telepathy'));
  assert.ok(!unknown.dialog.links().some((link) => link.title.startsWith('View the proof')));

  // oauth leaves no public artifact, so it is named without offering a link to open.
  const signedIn = await renderDialog({
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: [{ by: 'provider', method: 'oauth', confirmedAt: 2 }],
  });

  assert.match(signedIn.dialog.textContent, /Signed in with GitHub/);
  assert.ok(!signedIn.dialog.links().some((link) => link.title.startsWith('View the proof')));
  assert.ok(!signedIn.dialog.textContent.includes('last checked'));
});

test('a proof gone unread reads as unconfirmed, not as an approval that ran out', async () => {
  const attestations = {
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: [
      {
        by: 'provider',
        method: 'gist',
        artifactUrl: 'https://gist.github.com/alice/abc',
        confirmedAt: 1,
      },
    ],
  };

  const stale = await renderDialog(attestations, { status: 'unconfirmed' });

  assert.match(stale.dialog.textContent, /Unconfirmed/);
  assert.ok(!stale.dialog.textContent.includes('Expired'));

  // The approval itself is untouched, so the record still reads forward to its own end.
  assert.match(stale.dialog.textContent, /Valid until/);

  // The proof is still linked: an unread proof is not a withdrawn one.
  assert.ok(stale.dialog.links().some((link) => link.title.startsWith('View the proof')));
  assert.match(stale.dialog.textContent, /Last checked/);

  const lapsed = await renderDialog(attestations, { status: 'expired', expiresAt: 1 });

  assert.match(lapsed.dialog.textContent, /Expired on/);
  assert.ok(!lapsed.dialog.textContent.includes('Unconfirmed'));
});

test('a key is named by its fingerprint, with no @ and the provider written once', async () => {
  const fingerprint = '7FDEB37E4F6EAD8E2FEFD8511347D93FEB1342AF';

  const { cards } = await renderDialog(
    {
      local: { by: 'backend', method: 'declared', confirmedAt: 1 },
      external: [
        {
          by: 'provider',
          method: 'signature',
          artifactUrl: 'https://verifier.test/api/verity/connections/c1/proof',
          hosted: true,
          confirmedAt: 2,
        },
      ],
    },
    {
      provider: 'openpgp',
      providerName: 'OpenPGP',
      external: {
        id: fingerprint,
        kind: 'key',
        handle: 'alice@example.test',
        profileUrl: 'https://keys.example/search',
      },
    },
  );

  const external = cards[1]!;

  // The address the key signed for, above the fingerprint that is the actual identity.
  assert.match(external.textContent, /alice@example\.test/);
  assert.match(external.textContent, new RegExp(fingerprint));

  // No @ in front of it: it is not a handle, and @alice@example.test is not a name.
  assert.ok(!external.textContent.includes('@alice'));

  // The heading carries a mark and the name. It used to carry the name twice, because the
  // mark fell back to writing it whenever a provider had none of its own.
  const heading = external.find('h3')[0]!;

  assert.equal(heading.textContent, 'OpenPGP');
  assert.equal(external.textContent.split('OpenPGP').length - 1, 1);
  assert.equal(heading.find('svg')[0]!.attributes['class'], 'provider');
  assert.match(external.textContent, /Proved with a signature/);
});

test('an account still reads as a handle, and its provider mark is still drawn', async () => {
  const { cards } = await renderDialog({
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: [{ by: 'provider', method: 'oauth', confirmedAt: 2 }],
  });

  const heading = cards[1]!.find('h3')[0]!;

  assert.match(cards[1]!.textContent, /@alice/);
  assert.equal(heading.textContent, 'GitHub');
  assert.equal(heading.find('svg').length, 1);
});

test('methods after the first sit beneath it, each with its own proof', async () => {
  const { cards } = await renderDialog({
    local: { by: 'backend', method: 'declared', confirmedAt: 1 },
    external: [
      { by: 'provider', method: 'oauth', confirmedAt: 2 },
      {
        by: 'provider',
        method: 'backlink',
        artifactUrl: 'https://github.com/alice',
        confirmedAt: 3,
      },
    ],
  });

  const text = cards[1]!.textContent;

  const additional = cards[1]!
    .all()
    .filter((found) => found.className.includes('additional'))
    .map((line) => line.textContent);

  assert.match(text, /Signed in with GitHub\+ Linked back to site\.test/);
  assert.deepEqual(additional, ['+ Linked back to site.test']);

  // Each proof is named by its own link, so two on one card cannot be mistaken for each other.
  const backlink = cards[1]!
    .links()
    .find((link) => link.textContent === 'Linked back to site.test')!;

  assert.equal(backlink.href, 'https://github.com/alice');
  assert.match(backlink.title, /^View the proof at github\.com \| Last checked /);

  // The method is named in words, never by the markup it happens to use.
  assert.ok(!text.includes('rel='));
});

test('a page read by a link back is a record the badge will show', async () => {
  const { cards } = await renderDialog(
    {
      local: { by: 'backend', method: 'declared', confirmedAt: 1 },
      external: [
        {
          by: 'provider',
          method: 'backlink',
          artifactUrl: 'https://example.test/about',
          confirmedAt: 2,
        },
      ],
    },
    {
      provider: 'link',
      providerName: 'Web',
      external: {
        id: 'https://example.test/about',
        kind: 'page',
        handle: 'example.test/about',
        profileUrl: 'https://example.test/about',
      },
    },
  );

  assert.match(cards[1]!.textContent, /example\.test\/about/);
  assert.ok(!cards[1]!.textContent.includes('@example'));
});

test('the version stamped on a record is the one the package ships', async () => {
  const { version } = await import('../src/version.js');
  const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(version, `v${manifest.version.split('.')[0]}`);
});
