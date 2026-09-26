import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  attestationLabel,
  externalName,
  isArtifactProvider,
  localSide,
  providerMethod,
  statusLabel,
  type Attestation,
  type Attestations,
  type Evidence,
  type Flow,
  type Instruction,
  type LocalAccount,
  type Provider,
} from '../core/index.js';
import { VerityService, Unavailable, type ServiceOptions } from './service.js';
import { copyScript } from './copy.js';
import { logo } from '../logo.js';
import { stylesheet, styleVersion } from './style.js';

export { VerityService, Unavailable } from './service.js';

export { githubProvider } from './github.js';

export { githubGistProvider } from './github-gist.js';

export { linkProvider, githubLinkProvider, type LinkProviderOptions } from './link.js';

export { pgpProvider } from './pgp.js';

export type { ServiceOptions } from './service.js';

export interface ServerOptions extends ServiceOptions {
  /** Resolve identity exclusively from the adopting application's authenticated session. */
  authenticate(request: Request): Promise<LocalAccount | undefined>;
  reportUrl: string;
}

/**
 * The largest request body any route accepts. A form field is a few hundred bytes, but a
 * pasted OpenPGP key carries every certification it has ever collected and a long-lived
 * one runs to tens of kilobytes. Still small enough that the size itself costs nothing.
 */
const maxBodyBytes = 65536;

const escape = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

const page = (prefix: string, title: string, body: string) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Verity</title><link rel="stylesheet" href="${escape(prefix)}/style.css?v=${styleVersion}"><body><main>${logo}<h1>${escape(title)}</h1>${body}</main></body></html>`;

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

/**
 * A proof this backend publishes, served as the text it is so a reader can put it straight
 * into their own tools. Never rendered and never interpreted: it is somebody else's bytes.
 */
const plain = (body: string) =>
  new Response(body, {
    headers: {
      ...headers,
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'inline',
      'Access-Control-Allow-Origin': '*',
    },
  });

const redirect = (url: string, cookie?: string) =>
  new Response(null, {
    status: 303,
    headers: { ...headers, Location: url, ...(cookie ? { 'Set-Cookie': cookie } : {}) },
  });

/**
 * One side of a link, with each thing known about it on its own line. A name, the
 * identifier behind it and how it was shown are three separate claims, and a reader
 * running them together in one sentence is the way to misread which was established.
 *
 * Both sides render as the same card, so the pair reads as a pair.
 */
function card(
  heading: string,
  name: string,
  url: string | undefined,
  reference?: string,
  ...extra: string[]
) {
  const profile = url && safeUrl(url);

  return `<div class="side"><p class="who">${escape(heading)}</p><p class="name">${
    profile ? `<a href="${escape(profile)}" rel="noreferrer">${escape(name)}</a>` : escape(name)
  }</p>${reference ? `<p class="reference">${escape(reference)}</p>` : ''}${extra.join('')}</div>`;
}

/**
 * Names how one side was established, inside that side's card. Where the method published
 * a proof the reader can open it, which is what lets them check the claim without taking
 * this backend's word for it. Methods are named, never ranked.
 */
function attestationNote(
  attestation: Attestation | undefined,
  names: { site: string; provider: string },
  additional = false,
) {
  const label = attestation && attestationLabel(attestation.method, names);

  if (!attestation || !label) return '';

  // Set by a provider implementation from holder-supplied input, so it reaches an href
  // only after being confirmed http(s).
  const artifact = attestation.artifactUrl && safeUrl(attestation.artifactUrl);

  const how = `how${additional ? ' additional' : ''}`;

  return `<p class="${how}">${additional ? '+ ' : ''}${escape(label)}</p>${
    artifact
      ? `<p class="${how}"><a href="${escape(artifact)}" rel="noreferrer">View the proof</a></p>`
      : ''
  }`;
}

/** The external side's methods: the one it was first shown by, then each one since. */
function externalNotes(
  attestations: Attestations | undefined,
  names: { site: string; provider: string },
) {
  const [main, ...rest] = attestations?.external ?? [];

  return attestationNote(main, names) + rest.map((a) => attestationNote(a, names, true)).join('');
}

/**
 * What a holder does to use one method, for a page offering several. A single method needs
 * no such wording: continuing with the provider is all there is to choose.
 */
function methodAction(provider: Provider): string {
  const actions: Record<string, string> = {
    oauth: `Sign in with ${provider.name}`,
    attestation: `Publish a proof on ${provider.name}`,
    backlink: `Link back from ${provider.name}`,
    signature: `Sign with ${provider.name}`,
    dns: 'Add a DNS record',
    wellknown: 'Publish a file on your domain',
  };

  return actions[providerMethod(provider)] ?? `Continue with ${provider.name}`;
}

/** Names the providers on offer once each, however many ways each can be shown. */
function providerNames(providers: Provider[]): string {
  return [...new Set(providers.map((p) => p.name))].join(' or ');
}

/** Seconds are the finest thing a record measured in days can mean; milliseconds are noise. */
const moment = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Every time on the page in one list. A date inside a sentence is a date a reader has to
 * find; the times of a record belong together, where they can be compared at a glance.
 */
function times(rows: [string, number | undefined][]) {
  return `<dl>${rows
    .filter(([, time]) => time !== undefined)
    .map(([label, time]) => `<dt>${escape(label)}</dt><dd>${escape(moment(time!))}</dd>`)
    .join('')}</dl>`;
}

/**
 * What the holder is told, as the provider wrote it. A command is set as a block and never
 * reflowed: it is copied character for character, and one wrapped line is a broken command.
 */
function instructions(parts: Instruction[]) {
  return parts
    .map((part) =>
      typeof part === 'string'
        ? `<p>${escape(part)}</p>`
        : `<pre><code>${escape(part.code)}</code></pre>`,
    )
    .join('');
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

  const local = localSide(e.local, e.siteName);
  const current = e.status !== 'revoked' && e.expiresAt > Date.now();

  return page(
    base,
    `${statusLabel(e, Date.now())} connection`,
    // The heading already names the site and the card already names the subject, so the
    // site's own reference would be a third line saying the same thing. The provider's
    // identifier stays: that one is the provider's word, not the site's own wording.
    card(
      local.heading,
      local.value,
      e.local.profileUrl,
      undefined,
      attestationNote(e.attestations?.local, names),
    ) +
      card(
        names.provider,
        externalName(e.external),
        e.external.profileUrl,
        e.external.id,
        externalNotes(e.attestations, names),
      ) +
      times([
        ['Approved', e.approvedAt],
        ['Authenticated', e.authenticatedAt],
        [current ? 'Valid until' : 'Expired on', e.status === 'revoked' ? undefined : e.expiresAt],
        ['Revoked on', e.revokedAt],
        // Only a method that publishes an artifact drifts; a sign-in does not go stale.
        [
          'Last checked',
          e.attestations?.external[0].artifactUrl
            ? e.attestations.external[0].confirmedAt
            : undefined,
        ],
        ['Sharing link expires', e.linkExpiresAt],
      ]) +
      `${e.linkExpiresAt ? '<p class="fine">Anyone with this link can view and forward it.</p>' : ''}
    <p class="fine">This connection does not establish legal identity, trustworthiness, content authorship, or permanent ownership.</p>
    <p class="fine"><a href="${escape(base)}/external-revoke/${escape(e.id)}">Remove this connection using your external account</a></p>
    ${e.visibility === 'unlisted' ? `<p class="fine"><a href="${escape(base)}/external-share-revoke/${escape(e.id)}">Revoke only this sharing link using your external account</a></p>` : ''}
    <p class="fine"><a href="${escape(report)}" rel="noreferrer">Report an incorrect record</a></p>`,
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

    if (text.length > maxBodyBytes) throw new Unavailable();

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

  /**
   * The methods a page offers. A flow on an existing record stays in its namespace, so
   * where the holder is signed in that record narrows the list; removing a link from the
   * external side refuses a standing proof, which anybody can hand back.
   */
  async function offer(
    kind: Flow['kind'],
    id: string,
    user: LocalAccount | undefined,
    requested: string | null,
  ): Promise<Provider[]> {
    let namespace = requested ?? undefined;

    if (user && id) namespace = (await service.read(id, user)).provider;

    const offered = service.providers.filter(
      (p) =>
        (namespace === undefined || p.id === namespace) &&
        !(['revoke', 'share-revoke'].includes(kind) && isArtifactProvider(p) && p.expect),
    );

    if (!offered.length) throw new Unavailable();

    return offered;
  }

  /** A failure names its reason when the provider gave one meant for the holder. */
  function result(outcome: string, id = '', reason?: string) {
    return html(
      page(
        prefix,
        'Verification result',
        `<p>${escape(outcome)}</p>${reason ? `<p>${escape(reason)}.</p>` : ''}<div id="verity-result" data-outcome="${escape(outcome)}" data-id="${escape(id)}"></div><script src="${escape(prefix)}/result.js" defer></script><p>You can close this window and return to account settings.</p>`,
      ),
    );
  }

  /**
   * A redirect provider sends the holder to its own site. An artifact provider keeps them
   * here, where the flow page tells them what to publish and takes the address back.
   */
  const entry = (flow: { flowId: string; authorizationUrl?: string }) =>
    flow.authorizationUrl ?? `${prefix}/flows/${flow.flowId}`;

  async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (
      url.origin !== base.origin ||
      !(url.pathname === prefix || url.pathname.startsWith(prefix + '/'))
    )
      return html(page(prefix, 'Unavailable', ''), 404);

    const path = url.pathname.slice(prefix.length);

    try {
      if (!['GET', 'POST'].includes(request.method)) throw new Unavailable();

      // Same-origin only. No CORS. Applies to every mutation, including approval forms.
      if (request.method === 'POST' && request.headers.get('origin') !== base.origin)
        throw new Unavailable();

      if (request.method === 'GET') {
        // The one thing these pages cache, and only because its address carries its
        // version. It holds no record of anybody, so it is the one response that may sit
        // in a shared cache.
        if (path === '/style.css')
          return new Response(stylesheet, {
            headers: {
              ...headers,
              'Cache-Control':
                url.searchParams.get('v') === styleVersion
                  ? 'public, max-age=31536000, immutable'
                  : 'no-store',
              'Content-Type': 'text/css; charset=utf-8',
            },
          });

        if (path === '/copy.js')
          return new Response(copyScript, {
            headers: { ...headers, 'Content-Type': 'text/javascript' },
          });

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
          const offered = await offer(kind, id, user, url.searchParams.get('provider'));

          // One form per method. With one on offer the provider is all there is to name.
          const forms = offered
            .map(
              (p) =>
                `<form method="${kind === 'connect' ? 'get' : 'post'}" action="${escape(prefix)}/sessions"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="connectionId" value="${escape(id)}"><input type="hidden" name="provider" value="${escape(p.id)}"><input type="hidden" name="method" value="${escape(providerMethod(p))}"><button>${escape(offered.length > 1 ? methodAction(p) : `Continue with ${p.name}`)}</button></form>`,
            )
            .join('');

          return html(
            page(
              prefix,
              external
                ? 'Remove a connection'
                : kind === 'renew'
                  ? 'Renew this connection'
                  : `Verify with ${providerNames(offered)}`,
              `
            ${
              user
                ? card(
                    localSide(user, options.siteName).heading,
                    localSide(user, options.siteName).value,
                    user.profileUrl,
                  )
                : '<p>Authenticate with the matching external account to review and remove this link.</p>'
            }
            <p>Confirm the connection between this ${escape(subjectNoun(user?.kind) ?? 'site')} and your ${escape(providerNames(offered))} account.</p>
            ${kind === 'renew' && offered.length > 1 ? '<p class="fine">Renewing another way adds that method beneath the one this connection was first shown by.</p>' : ''}
            ${forms}`,
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
          const flow = await service.start(await local(request), undefined, 'connect', {
            provider: url.searchParams.get('provider') ?? undefined,
            method: url.searchParams.get('method') ?? undefined,
          });

          const cookie = `${cookieName}=${flow.binding}; HttpOnly; SameSite=Lax; Path=${prefix || '/'}; Max-Age=${Math.ceil((options.flowTtlMs ?? 600000) / 1000)}${base.protocol === 'https:' ? '; Secure' : ''}`;

          return redirect(entry(flow), cookie);
        }

        if (path.startsWith('/flows/')) {
          const flow = await service.flow(path.slice(7), binding(request));
          const provider = service.providerOf(flow);

          // Holder-paced: nothing has been proved yet, so the page says what to publish
          // and waits. The line is public by design, which is what makes it checkable.
          if (flow.phase === 'pending' && flow.expect && isArtifactProvider(provider)) {
            if (!['revoke', 'share-revoke'].includes(flow.kind))
              if ((await local(request)).id !== flow.local?.id) throw new Unavailable();

            return html(
              page(
                prefix,
                `Verify with ${provider.name}`,
                `${instructions(provider.instructions(flow.expect))}
            <form method="post" action="${escape(prefix)}/flows/${escape(flow.id)}/submit">
            ${
              provider.artifact === 'document'
                ? '<label>Your proof <textarea name="artifact" rows="14" cols="72" required></textarea></label>'
                : `<label>${provider.method === 'backlink' ? 'Address of the page carrying your link' : 'Address of your published proof'} <input name="artifact" type="url" required></label>`
            }
            <button>Check my proof</button></form>
            <p class="fine">${
              provider.method === 'backlink'
                ? 'This link is public, as is the page you point at. Anyone reading either one can follow it here.'
                : 'This line is public, as is whatever published it. Publish nothing else alongside it.'
            }</p>
            <script src="${escape(prefix)}/copy.js" defer></script>`,
              ),
            );
          }

          if (flow.phase !== 'approval') return result(flow.phase, flow.resultId, flow.reason);

          if (
            !['revoke', 'share-revoke'].includes(flow.kind) &&
            (await local(request)).id !== flow.local?.id
          )
            throw new Unavailable();

          // A second way of showing an account already linked here joins that record, whose
          // visibility was chosen when it was made and is not the holder's to rechoose here.
          const joined = await service.joining(flow);
          const kept = ['revoke', 'share-revoke', 'renew'].includes(flow.kind) || joined;

          return html(
            page(
              prefix,
              ['revoke', 'share-revoke'].includes(flow.kind)
                ? 'Remove connection'
                : flow.kind === 'renew'
                  ? 'Renew connection'
                  : joined
                    ? 'Add to connection'
                    : 'Confirm connection',
              `
            ${card(
              localSide(flow.local!, options.siteName).heading,
              localSide(flow.local!, options.siteName).value,
              flow.local!.profileUrl,
            )}
            ${card(
              provider.name,
              externalName(flow.external!),
              flow.external!.profileUrl,
              flow.external!.id,
            )}
            ${joined ? `<p>This account is already linked here. Confirming adds this method to that connection, beneath the one it was first shown by, and it stays ${escape(joined.visibility)}.</p>` : ''}
            <p class="fine">${escape(options.siteName)} receives the result. Verified via ${escape(options.verifierName)}.</p>
            <form method="post" action="${escape(prefix)}/flows/${escape(flow.id)}/approve">
            ${kept ? '<input type="hidden" name="visibility" value="unlisted">' : '<fieldset><legend>Evidence visibility</legend><label><input type="radio" name="visibility" value="unlisted" checked>Unlisted</label><p>Anyone with a sharing link can view and forward it. No link is created until you choose to share.</p><label><input type="radio" name="visibility" value="public">Public: anyone can view both sides of this link</label></fieldset>'}
            <button name="action" value="approve">${['revoke', 'share-revoke'].includes(flow.kind) ? (flow.kind === 'share-revoke' ? 'Revoke sharing link' : 'Revoke connection') : flow.kind === 'renew' ? 'Renew connection' : joined ? 'Add to connection' : 'Confirm connection'}</button>
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

        const hosted = path.match(/^\/connections\/([^/]+)\/proof$/);

        // As public as the evidence it belongs to, and checked the same way.
        if (hosted) return plain(await service.proof(hosted[1]!));

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

          const provider = service.resolve(data.provider);

          return json({
            url: `${service.baseUrl}/verify?provider=${encodeURIComponent(provider.id)}`,
          });
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
            { provider: data.provider || undefined, method: data.method || undefined },
          );

          const cookie = `${cookieName}=${flow.binding}; HttpOnly; SameSite=Lax; Path=${prefix || '/'}; Max-Age=${Math.ceil((options.flowTtlMs ?? 600000) / 1000)}${base.protocol === 'https:' ? '; Secure' : ''}`;

          return redirect(entry(flow), cookie);
        }

        const submission = path.match(/^\/flows\/([^/]+)\/submit$/);

        if (submission) {
          if (!data.artifact) throw new Unavailable();

          await service.submit(submission[1]!, binding(request), data.artifact);

          return redirect(`${prefix}/flows/${submission[1]!}`);
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
        return html(page(prefix, 'Unavailable', '<p>This resource is unavailable.</p>'), 404);

      return html(page(prefix, 'Request failed', '<p>Please try again.</p>'), 500);
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

        if (length > maxBodyBytes) {
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
