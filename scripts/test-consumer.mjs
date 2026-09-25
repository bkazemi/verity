import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const directory = mkdtempSync(join(tmpdir(), 'verity-consumer-'));

const run = (args, cwd = directory) =>
  execFileSync('npm', [...args, '--cache', '/tmp/verity-npm-cache'], { cwd, encoding: 'utf8' });

try {
  const pack = JSON.parse(run(['pack', '--json', '--pack-destination', directory], process.cwd()));

  writeFileSync(
    join(directory, 'package.json'),
    '{"name":"standalone-consumer","private":true,"type":"module"}',
  );

  run([
    'install',
    ...(Array.isArray(pack) ? pack : Object.values(pack)).map((entry) =>
      join(directory, entry.filename),
    ),
    '--ignore-scripts',
  ]);

  writeFileSync(
    join(directory, 'consumer.mjs'),
    `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { createVerity, githubProvider, githubLinkProvider, linkProvider, PostgresStorage, status, init } from 'verity';
    assert.equal(typeof createVerity, 'function'); assert.equal(typeof githubProvider, 'function');
    assert.equal(typeof linkProvider, 'function');
    assert.equal(githubLinkProvider().id, 'github');
    assert.equal(typeof PostgresStorage, 'function'); assert.equal(typeof status, 'function'); assert.equal(typeof init, 'function');
    console.log(createRequire(import.meta.url).resolve('verity/verity.js'));
  `,
  );

  writeFileSync(
    join(directory, 'consumer.ts'),
    `
    import { createVerity, PostgresStorage, Pool, init, type ServerOptions, type Evidence, type Storage } from 'verity';
    const storage: Storage = new PostgresStorage(new Pool());
    const create: (options: ServerOptions) => ReturnType<typeof createVerity> = createVerity;
    const client = init({ backendUrl: '/api/verity' });
    const evidence: Promise<Evidence> = client.getConnection('example');
    void [storage, create, evidence];
  `,
  );

  execFileSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      'consumer.ts',
    ],
    { cwd: directory, stdio: 'pipe' },
  );

  writeFileSync(
    join(directory, 'browser.ts'),
    `
    import { init, type Evidence } from 'verity';
    const client = init({ backendUrl: '/api/verity' });
    const evidence: Promise<Evidence> = client.getConnection('example');
    void evidence;
    // @ts-expect-error Server APIs must not be offered by the browser entry point.
    import { createVerity } from 'verity';
  `,
  );

  execFileSync(
    process.execPath,
    [
      resolve('node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'ESNext',
      '--moduleResolution',
      'Bundler',
      '--customConditions',
      'browser',
      'browser.ts',
    ],
    { cwd: directory, stdio: 'pipe' },
  );

  writeFileSync(join(directory, 'browser.mjs'), `export { init } from 'verity';`);

  const browserBundle = await build({
    absWorkingDir: directory,
    entryPoints: ['browser.mjs'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'Consumer',
    write: false,
    metafile: true,
  });

  const inputs = Object.keys(browserBundle.metafile.inputs);

  assert.ok(inputs.some((path) => path.endsWith('/dist/browser.js')));
  assert.ok(!inputs.some((path) => /\/(server|postgres)\/|node_modules\/pg(?:-|\/)/.test(path)));
  const browserContext = vm.createContext({});

  vm.runInContext(browserBundle.outputFiles[0].text, browserContext);
  assert.equal(typeof browserContext.Consumer.init, 'function');

  const assetPath = execFileSync(process.execPath, ['consumer.mjs'], {
    cwd: directory,
    encoding: 'utf8',
  }).trim();

  const asset = readFileSync(assetPath, 'utf8');

  assert.ok(!/client_secret|access_token|node:crypto|pg_advisory|require\(/.test(asset));
  const elements = new Map();

  const context = vm.createContext({
    HTMLElement: class {},
    customElements: {
      get: (key) => elements.get(key),
      define: (key, value) => elements.set(key, value),
    },
  });

  vm.runInContext(asset, context);
  assert.equal(typeof context.Verity.init, 'function');
  assert.ok(elements.has('verity-badge'));
  console.log('Separate consumer imports and browser asset passed.');
} finally {
  rmSync(directory, { recursive: true, force: true });
}
