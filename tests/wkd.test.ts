import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wkdUrls } from '../src/server/wkd.js';

test('an address maps to the places its domain would publish a key', () => {
  // The vector published with the specification, which is what pins the hash and the
  // alphabet: a local part is lowercased, hashed, and encoded in Z-Base-32, never sent.
  assert.deepEqual(wkdUrls('Joe.Doe@example.org'), [
    'https://openpgpkey.example.org/.well-known/openpgpkey/example.org/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe',
    'https://example.org/.well-known/openpgpkey/hu/iy9q119eutrkn8s1mk4r39qejnbu3n5q?l=Joe.Doe',
  ]);

  // Case in the local part changes the query but never the hash.
  assert.equal(
    wkdUrls('joe.doe@example.org')[0]!.split('?')[0],
    wkdUrls('JOE.DOE@example.org')[0]!.split('?')[0],
  );

  // The domain is matched case-insensitively too.
  assert.deepEqual(wkdUrls('Joe.Doe@EXAMPLE.ORG'), wkdUrls('Joe.Doe@example.org'));
});

test('an address that would name something inside the network is not fetchable', () => {
  // The address comes off a key a stranger pasted, so it chooses the host. Anything that
  // could resolve to a machine on this side of the network answers nothing at all.
  for (const address of [
    'bob@localhost',
    'bob@printer.local',
    'bob@wiki.internal',
    'bob@host.lan',
    'bob@10.0.0.1',
    'bob@[::1]',
    'bob@192.168.1.1',
    'nodomain',
    '@example.org',
    'bob@b',
    'bob@example..org',
    'bob@-example.org',
    'bob@exam ple.org',
    `${'a'.repeat(200)}@example.org`,
  ])
    assert.deepEqual(wkdUrls(address), [], `derived a url for ${address}`);
});

test('the query carries the local part safely', () => {
  const [advanced] = wkdUrls('a+b c@example.org');

  assert.ok(advanced);
  assert.ok(advanced.includes('?l=a%2Bb%20c'));
  assert.ok(!advanced.includes(' '));
});
