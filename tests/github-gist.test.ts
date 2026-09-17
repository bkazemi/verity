import { test } from 'node:test';
import assert from 'node:assert/strict';
import { githubGistProvider } from '../src/server/github-gist.js';

const expect = 'Verity proof for site.test: token';

function provider(gist: unknown, ok = true) {
  const calls: string[] = [];

  const instance = githubGistProvider({
    fetch: ((url: string) => {
      calls.push(String(url));

      return Promise.resolve({ ok, json: () => Promise.resolve(gist) });
    }) as unknown as typeof fetch,
  });

  return { instance, calls };
}

const valid = {
  public: true,
  owner: { id: 42, login: 'alice' },
  files: { 'proof.md': { content: `hello\n${expect}\n` } },
};

test('a public gist containing the line identifies the account that published it', async () => {
  const { instance, calls } = provider(valid);

  assert.deepEqual(
    await instance.verify({
      artifactUrl: 'https://gist.github.com/alice/0123456789abcdef01234567',
      expect,
    }),
    { id: '42', handle: 'alice', profileUrl: 'https://github.com/alice' },
  );

  // Read through the API by id, never by fetching the address the holder supplied.
  assert.deepEqual(calls, ['https://api.github.com/gists/0123456789abcdef01234567']);
  assert.match(instance.instructions(expect), /public gist/);
  assert.ok(instance.instructions(expect).includes(expect));
});

test('the holder cannot point the check at anything but a gist', async () => {
  for (const artifactUrl of [
    'https://evil.test/0123456789abcdef01234567',
    'http://gist.github.com/alice/0123456789abcdef01234567',
    'https://gist.github.com.evil.test/0123456789abcdef01234567',
    'https://gist.github.com/alice/../../etc',
    'https://gist.github.com/alice/not-a-gist-id',
    'https://gist.github.com/',
  ]) {
    const { instance, calls } = provider(valid);

    await assert.rejects(instance.verify({ artifactUrl, expect }), `accepted ${artifactUrl}`);
    assert.deepEqual(calls, [], `fetched ${artifactUrl}`);
  }
});

test('a gist that does not prove the claim is refused', async () => {
  const url = 'https://gist.github.com/alice/0123456789abcdef01234567';

  const cases: [string, unknown][] = [
    // A secret gist proves nothing a reader could check for themselves.
    ['secret gist', { ...valid, public: false }],
    ['missing line', { ...valid, files: { 'a.md': { content: 'nothing here' } } }],
    // The part that would have matched may be the part that was cut.
    ['truncated file', { ...valid, files: { 'a.md': { content: expect, truncated: true } } }],
    ['no owner', { ...valid, owner: undefined }],
    ['anonymous gist', { ...valid, owner: { id: 0, login: 'alice' } }],
    ['invalid login', { ...valid, owner: { id: 42, login: 'alice/../bob' } }],
    ['no files', { ...valid, files: undefined }],
  ];

  for (const [name, gist] of cases) {
    const { instance } = provider(gist);

    await assert.rejects(instance.verify({ artifactUrl: url, expect }), `accepted ${name}`);
  }

  // A deleted or rate-limited gist is a failure, never a pass.
  const { instance } = provider({ message: 'Not Found' }, false);

  await assert.rejects(instance.verify({ artifactUrl: url, expect }));
});

test('a gist proving one flow does not prove another', async () => {
  const { instance } = provider(valid);

  await assert.rejects(
    instance.verify({
      artifactUrl: 'https://gist.github.com/alice/0123456789abcdef01234567',
      expect: 'Verity proof for site.test: a different token',
    }),
  );
});
