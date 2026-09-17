import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  attestationLabel,
  type Attestation,
  type Evidence,
  type Flow,
  type LocalAccount,
} from '../core/index.js';
import { VerityService, Unavailable, type ServiceOptions } from './service.js';

export { VerityService, Unavailable } from './service.js';

export { githubProvider } from './github.js';

export type { ServiceOptions } from './service.js';

export interface ServerOptions extends ServiceOptions {
  /** Resolve identity exclusively from the adopting application's authenticated session. */
  authenticate(request: Request): Promise<LocalAccount | undefined>;
  reportUrl: string;
}

const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Verity</title><body><main><h1>${escape(title)}</h1>${body}</main></body></html>`;

const headers = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
};

const html = (body: string, status = 200) =>
  new Response(body, {
    status,
    headers: { ...headers, 'Content-Type': 'text/html; charset=utf-8' },
  });

const json = (data: unknown) =>
  new Response(JSON.stringify(data), {
    headers: { ...headers, 'Content-Type': 'application/json' },
  });

const redirect = (url: string, cookie?: string) =>
  new Response(null, {
    status: 303,
    headers: { ...headers, Location: url, ...(cookie ? { 'Set-Cookie': cookie } : {}) },
  });

function account(label: string, reference: string, url?: string) {
  return `${escape(label)}, ${url ? `<a href="${escape(url)}" rel="noreferrer">${escape(reference)}</a>` : escape(reference)}`;
}

/**
 * Names how one side was established, next to that side. Where the method published a
 * proof the reader can open it, which is what lets them check the claim without taking
 * this backend's word for it. Methods are named, never ranked.
 */
function attestationNote(
  attestation: Attestation | undefined,
  names: { site: string; provider: string },
) {
  const label = attestation && attestationLabel(attestation.method, names);

  if (!attestation || !label) return '';

  // Set by a provider implementation from holder-supplied input, so it reaches an href
  // only after being confirmed http(s).
  const artifact = attestation.artifactUrl && safeUrl(attestation.artifactUrl);

  return `<br>${escape(label)}.${
    artifact
      ? ` <a href="${escape(artifact)}" rel="noreferrer">View the proof</a>. Last checked: ${escape(new Date(attestation.confirmedAt).toISOString())}.`
      : ''
  }`;
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);

    return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A link's local side is one of the site's accounts, a page, or the site itself.
 * An absent kind means the site did not say, so nothing is asserted about it.
 */
function subjectNoun(kind: string | undefined): string | undefined {
  return { account: 'account', page: 'page', site: 'website' }[kind ?? ''];
}

function evidencePage(e: Evidence & { linkExpiresAt?: number }, base: string, report: string) {
  const names = { site: e.siteName, provider: e.providerName ?? e.provider };

  return page(
    `${e.status === 'verified' ? 'Verified' : e.status} connection`,
    `
    <p>${escape(e.siteName)}: ${account(e.local.label, e.local.reference, e.local.profileUrl)}${attestationNote(e.attestations?.local, names)}</p>
    <p>${escape(names.provider)}: ${account(e.external.handle, e.external.id, e.external.profileUrl)}${attestationNote(e.attestations?.external, names)}</p>
    <p>Provider authentication: ${escape(new Date(e.authenticatedAt).toISOString())}. Approval: ${escape(new Date(e.approvedAt).toISOString())}.</p>
    <p>Status: ${escape(e.status)}. Verification expiry: ${escape(new Date(e.expiresAt).toISOString())}.</p>
    ${e.linkExpiresAt ? `<p>Anyone with this link can view and forward it. Link expiry: ${escape(new Date(e.linkExpiresAt).toISOString())}.</p>` : ''}
    <p>This connection does not establish legal identity, trustworthiness, content authorship, or permanent ownership.</p>
    <p><a href="${escape(base)}/external-revoke/${escape(e.id)}">Remove this connection using your external account</a></p>
    ${e.visibility === 'unlisted' ? `<p><a href="${escape(base)}/external-share-revoke/${escape(e.id)}">Revoke only this sharing link using your external account</a></p>` : ''}
    <p><a href="${escape(report)}" rel="noreferrer">Report an incorrect record</a></p>`,
  );
}

export function createVerity(options: ServerOptions) {
  const service = new VerityService(options);

  const base = new URL(service.baseUrl),
    prefix = base.pathname.replace(/\/$/, '');

  if (!['https:', 'http:', 'mailto:'].includes(new URL(options.reportUrl).protocol))
    throw new Error('Invalid report URL');

  const cookieName = `verity_flow_${Buffer.from(prefix).toString('hex')}`;

  function binding(request: Request) {
    return (
      request.headers
        .get('cookie')
        ?.split(';')
        .map((v) => v.trim())
        .find((v) => v.startsWith(`${cookieName}=`))
        ?.slice(cookieName.length + 1) ?? ''
    );
  }

  async function local(request: Request) {
    const user = await options.authenticate(request);

    if (!user) throw new Unavailable();

    return service.validateLocal(user);
  }

  async function body(request: Request): Promise<Record<string, string>> {
    const text = await request.text();

    if (text.length > 8192) throw new Unavailable();

    if (request.headers.get('content-type')?.startsWith('application/json')) {
      const value: unknown = JSON.parse(text);

      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.values(value).some((v) => typeof v !== 'string')
      )
        throw new Unavailable();

      return value as Record<string, string>;
    }

    return Object.fromEntries(new URLSearchParams(text));
  }

  function result(outcome: string, id = '') {
    return html(
      page(
        'Verification result',
        `<p>${escape(outcome)}</p><div id="verity-result" data-outcome="${escape(outcome)}" data-id="${escape(id)}"></div><script src="${escape(prefix)}/result.js" defer></script><p>You can close this window and return to account settings.</p>`,
      ),
    );
  }

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (
      url.origin !== base.origin ||
      !(url.pathname === prefix || url.pathname.startsWith(prefix + '/'))
    )
      return html(page('Unavailable', ''), 404);

    const path = url.pathname.slice(prefix.length);

    try {
      if (!['GET', 'POST'].includes(request.method)) throw new Unavailable();

      // Same-origin only. No CORS. Applies to every mutation, including approval forms.
      if (request.method === 'POST' && request.headers.get('origin') !== base.origin)
        throw new Unavailable();

      if (request.method === 'GET') {
        if (path === '/result.js')
          return new Response(
            `const e=document.getElementById('verity-result');if(window.opener&&e){window.opener.postMessage({type:'verity-result',outcome:e.dataset.outcome,connectionId:e.dataset.id},location.origin);window.close()}`,
            { headers: { ...headers, 'Content-Type': 'text/javascript' } },
          );

        if (
          path === '/verify' ||
          path.startsWith('/external-revoke/') ||
          path.startsWith('/external-share-revoke/') ||
          path.startsWith('/visibility/') ||
          path.startsWith('/renew/')
        ) {
          const external =
            path.startsWith('/external-revoke/') || path.startsWith('/external-share-revoke/');

          const kind = external
            ? path.startsWith('/external-share-revoke/')
              ? 'share-revoke'
              : 'revoke'
            : path.startsWith('/visibility/')
              ? 'visibility'
              : path.startsWith('/renew/')
                ? 'renew'
                : 'connect';

          const user = external ? undefined : await local(request);
          const id = kind === 'connect' ? '' : path.split('/').at(-1)!;

          return html(
            page(
              external
                ? 'Remove a connection'
                : kind === 'renew'
                  ? 'Renew this connection'
                  : `Verify with ${options.provider.name}`,
              `
            ${user ? `<p>${escape(options.siteName)}: ${account(user.label, user.reference, user.profileUrl)}</p>` : '<p>Authenticate with the matching external account to review and remove this link.</p>'}
            <p>Confirm the connection between this ${escape(subjectNoun(user?.kind) ?? 'site')} and your ${escape(options.provider.name)} account.</p>
            <form method="${kind === 'connect' ? 'get' : 'post'}" action="${escape(prefix)}/sessions"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="connectionId" value="${escape(id)}"><button>Continue with ${escape(options.provider.name)}</button></form>`,
            ),
          );
        }

        if (path === '/callback') {
          const state = url.searchParams.get('state');

          if (!state) throw new Unavailable();

          const id = await service.callback(
            state,
            binding(request),
            url.searchParams.has('error') ? undefined : (url.searchParams.get('code') ?? undefined),
          );

          return redirect(`${prefix}/flows/${id}`);
        }

        if (path === '/sessions' && url.searchParams.get('kind') === 'connect') {
          const flow = await service.start(await local(request), undefined, 'connect');
          const cookie = `${cookieName}=${flow.binding}; HttpOnly; SameSite=Lax; Path=${prefix || '/'}; Max-Age=${Math.ceil((options.flowTtlMs ?? 600000) / 1000)}${base.protocol === 'https:' ? '; Secure' : ''}`;

          return redirect(flow.authorizationUrl, cookie);
        }

        if (path.startsWith('/flows/')) {
          const flow = await service.flow(path.slice(7), binding(request));

          if (flow.phase !== 'approval') return result(flow.phase, flow.resultId);

          if (
            !['revoke', 'share-revoke'].includes(flow.kind) &&
            (await local(request)).id !== flow.local?.id
          )
            throw new Unavailable();

          return html(
            page(
              ['revoke', 'share-revoke'].includes(flow.kind)
                ? 'Remove connection'
                : flow.kind === 'renew'
                  ? 'Renew connection'
                  : 'Confirm connection',
              `
            <p>${escape(options.siteName)}: ${account(flow.local!.label, flow.local!.reference, flow.local!.profileUrl)}</p>
            <p>${escape(options.provider.name)}: ${account(flow.external!.handle, flow.external!.id, flow.external!.profileUrl)}</p>
            <p>${escape(options.siteName)} receives the result. Verified via ${escape(options.verifierName)}.</p>
            <form method="post" action="${escape(prefix)}/flows/${escape(flow.id)}/approve">
            ${['revoke', 'share-revoke', 'renew'].includes(flow.kind) ? '<input type="hidden" name="visibility" value="unlisted">' : '<fieldset><legend>Evidence visibility</legend><label><input type="radio" name="visibility" value="unlisted" checked>Unlisted</label><p>Anyone with a sharing link can view and forward it. No link is created until you choose to share.</p><label><input type="radio" name="visibility" value="public">Public: anyone can view both sides of this link</label></fieldset>'}
            <button name="action" value="approve">${['revoke', 'share-revoke'].includes(flow.kind) ? (flow.kind === 'share-revoke' ? 'Revoke sharing link' : 'Revoke connection') : flow.kind === 'renew' ? 'Renew connection' : 'Confirm connection'}</button>
            <button name="action" value="cancel">Cancel</button></form><p><a href="${escape(prefix)}/verify">Use a different external account</a></p>`,
            ),
          );
        }

        // Lets a static embed track current connections without hardcoding an id.
        if (path === '/published') {
          const response = json(await service.published());

          response.headers.set('Access-Control-Allow-Origin', '*');

          return response;
        }

        if (path === '/mine') return json(await service.mine(await local(request)));

        if (path.startsWith('/s/')) {
          const evidence = await service.shared(path.slice(3));

          return url.searchParams.get('format') === 'json'
            ? json(evidence)
            : html(evidencePage(evidence, prefix, options.reportUrl));
        }

        if (path.startsWith('/connections/')) {
          const id = path.slice(13);
          // Canonical routes and widgets never use local-session privileges.
          const evidence = await service.read(id);

          if (url.searchParams.get('format') === 'json') {
            const response = json(evidence);

            // Public evidence can be embedded on static sites without credentials.
            response.headers.set('Access-Control-Allow-Origin', '*');

            return response;
          }

          return html(evidencePage(evidence, prefix, options.reportUrl));
        }

        if (path.startsWith('/manage/'))
          return json(await service.read(path.slice(8), await local(request)));
      } else {
        const data = await body(request);

        if (path === '/connect') {
          await local(request);

          if (data.provider !== options.provider.id) throw new Unavailable();

          return json({ url: `${service.baseUrl}/verify` });
        }

        if (path === '/sessions') {
          if (
            !['connect', 'renew', 'revoke', 'visibility', 'share-revoke'].includes(data.kind ?? '')
          )
            throw new Unavailable();

          const kind = data.kind as Flow['kind'];

          const flow = await service.start(
            ['revoke', 'share-revoke'].includes(kind) ? undefined : await local(request),
            data.connectionId || undefined,
            kind,
          );

          const cookie = `${cookieName}=${flow.binding}; HttpOnly; SameSite=Lax; Path=${prefix || '/'}; Max-Age=${Math.ceil((options.flowTtlMs ?? 600000) / 1000)}${base.protocol === 'https:' ? '; Secure' : ''}`;

          return redirect(flow.authorizationUrl, cookie);
        }

        const approval = path.match(/^\/flows\/([^/]+)\/approve$/);

        if (approval) {
          if (
            !['approve', 'cancel'].includes(data.action ?? '') ||
            !['public', 'unlisted'].includes(data.visibility ?? '')
          )
            throw new Unavailable();

          const flow = await service.flow(approval[1]!, binding(request));

          const id = await service.approve(
            flow.id,
            binding(request),
            ['revoke', 'share-revoke'].includes(flow.kind) ? undefined : await local(request),
            data.visibility as 'public' | 'unlisted',
            data.action === 'cancel',
          );

          return result(id ? 'complete' : 'cancelled', id);
        }

        const management = path.match(
          /^\/connections\/([^/]+)\/(disconnect|share|share-revoke|visibility)$/,
        );

        if (management) {
          const user = await local(request),
            id = management[1]!;

          if (management[2] === 'disconnect') {
            await service.revoke(id, user);

            return json({ ok: true });
          }

          if (management[2] === 'visibility') {
            await service.read(id, user);

            return json({ url: `${service.baseUrl}/visibility/${id}` });
          }

          return json(
            (await service.share(id, user, management[2] === 'share-revoke')) ?? { ok: true },
          );
        }
      }

      throw new Unavailable();
    } catch (error) {
      // Never serialize/log exceptions: provider responses and request URLs can contain secrets.
      if (error instanceof Unavailable || error instanceof SyntaxError)
        return html(page('Unavailable', '<p>This resource is unavailable.</p>'), 404);

      return html(page('Request failed', '<p>Please try again.</p>'), 500);
    }
  }

  return { service, handle };
}

/** Mount on your chosen Node router. Public origin is configured, never inferred from Host. */
export function nodeHandler(handler: (request: Request) => Promise<Response>, origin: string) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const chunks: Buffer[] = [];
      let length = 0;

      for await (const chunk of req) {
        length += chunk.length;

        if (length > 8192) {
          res.writeHead(413);
          res.end();

          return;
        }

        chunks.push(Buffer.from(chunk));
      }

      const requestHeaders = new Headers();

      for (const [key, value] of Object.entries(req.headers))
        if (value) requestHeaders.set(key, Array.isArray(value) ? value.join(', ') : value);

      const response = await handler(
        new Request(new URL(req.url ?? '/', origin), {
          method: req.method,
          headers: requestHeaders,
          ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
        }),
      );

      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      res.writeHead(500, { 'Cache-Control': 'no-store' });
      res.end('Request failed');
    }
  };
}
