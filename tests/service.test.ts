import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VerityService, type ServiceOptions } from '../src/server/service.js';

/** Either shape of provider drives the same service, so the fixture takes both. */
type FakeProvider =
  | ReturnType<typeof fakeProvider>
  | ReturnType<typeof fakeArtifactProvider>
  | ReturnType<typeof fakeDocumentProvider>;

import {
  alice,
  bob,
  fakeArtifactProvider,
  fakeDocumentProvider,
  fakeProvider,
  MemoryStorage,
  projectPage,
  written,
} from './helpers.js';

function fixture(provider: FakeProvider = fakeProvider(), extra: Partial<ServiceOptions> = {}) {
  let now = 1000000;

  const storage = new MemoryStorage();

  const service = new VerityService({
    storage,
    provider,
    baseUrl: 'https://site.test/api/verity',
    siteName: 'Site',
    verifierName: 'Site',
    profileOrigins: ['https://site.test'],
    now: () => now,
    validityMs: 1000,
    shareTtlMs: 2000,
    ...extra,
  });

  async function pending(local = alice) {
    const flow = await service.start(local);
    const state = new URL(flow.authorizationUrl!).searchParams.get('state')!;

    await service.callback(state, flow.binding, 'code');

    return { ...flow, state };
  }

  async function connect(visibility: 'public' | 'unlisted' = 'unlisted') {
    const flow = await pending();
    const id = (await service.approve(flow.flowId, flow.binding, alice, visibility))!;

    return { ...flow, id };
  }

  return {
    service,
    storage,
    provider,
    pending,
    connect,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test('explicit approval, immutable pair, public-safe identity, idempotent completion', async () => {
  const f = fixture(),
    flow = await f.pending();

  assert.equal((await f.service.mine(alice)).length, 0);
  await assert.rejects(f.service.approve(flow.flowId, flow.binding, bob, 'public'));

  const results = await Promise.all(
    [1, 2].map(() => f.service.approve(flow.flowId, flow.binding, alice, 'public')),
  );

  assert.equal(results[0], results[1]);
  const e = await f.service.read(results[0]!);

  assert.equal(e.local.reference, alice.reference);
  assert.ok(!('id' in e.local));
  assert.equal(e.status, 'verified');
  assert.equal((await f.service.mine(alice)).length, 1);
});

test('the local side of a link can be a page or the site itself, not only an account', async () => {
  const f = fixture(),
    flow = await f.pending(projectPage);

  const id = (await f.service.approve(flow.flowId, flow.binding, projectPage, 'public'))!;
  const e = await f.service.read(id);

  assert.equal(e.local.kind, 'page');
  assert.equal(e.local.reference, projectPage.reference);
  assert.ok(!('id' in e.local));

  // An unconfigured kind still means an account, and an unknown one is refused.
  assert.equal(f.service.validateLocal(alice).kind, undefined);
  assert.throws(() => f.service.validateLocal({ ...alice, kind: 'robot' as never }));
});

test('callback binding, replay, racing callbacks, expiration, and cancellation', async () => {
  const f = fixture(),
    flow = await f.service.start(alice),
    state = new URL(flow.authorizationUrl!).searchParams.get('state')!;

  await assert.rejects(f.service.callback(state, 'stolen-browser', 'code'));
  await assert.rejects(f.service.callback('substituted-state', flow.binding, 'code'));

  const results = await Promise.allSettled(
    [1, 2].map(() => f.service.callback(state, flow.binding, 'code')),
  );

  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(f.provider.calls, 1);
  await assert.rejects(f.service.callback(state, flow.binding, 'code'));
  await f.service.approve(flow.flowId, flow.binding, alice, 'unlisted', true);
  assert.equal((await f.service.mine(alice)).length, 0);
  const expired = await f.pending();

  f.advance(600000);
  await assert.rejects(f.service.approve(expired.flowId, expired.binding, alice, 'public'));
});

test('sharing is opt-in, hashed, read-only, rotated atomically, and expires separately', async () => {
  const f = fixture(),
    { id } = await f.connect();

  await assert.rejects(f.service.read(id));
  await assert.rejects(f.service.read(id, bob));
  assert.equal((await f.service.read(id, alice)).visibility, 'unlisted');
  assert.equal((await f.storage.transaction((tx) => tx.list('shares'))).length, 0);
  await assert.rejects(f.service.share(id, bob));
  await assert.rejects(f.service.revoke(id, bob));

  const share = (await f.service.share(id, alice))!,
    token = share.url.split('/').at(-1)!;

  assert.equal(Buffer.from(token, 'base64url').length, 32);
  assert.ok(!JSON.stringify([...f.storage.rows.values()]).includes(token));
  assert.equal((await f.service.shared(token)).status, 'verified');
  f.advance(1000);
  assert.equal((await f.service.shared(token)).status, 'expired');
  const links = await Promise.all([1, 2].map(() => f.service.share(id, alice)));

  await assert.rejects(f.service.shared(token));
  await assert.rejects(f.service.shared(links[0]!.url.split('/').at(-1)!));
  const active = links[1]!.url.split('/').at(-1)!;

  assert.equal((await f.service.shared(active)).status, 'expired');
  f.advance(2000);
  await assert.rejects(f.service.shared(active));
  const newest = (await f.service.share(id, alice))!.url.split('/').at(-1)!;

  await f.service.share(id, alice, true);
  await assert.rejects(f.service.shared(newest));
  assert.equal((await f.service.read(id, alice)).status, 'expired');
});

test('local revocation invalidates shares and cannot be reversed by approval retry', async () => {
  const f = fixture(),
    flow = await f.connect();

  const token = (await f.service.share(flow.id, alice))!.url.split('/').at(-1)!;

  await f.service.revoke(flow.id, alice);
  await assert.rejects(f.service.shared(token));
  await f.service.approve(flow.flowId, flow.binding, alice, 'public');
  assert.equal((await f.service.read(flow.id, alice)).status, 'revoked');
  await assert.rejects(f.service.share(flow.id, alice));
});

test('external revocation requires fresh authentication by the same stable provider account', async () => {
  const f = fixture(),
    { id } = await f.connect('public');

  const wrong = await f.service.start(undefined, id, 'revoke');

  f.provider.externalId = '99';

  await f.service.callback(
    new URL(wrong.authorizationUrl!).searchParams.get('state')!,
    wrong.binding,
    'code',
  );

  assert.equal((await f.service.flow(wrong.flowId, wrong.binding)).phase, 'failed');
  await assert.rejects(f.service.approve(wrong.flowId, wrong.binding, undefined, 'unlisted'));
  f.provider.externalId = '42';
  const right = await f.service.start(undefined, id, 'revoke');

  await f.service.callback(
    new URL(right.authorizationUrl!).searchParams.get('state')!,
    right.binding,
    'code',
  );

  await f.service.approve(right.flowId, right.binding, undefined, 'unlisted');
  assert.equal((await f.service.read(id)).status, 'revoked');
});

test('visibility changes require owner and external reauthentication, invalidate shares, preserve evidence', async () => {
  const f = fixture(),
    { id } = await f.connect();

  const initial = await f.service.read(id, alice),
    token = (await f.service.share(id, alice))!.url.split('/').at(-1)!;

  await assert.rejects(f.service.start(bob, id, 'visibility'));
  const flow = await f.service.start(alice, id, 'visibility');

  await assert.rejects(f.service.approve(flow.flowId, flow.binding, alice, 'public'));

  await f.service.callback(
    new URL(flow.authorizationUrl!).searchParams.get('state')!,
    flow.binding,
    'code',
  );

  await f.service.approve(flow.flowId, flow.binding, alice, 'public');
  const after = await f.service.read(id);

  assert.equal(after.approvedAt, initial.approvedAt);
  assert.deepEqual(after.external, initial.external);
  await assert.rejects(f.service.shared(token));
});

test('provider denial/failure and profile substitution create no connection', async () => {
  const provider = fakeProvider(),
    f = fixture(provider);

  await assert.rejects(f.service.start({ ...alice, profileUrl: 'https://evil.test/1' }));
  const flow = await f.service.start(alice);

  await f.service.callback(
    new URL(flow.authorizationUrl!).searchParams.get('state')!,
    flow.binding,
  );

  assert.equal((await f.service.flow(flow.flowId, flow.binding)).phase, 'cancelled');

  provider.authenticate = async () => {
    throw new Error('secret provider error');
  };

  const failed = await f.pending();

  assert.equal((await f.service.flow(failed.flowId, failed.binding)).phase, 'failed');
  assert.deepEqual(await f.service.mine(alice), []);
});

test('external holder can revoke only the sharing link without disconnecting', async () => {
  const f = fixture(),
    { id } = await f.connect();

  const token = (await f.service.share(id, alice))!.url.split('/').at(-1)!;
  const flow = await f.service.start(undefined, id, 'share-revoke');

  await f.service.callback(
    new URL(flow.authorizationUrl!).searchParams.get('state')!,
    flow.binding,
    'code',
  );

  await f.service.approve(flow.flowId, flow.binding, undefined, 'unlisted');
  await assert.rejects(f.service.shared(token));
  assert.equal((await f.service.read(id, alice)).status, 'verified');
});

test('short-lived sharing link expires while verification remains current', async () => {
  const f = fixture();

  f.service.options.shareTtlMs = 100;
  const { id } = await f.connect();
  const token = (await f.service.share(id, alice))!.url.split('/').at(-1)!;

  f.advance(100);
  await assert.rejects(f.service.shared(token));
  assert.equal((await f.service.read(id, alice)).status, 'verified');
});

test('maintenance removes expired flow secrets and history after retention', async () => {
  const f = fixture(),
    { id } = await f.connect('public');

  f.advance(600001);
  await f.service.prune();
  assert.equal((await f.storage.transaction((tx) => tx.list('flows'))).length, 0);
  assert.equal((await f.service.read(id)).status, 'expired');
  await f.service.prune(0);
  await assert.rejects(f.service.read(id));
  assert.equal((await f.storage.transaction((tx) => tx.list('audit'))).length, 0);
});

test('renewal extends the same record, so published embeds and evidence urls survive', async () => {
  const f = fixture(),
    { id } = await f.connect();

  const before = await f.service.read(id, alice);
  const token = (await f.service.share(id, alice))!.url.split('/').at(-1)!;

  // Only the subject's owner may start a renewal.
  await assert.rejects(f.service.start(bob, id, 'renew'));
  f.advance(600);

  const flow = await f.service.start(alice, id, 'renew');

  // Fresh provider authentication is still required before approval.
  await assert.rejects(f.service.approve(flow.flowId, flow.binding, alice, 'public'));

  await f.service.callback(
    new URL(flow.authorizationUrl!).searchParams.get('state')!,
    flow.binding,
    'code',
  );

  // Approving with 'public' must not broaden an unlisted link: that needs its own flow.
  const renewed = await f.service.approve(flow.flowId, flow.binding, alice, 'public');

  assert.equal(renewed, id, 'the connection id is unchanged');

  const after = await f.service.read(id, alice);

  assert.equal(after.visibility, 'unlisted');
  assert.equal(after.visibilityApprovedAt, before.visibilityApprovedAt);

  assert.ok(after.expiresAt > before.expiresAt, 'validity is extended');
  assert.ok(after.approvedAt > before.approvedAt);
  assert.equal(after.status, 'verified');
  assert.equal(after.evidenceUrl, before.evidenceUrl, 'published evidence urls still resolve');

  // Link expiry is independent of verification expiry, so the share survives.
  assert.equal((await f.service.shared(token)).id, id);

  // A revoked connection cannot be brought back by renewing it.
  await f.service.revoke(id, alice);
  await assert.rejects(f.service.start(alice, id, 'renew'));
});

test('published evidence lists only current public connections, never unlisted or dead ones', async () => {
  const f = fixture(),
    unlisted = await f.connect(),
    shown = await f.connect('public'),
    dropped = await f.connect('public');

  assert.deepEqual(
    (await f.service.published()).map((e) => e.id).sort(),
    [shown.id, dropped.id].sort(),
  );

  // A revoked connection leaves the listing, so an embed following it stops showing it.
  await f.service.revoke(dropped.id, alice);

  assert.deepEqual(
    (await f.service.published()).map((e) => e.id),
    [shown.id],
  );

  // Unlisted records must not appear in any directory listing.
  assert.ok(!(await f.service.published()).some((e) => e.id === unlisted.id));

  // Expiry removes it too: the listing is current connections, not history.
  f.advance(2000);
  assert.deepEqual(await f.service.published(), []);
});

test('each side records how it was attested, and only re-establishing a side reconfirms it', async () => {
  const f = fixture(),
    { id } = await f.connect();

  const initial = (await f.service.read(id, alice)).attestations!;

  // The site is the only authority on its own namespace, so it declares that side.
  assert.deepEqual(initial.local, { by: 'backend', method: 'declared', confirmedAt: 1000000 });

  // The provider establishes the other side by whatever method its implementation uses,
  // and an implementation that does not say which is the redirect flow.
  assert.deepEqual(initial.external, [{ by: 'provider', method: 'oauth', confirmedAt: 1000000 }]);

  // A visibility change re-establishes neither side, so it must not restate either.
  f.advance(500);
  const visibility = await f.service.start(alice, id, 'visibility');

  await f.service.callback(
    new URL(visibility.authorizationUrl!).searchParams.get('state')!,
    visibility.binding,
    'code',
  );

  await f.service.approve(visibility.flowId, visibility.binding, alice, 'public');
  assert.deepEqual((await f.service.read(id)).attestations, initial);

  // A renewal re-establishes both: the holder reauthenticated and the site reasserted.
  f.advance(500);
  const renew = await f.service.start(alice, id, 'renew');

  await f.service.callback(
    new URL(renew.authorizationUrl!).searchParams.get('state')!,
    renew.binding,
    'code',
  );

  await f.service.approve(renew.flowId, renew.binding, alice, 'public');
  const renewed = (await f.service.read(id)).attestations!;

  assert.ok(renewed.local.confirmedAt > initial.local.confirmedAt);
  assert.ok(renewed.external[0].confirmedAt > initial.external[0].confirmedAt);
});

test('a provider naming its own method has it recorded, and older records infer theirs', async () => {
  const f = fixture();
  const { id } = await f.connect('public');

  assert.equal((await f.service.read(id)).attestations!.external[0].method, 'oauth');
  assert.equal((await f.service.read(id)).provider, f.provider.id);

  // Records stored before methods were kept still have a knowable method: the site
  // declared its subject and the only flow ever built was the provider redirect.
  await f.storage.transaction(async (tx) => {
    const stored = (await tx.get('connections', id))!;

    delete stored.attestations;
    await tx.put('connections', id, stored);
  });

  const inferred = (await f.service.read(id)).attestations!;

  assert.deepEqual(inferred.local, { by: 'backend', method: 'declared', confirmedAt: 1000000 });
  assert.deepEqual(inferred.external, [{ by: 'provider', method: 'oauth', confirmedAt: 1000000 }]);
});

test('a record from before external was a list reads as one, main method first', async () => {
  const f = fixture();
  const { id } = await f.connect('public');
  const oauth = { by: 'provider', method: 'oauth', confirmedAt: 1000000 } as const;

  const backlink = {
    by: 'provider',
    method: 'backlink',
    artifactUrl: 'https://github.com/alice',
    confirmedAt: 1000000,
  } as const;

  await f.storage.transaction(async (tx) => {
    const stored = (await tx.get('connections', id))!;

    // The shape it was stored in then: the main method alone, the rest beside it.
    (stored as { attestations: unknown }).attestations = {
      local: stored.attestations!.local,
      external: oauth,
      further: [backlink],
    };

    await tx.put('connections', id, stored);
  });

  assert.deepEqual((await f.service.read(id)).attestations!.external, [oauth, backlink]);
});

test('a holder-paced proof is published, read back, and kept open for the reader', async () => {
  const provider = fakeArtifactProvider();
  const f = fixture(provider);

  const flow = await f.service.start(alice);

  // Nothing to redirect to: the holder publishes first, at their own pace.
  assert.equal(flow.authorizationUrl, undefined);
  assert.match(flow.expect!, /^Verity proof for Site: /);
  assert.match(written(flow.instructions!), /Publish this line/);

  // Naming the site in the line means the holder sees what they are agreeing to.
  assert.ok(written(flow.instructions!).includes(flow.expect!));

  // A second flow cannot be completed with the first flow's artifact.
  const other = await f.service.start(alice);

  assert.notEqual(other.expect, flow.expect);

  const url = 'https://notes.test/alice/1';

  provider.artifacts.set(url, other.expect!);
  await f.service.submit(flow.flowId, flow.binding, url);
  assert.equal((await f.service.flow(flow.flowId, flow.binding)).phase, 'failed');
  assert.equal((await f.service.flow(flow.flowId, flow.binding)).reason, 'Line not found');

  // A failed check is dead rather than retryable in place.
  provider.artifacts.set(url, flow.expect!);
  await assert.rejects(f.service.submit(flow.flowId, flow.binding, url));

  const good = await f.service.start(alice);

  provider.artifacts.set(url, good.expect!);
  await f.service.submit(good.flowId, good.binding, url);
  assert.equal((await f.service.flow(good.flowId, good.binding)).phase, 'approval');

  const id = (await f.service.approve(good.flowId, good.binding, alice, 'public'))!;
  const evidence = await f.service.read(id);

  // The proof stays open: where it is, what should be there, and when it was read.
  assert.deepEqual(evidence.attestations!.external[0], {
    by: 'provider',
    method: 'attestation',
    artifactUrl: url,
    expect: good.expect,
    confirmedAt: 1000000,
  });

  // The local side is still the site's own statement, whatever the other side used.
  assert.equal(evidence.attestations!.local.method, 'declared');
});

test('an artifact flow refuses a location the provider will not accept', async () => {
  const provider = fakeArtifactProvider();
  const f = fixture(provider);

  const flow = await f.service.start(alice);

  provider.artifacts.set('https://evil.test/alice', flow.expect!);
  await f.service.submit(flow.flowId, flow.binding, 'https://evil.test/alice');

  assert.equal((await f.service.flow(flow.flowId, flow.binding)).phase, 'failed');
  // Only a Refused reason is the holder's to read; any other error stays with the backend.
  assert.equal((await f.service.flow(flow.flowId, flow.binding)).reason, undefined);
  assert.deepEqual(await f.service.mine(alice), []);
});

test('a redirect provider has no submit path and an artifact provider no callback', async () => {
  const redirect = fixture();
  const flow = await redirect.service.start(alice);

  await assert.rejects(redirect.service.submit(flow.flowId, flow.binding, 'https://notes.test/a'));

  const provider = fakeArtifactProvider();
  const artifact = fixture(provider);
  const started = await artifact.service.start(alice);

  assert.equal(started.authorizationUrl, undefined);
});

/** A connection whose external side is a published proof, ready to be read again. */
async function proved(extra: Partial<ServiceOptions> = {}) {
  const provider = fakeArtifactProvider();

  const f = fixture(provider, {
    validityMs: 1000000,
    recheckMs: 1000,
    freshnessMs: 5000,
    recheckTimeoutMs: 50,
    ...extra,
  });

  const url = 'https://notes.test/alice/1';
  const flow = await f.service.start(alice);

  provider.artifacts.set(url, flow.expect!);
  await f.service.submit(flow.flowId, flow.binding, url);

  const id = (await f.service.approve(flow.flowId, flow.binding, alice, 'public'))!;

  return { ...f, provider, url, id };
}

test('a published proof is read again on a schedule and carries the time forward', async () => {
  const f = await proved();

  // Just confirmed, so there is nothing to do yet and no request is spent.
  assert.equal(await f.service.recheck(), 0);
  assert.equal(f.provider.calls, 1);

  f.advance(1000);
  assert.equal(await f.service.recheck(), 1);

  const evidence = await f.service.read(f.id);

  assert.equal(evidence.status, 'verified');
  assert.equal(evidence.attestations!.external[0].confirmedAt, 1001000);

  // For an artifact method this is when it was last confirmed, not first seen.
  assert.equal(evidence.authenticatedAt, 1001000);
});

test('a proof that stops resolving ages out of verified and returns when it does', async () => {
  const f = await proved();

  f.provider.artifacts.delete(f.url);
  f.advance(1000);

  // One failed read is not evidence the proof is gone, so nothing is written.
  assert.equal(await f.service.recheck(), 0);
  assert.equal((await f.service.read(f.id)).status, 'verified');

  f.advance(4000);
  assert.equal((await f.service.read(f.id)).status, 'expired');
  assert.deepEqual(await f.service.published(), []);

  // Nothing was revoked, so republishing the proof restores the connection.
  f.provider.artifacts.set(f.url, (await f.service.read(f.id)).attestations!.external[0].expect!);
  assert.equal(await f.service.recheck(), 1);
  assert.equal((await f.service.read(f.id)).status, 'verified');
  assert.equal((await f.service.published()).length, 1);
});

test('a sign-in never goes stale, and a revoked or expired proof is not read again', async () => {
  const signedIn = fixture(fakeProvider(), {
    validityMs: 1000000,
    recheckMs: 1000,
    freshnessMs: 5000,
  });

  const flow = await signedIn.connect('public');

  signedIn.advance(500000);
  assert.equal((await signedIn.service.read(flow.id)).status, 'verified');

  // A redirect provider has no artifact to read, so the pass is a no-op for it.
  assert.equal(await signedIn.service.recheck(), 0);

  const revoked = await proved();

  await revoked.service.revoke(revoked.id, alice);
  revoked.advance(1000);
  assert.equal(await revoked.service.recheck(), 0);
  assert.equal(revoked.provider.calls, 1);

  const lapsed = await proved({ validityMs: 2000 });

  lapsed.advance(3000);
  assert.equal(await lapsed.service.recheck(), 0);
  assert.equal(lapsed.provider.calls, 1);
});

test('a reread that names a different account confirms nothing', async () => {
  const f = await proved();

  f.provider.externalId = 'someone-else';
  f.advance(1000);

  assert.equal(await f.service.recheck(), 0);
  assert.equal((await f.service.read(f.id)).attestations!.external[0].confirmedAt, 1000000);

  f.advance(4000);
  assert.equal((await f.service.read(f.id)).status, 'expired');
});

test('a provider that never answers does not hold up the run', async () => {
  const f = await proved();

  f.provider.verify = () => new Promise(() => {});
  f.advance(1000);

  assert.equal(await f.service.recheck(), 0);
  assert.equal((await f.service.read(f.id)).attestations!.external[0].confirmedAt, 1000000);
});

test('each run spends a bounded number of requests, oldest proof first', async () => {
  const f = await proved();
  const ids = [f.id];

  // Three more proofs, each confirmed a second after the one before it.
  for (const n of [2, 3, 4]) {
    const url = `https://notes.test/alice/${n}`;

    f.advance(1000);

    const flow = await f.service.start(alice);

    f.provider.artifacts.set(url, flow.expect!);
    await f.service.submit(flow.flowId, flow.binding, url);
    ids.push((await f.service.approve(flow.flowId, flow.binding, alice, 'public'))!);
  }

  const before = f.provider.calls;

  f.advance(1000);
  assert.equal(await f.service.recheck(2), 2);
  assert.equal(f.provider.calls - before, 2);

  const confirmed = await Promise.all(
    ids.map(async (id) => (await f.service.read(id)).attestations!.external[0].confirmedAt),
  );

  // The two longest unread went first; the others keep the times they already had.
  assert.deepEqual(confirmed, [1004000, 1004000, 1002000, 1003000]);
});

test('freshness must outlast the schedule meant to keep it', () => {
  assert.throws(() => fixture(fakeArtifactProvider(), { recheckMs: 5000, freshnessMs: 5000 }));
  assert.doesNotThrow(() => fixture(fakeArtifactProvider(), { freshnessMs: Infinity }));
});

/** A connection whose proof this backend holds, so there is nothing to go missing. */
async function held(extra: Partial<ServiceOptions> = {}) {
  const provider = fakeDocumentProvider();

  const f = fixture(provider, {
    validityMs: 1000000,
    recheckMs: 1000,
    freshnessMs: 5000,
    recheckTimeoutMs: 50,
    ...extra,
  });

  const flow = await f.service.start(alice);

  await f.service.submit(flow.flowId, flow.binding, `signed: ${flow.expect}`);

  const id = (await f.service.approve(flow.flowId, flow.binding, alice, 'public'))!;

  return { ...f, provider, id };
}

test('a proof handed over is published here and addressed by the connection it proves', async () => {
  const f = await held();
  const evidence = await f.service.read(f.id);

  assert.deepEqual(evidence.attestations!.external[0], {
    by: 'provider',
    method: 'signature',
    artifactUrl: `https://site.test/api/verity/connections/${f.id}/proof`,
    expect: evidence.attestations!.external[0].expect,
    hosted: true,
    confirmedAt: 1000000,
  });

  // The proof itself is readable, which is the whole point of holding it.
  assert.match(await f.service.proof(f.id), /^signed: Verity proof for Site: /);

  // An unlisted record's proof is the holder's to hand out, exactly like its evidence.
  const unlisted = await held();
  const secret = await unlisted.service.start(alice);

  await unlisted.service.submit(secret.flowId, secret.binding, `signed: ${secret.expect}`);

  const id = (await unlisted.service.approve(secret.flowId, secret.binding, alice, 'unlisted'))!;

  await assert.rejects(unlisted.service.proof(id));
  assert.match(await unlisted.service.proof(id, alice), /^signed: /);
});

test('a proof this backend holds never goes stale, however long nobody asks', async () => {
  const f = await held();

  // Far past any freshness bound: a document that cannot go missing cannot go unread.
  f.advance(500000);
  assert.equal((await f.service.read(f.id)).status, 'verified');
  assert.equal((await f.service.published()).length, 1);
});

test('a withdrawn identity revokes the connection rather than ageing it out', async () => {
  const f = await held();

  f.advance(1000);
  assert.equal(await f.service.recheck(), 1);
  assert.equal(f.provider.calls, 1);
  assert.equal((await f.service.read(f.id)).status, 'verified');

  // An unreachable keyserver says nothing, so nothing is written and nothing changes.
  f.provider.fail = true;
  f.advance(1000);
  assert.equal(await f.service.recheck(), 0);
  assert.equal((await f.service.read(f.id)).status, 'verified');

  // The holder withdrawing the identity is a choice, so the connection is revoked and
  // stays revoked: unlike staleness, this does not reverse on the next run.
  f.provider.fail = false;
  f.provider.gone = true;
  f.advance(1000);
  assert.equal(await f.service.recheck(), 0);

  const evidence = await f.service.read(f.id);

  assert.equal(evidence.status, 'revoked');
  assert.equal(evidence.revokedAt, 1003000);
  assert.deepEqual(await f.service.published(), []);

  // Already revoked, so there is nothing left to ask about.
  const before = f.provider.calls;

  f.advance(1000);
  assert.equal(await f.service.recheck(), 0);
  assert.equal(f.provider.calls, before);
});

test('a method with nowhere to ask about withdrawal does not pretend to look', async () => {
  const provider = fakeDocumentProvider();

  delete (provider as { withdrawn?: unknown }).withdrawn;

  const f = fixture(provider, { validityMs: 1000000, recheckMs: 1000, freshnessMs: 5000 });
  const flow = await f.service.start(alice);

  await f.service.submit(flow.flowId, flow.binding, `signed: ${flow.expect}`);
  await f.service.approve(flow.flowId, flow.binding, alice, 'public');
  f.advance(500000);

  assert.equal(await f.service.recheck(), 0);
  assert.equal((await f.service.published()).length, 1);
});
