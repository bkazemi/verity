import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Evidence } from 'verity';

const require = createRequire(import.meta.url);
const asset = await readFile(require.resolve('verity/verity.js'));
const page = await readFile(new URL('./preview.html', import.meta.url));
const port = Number(process.env.PREVIEW_PORT ?? 3001);
const origin = `http://localhost:${port}`;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', origin);

  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Referrer-Policy', 'no-referrer');

  if (url.pathname === '/assets/verity.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(asset);

    return;
  }

  // The proof a key-signed connection points at, served as the text a reader would check.
  if (url.pathname === '/api/verity/connections/signed/proof') {
    response.setHeader('Content-Type', 'text/plain; charset=utf-8');

    response.end(
      `-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\nVerity proof for JoeSite: 9Qv2bXkP\n-----BEGIN PGP SIGNATURE-----\n\n(demo: not a real signature)\n-----END PGP SIGNATURE-----\n`,
    );

    return;
  }

  if (url.pathname.startsWith('/api/verity/connections/')) {
    const id = url.pathname.split('/').at(-1)!;

    if (!['current', 'signed-in', 'signed', 'unconfirmed', 'expired', 'revoked'].includes(id)) {
      response.writeHead(404);
      response.end('Unavailable');

      return;
    }

    // A published proof only holds while it is still published, so one tile shows a
    // connection whose proof has gone unread: inside its approval, outside its freshness.
    const proof = {
      by: 'provider' as const,
      method: 'attestation' as const,
      artifactUrl: 'https://gist.github.com/joe/3f8a1c9e2b7d4506a1f2',
      expect: 'Verity proof for JoeSite: 9Qv2bXkP',
      confirmedAt: Date.now() - (id === 'unconfirmed' ? 9 * 86400000 : 3600000),
    };

    // A key proves itself, so the proof is held here rather than read somewhere else, and
    // it is addressed by the connection it belongs to.
    const signature = {
      by: 'provider' as const,
      method: 'signature' as const,
      artifactUrl: `${origin}/api/verity/connections/${id}/proof`,
      expect: 'Verity proof for JoeSite: 9Qv2bXkP',
      hosted: true,
      confirmedAt: Date.now() - 3600000,
    };

    const evidence: Evidence = {
      id,
      local: { label: 'Joe', reference: 'joesite-member-1' },
      external:
        id === 'signed'
          ? {
              id: '7FDEB37E4F6EAD8E2FEFD8511347D93FEB1342AF',
              kind: 'key',
              handle: 'joe@joesite.example',
              profileUrl: `${origin}/demo`,
            }
          : { id: 'demo-account', handle: 'Joe', profileUrl: `${origin}/demo` },
      provider: id === 'signed' ? 'openpgp' : 'github',
      providerName: id === 'signed' ? 'OpenPGP' : 'GitHub',
      siteName: 'JoeSite',
      verifierName: 'JoeSite',
      visibility: 'public',
      status: ['current', 'signed-in', 'signed'].includes(id)
        ? 'verified'
        : id === 'revoked'
          ? 'revoked'
          : 'expired',
      authenticatedAt: Date.now() - 86400000,
      approvedAt: Date.now() - 86400000,
      visibilityApprovedAt: Date.now() - 86400000,
      expiresAt: ['expired', 'revoked'].includes(id) ? Date.now() - 1000 : Date.now() + 86400000,
      evidenceUrl: `${origin}/demo`,
      attestations: {
        // The site is the only authority on its own namespace, so it states this side.
        local: { by: 'backend', method: 'declared', confirmedAt: Date.now() - 86400000 },
        // The same pair proved two ways, so the preview shows both: a gist anyone can
        // open and check, and a sign-in that publishes nothing.
        external:
          id === 'signed'
            ? signature
            : ['current', 'unconfirmed'].includes(id)
              ? proof
              : { by: 'provider', method: 'oauth', confirmedAt: Date.now() - 86400000 },
        // The signed-in pair was later shown a second way too, so it lists that beneath.
        further:
          id === 'signed-in'
            ? [
                {
                  by: 'provider',
                  method: 'backlink',
                  artifactUrl: `${origin}/demo`,
                  expect: 'https://joesite.example/joe',
                  confirmedAt: Date.now() - 3600000,
                },
              ]
            : undefined,
      },
    };

    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(evidence));

    return;
  }

  response.setHeader('Content-Type', 'text/html; charset=utf-8');

  if (url.pathname === '/demo') {
    response.end(
      '<h1>Demo: simulated verification</h1><p>This preview uses fixtures. Run the full example with GitHub credentials for real verification.</p><a href="/">Back to preview</a>',
    );

    return;
  }

  response.end(page);
});

server.listen(port, '127.0.0.1', () => console.log(`Verity component preview: ${origin}`));

process.on('SIGTERM', () => server.close());
process.on('SIGINT', () => server.close());
