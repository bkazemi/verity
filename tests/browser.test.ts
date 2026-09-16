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

  find(tag: string): Element[] {
    return [
      ...(this.tagName === tag ? [this] : []),
      ...this.children.flatMap((child) => child.find(tag)),
      ...(this.shadowRoot?.find(tag) ?? []),
    ];
  }

  addEventListener() {}

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
    /GitHub @<Alice>: Verified \| Verifier: Self-hosted Example/,
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
  evidence = { ...evidence, status: 'revoked' };
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

  for (const changes of [
    { visibility: 'unlisted' },
    { external: { id: '42', handle: 'alice', profileUrl: 'javascript:alert(1)' } },
    { expiresAt: 'tomorrow' },
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
