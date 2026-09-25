import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactProvider, LocalAccount } from '../src/core/index.js';
import { VerityService } from '../src/server/service.js';
import { alice, fakeArtifactProvider, fakeProvider, MemoryStorage } from './helpers.js';

/** Alice after the site moved her profile: the same subject at a new address. */
const moved = { ...alice, profileUrl: 'https://site.test/users/alice' };

/** A link back from a GitHub profile: the account is named by its address alone. */
function fakeBacklink(): ArtifactProvider & { pages: Set<string>; calls: number } {
  const pages = new Set<string>();

  return {
    id: 'github',
    name: 'GitHub',
    method: 'backlink',
    artifact: 'location',
    pages,
    calls: 0,
    expect: (local: LocalAccount) => local.profileUrl!,
    instructions: (expect) => ['Link here:', { code: expect }],
    verify({ artifact }) {
      this.calls += 1;

      if (!pages.has(artifact)) throw new Error('No link back');

      return Promise.resolve({
        id: artifact,
        kind: 'account',
        handle: 'known-alice',
        profileUrl: artifact,
      });
    },
  };
}

function fixture(extra: ArtifactProvider[] = []) {
  let now = 1000000;
  const oauth = fakeProvider();
  const backlink = fakeBacklink();

  const service = new VerityService({
    storage: new MemoryStorage(),
    provider: [oauth, backlink, ...extra],
    baseUrl: 'https://site.test/api/verity',
    siteName: 'Site',
    verifierName: 'Site',
    profileOrigins: ['https://site.test'],
    now: () => now,
    validityMs: 30 * 86400000,
    recheckMs: 1000,
    freshnessMs: 5000,
  });

  async function signIn(local: LocalAccount = alice) {
    const flow = await service.start(local, undefined, 'connect', { method: 'oauth' });
    const state = new URL(flow.authorizationUrl!).searchParams.get('state')!;

    await service.callback(state, flow.binding, 'code');

    return (await service.approve(flow.flowId, flow.binding, local, 'public'))!;
  }

  async function linkBack(
    kind: 'connect' | 'renew' = 'connect',
    id?: string,
    page = 'https://github.com/Known-Alice',
  ) {
    backlink.pages.add(page);
    const flow = await service.start(alice, id, kind, { provider: 'github', method: 'backlink' });

    await service.submit(flow.flowId, flow.binding, page);

    return { flow, id: await service.approve(flow.flowId, flow.binding, alice, 'unlisted') };
  }

  return {
    service,
    oauth,
    backlink,
    signIn,
    linkBack,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('a second method on the same account joins the record beneath the first', async () => {
  const f = fixture();
  const id = await f.signIn();

  f.advance(10);
  const added = await f.linkBack();

  // The same record, still public: joining it does not rechoose its visibility.
  assert.equal(added.id, id);
  assert.equal((await f.service.mine(alice)).length, 1);

  const evidence = await f.service.read(id);

  assert.equal(evidence.visibility, 'public');
  assert.equal(evidence.attestations!.external.method, 'oauth');

  assert.deepEqual(
    evidence.attestations!.further!.map((a) => [a.method, a.artifactUrl]),
    [['backlink', 'https://github.com/Known-Alice']],
  );

  // The record keeps the account the first method named, not the address the second read.
  assert.equal(evidence.external.id, '42');
});

test('the approval page is told a flow joins a record rather than making one', async () => {
  const f = fixture();
  const id = await f.signIn();

  f.backlink.pages.add('https://github.com/known-alice');
  const flow = await f.service.start(alice, undefined, 'connect', { method: 'backlink' });

  await f.service.submit(flow.flowId, flow.binding, 'https://github.com/known-alice');

  const pending = await f.service.flow(flow.flowId, flow.binding);

  assert.equal((await f.service.joining(pending))?.id, id);
});

test('the same method again makes a record of its own, as it always did', async () => {
  const f = fixture();
  const first = await f.signIn();
  const second = await f.signIn();

  assert.notEqual(first, second);
  assert.equal((await f.service.read(second)).attestations!.further, undefined);
});

test('a renewal by another method adds it, and by the same one keeps it in place', async () => {
  const f = fixture();
  const id = await f.signIn();

  await f.linkBack('renew', id);
  f.advance(10);
  await f.linkBack('renew', id);

  const evidence = await f.service.read(id);

  assert.equal(evidence.attestations!.external.method, 'oauth');
  assert.equal(evidence.attestations!.further!.length, 1);
  assert.equal(evidence.attestations!.further![0]!.confirmedAt, 1000010);
});

test('a record renewed at a differently written address is reread at that address', async () => {
  const f = fixture();
  const id = (await f.linkBack()).id!;

  f.advance(10);
  await f.linkBack('renew', id, 'https://github.com/known-alice');

  // The renewal names the account as it read it, so a reread of the new proof agrees.
  assert.equal((await f.service.read(id, alice)).external.id, 'https://github.com/known-alice');

  f.advance(2000);
  assert.equal(await f.service.recheck(), 1);
});

test('an address that changed hands cannot remove the record it proved', async () => {
  const f = fixture();

  // Proved by a link back, so the record knows the address and not GitHub's number.
  const id = (await f.linkBack()).id!;

  // Whoever holds the username next signs in with it. The profile is the same address;
  // the account GitHub issued is not shown to be the same one.
  for (const kind of ['revoke', 'share-revoke'] as const) {
    const flow = await f.service.start(undefined, id, kind, {
      provider: 'github',
      method: 'oauth',
    });

    await f.service
      .callback(new URL(flow.authorizationUrl!).searchParams.get('state')!, flow.binding, 'code')
      .catch(() => undefined);

    assert.equal((await f.service.flow(flow.flowId, flow.binding)).phase, 'failed', kind);
  }

  assert.equal((await f.service.read(id, alice)).status, 'verified');
});

test("a record proved by a link to the subject's old address is not joined", async () => {
  const f = fixture();
  const id = (await f.linkBack()).id!;

  // The link back named /users/1. Signing in for the subject at its new address must not
  // add to that record, where the old proof would go on standing for the new address.
  const signedIn = await f.signIn(moved);

  assert.notEqual(signedIn, id);
  assert.equal((await f.service.read(id, alice)).local.profileUrl, alice.profileUrl);
});

test('joining at a new address drops the further proofs that named the old one', async () => {
  // A method whose proof is a token minted per flow, which names no subject.
  const notes = { ...fakeArtifactProvider(), id: 'github', name: 'GitHub' };
  const f = fixture([notes]);
  const id = await f.signIn();

  await f.linkBack('renew', id);

  const flow = await f.service.start(moved, undefined, 'connect', {
    provider: 'github',
    method: 'attestation',
  });

  notes.artifacts.set('https://notes.test/alice', flow.expect!);
  await f.service.submit(flow.flowId, flow.binding, 'https://notes.test/alice');

  assert.equal(await f.service.approve(flow.flowId, flow.binding, moved, 'public'), id);

  const evidence = await f.service.read(id);

  assert.equal(evidence.local.profileUrl, moved.profileUrl);

  assert.deepEqual(
    evidence.attestations!.further!.map((a) => a.method),
    ['attestation'],
  );

  // Nothing is left to confirm the link to where the subject used to be.
  const calls = f.backlink.calls;

  f.advance(2000);
  await f.service.recheck();
  assert.equal(f.backlink.calls, calls);
});

test('a different account on the same provider is not joined by its profile alone', async () => {
  const f = fixture();

  await f.signIn();
  f.oauth.externalId = '99';

  // Both ids were issued by GitHub, so they settle it whatever the profiles say.
  const other = await f.signIn();

  assert.equal((await f.service.read(other)).attestations!.further, undefined);
  assert.equal((await f.service.mine(alice)).length, 2);
});

test('a further proof is reread, and leaves the record while it goes unread', async () => {
  const f = fixture();
  const id = await f.signIn();

  await f.linkBack('renew', id);
  f.advance(2000);

  assert.equal(await f.service.recheck(), 1);
  assert.equal(f.backlink.calls, 2);

  // Taken down: rereads fail, and once stale it stops corroborating the record.
  f.backlink.pages.clear();
  f.advance(6000);
  assert.equal(await f.service.recheck(), 0);

  const evidence = await f.service.read(id);

  assert.equal(evidence.attestations!.further, undefined);
  // The main method is untouched, so the record itself still stands.
  assert.equal(evidence.status, 'verified');
});

test('a standing proof is not offered for removal from the external side', async () => {
  const f = fixture();
  const id = await f.signIn();

  await assert.rejects(
    f.service.start(undefined, id, 'revoke', { provider: 'github', method: 'backlink' }),
    /Unavailable/,
  );

  // Without a choice, removal uses the method the record was first shown by.
  const removal = await f.service.start(undefined, id, 'revoke');

  assert.ok(removal.authorizationUrl);
});

test('a flow stays in the namespace of the record it acts on', async () => {
  const notes = fakeArtifactProvider();

  const service = new VerityService({
    storage: new MemoryStorage(),
    provider: [fakeProvider(), notes],
    baseUrl: 'https://site.test/api/verity',
    siteName: 'Site',
    verifierName: 'Site',
    profileOrigins: ['https://site.test'],
  });

  const flow = await service.start(alice);
  const state = new URL(flow.authorizationUrl!).searchParams.get('state')!;

  await service.callback(state, flow.binding, 'code');
  const id = (await service.approve(flow.flowId, flow.binding, alice, 'public'))!;

  await assert.rejects(service.start(alice, id, 'renew', { provider: 'notes' }), /Unavailable/);
});

test('each method is configured once', () => {
  assert.throws(
    () =>
      new VerityService({
        storage: new MemoryStorage(),
        provider: [fakeProvider(), fakeProvider()],
        baseUrl: 'https://site.test/api/verity',
        siteName: 'Site',
        verifierName: 'Site',
        profileOrigins: ['https://site.test'],
      }),
    /once/,
  );
});
