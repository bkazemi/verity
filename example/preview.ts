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

  if (url.pathname.startsWith('/api/verity/connections/')) {
    const id = url.pathname.split('/').at(-1)!;

    if (!['current', 'signed-in', 'expired', 'revoked'].includes(id)) {
      response.writeHead(404);
      response.end('Unavailable');

      return;
    }

    const evidence: Evidence = {
      id,
      local: { label: 'Joe', reference: 'joesite-member-1' },
      external: { id: 'demo-account', handle: 'Joe', profileUrl: `${origin}/demo` },
      provider: 'github',
      providerName: 'GitHub',
      siteName: 'JoeSite',
      verifierName: 'JoeSite',
      visibility: 'public',
      status: ['current', 'signed-in'].includes(id) ? 'verified' : (id as 'expired' | 'revoked'),
      authenticatedAt: Date.now() - 86400000,
      approvedAt: Date.now() - 86400000,
      visibilityApprovedAt: Date.now() - 86400000,
      expiresAt: id === 'expired' ? Date.now() - 1000 : Date.now() + 86400000,
      evidenceUrl: `${origin}/demo`,
      attestations: {
        // The site is the only authority on its own namespace, so it states this side.
        local: { by: 'backend', method: 'declared', confirmedAt: Date.now() - 86400000 },
        // The same pair proved two ways, so the preview shows both: a gist anyone can
        // open and check, and a sign-in that publishes nothing.
        external:
          id === 'current'
            ? {
                by: 'provider',
                method: 'attestation',
                artifactUrl: 'https://gist.github.com/joe/3f8a1c9e2b7d4506a1f2',
                expect: 'Verity proof for JoeSite: 9Qv2bXkP',
                confirmedAt: Date.now() - 3600000,
              }
            : { by: 'provider', method: 'oauth', confirmedAt: Date.now() - 86400000 },
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
