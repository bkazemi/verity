const namespace = 'http://www.w3.org/2000/svg';

function mark(): SVGSVGElement {
  const svg = document.createElementNS(namespace, 'svg');

  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', 'provider');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  return svg;
}

/** GitHub mark from Primer Octicons (MIT); license in docs/licenses/octicons.txt. */
function github(): SVGSVGElement {
  const svg = mark();
  const path = document.createElementNS(namespace, 'path');

  svg.setAttribute('fill', 'currentColor');

  path.setAttribute(
    'd',
    'M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656',
  );

  svg.append(path);

  return svg;
}

/**
 * A key, drawn here rather than taken from anywhere. It is not the OpenPGP logo: that mark
 * is somebody's to license and this repository does not ship artwork it cannot account for.
 * A key is also the truer picture, since what was proved is control of one, not membership
 * of an organisation.
 */
function key(): SVGSVGElement {
  const svg = mark();

  svg.setAttribute('fill', 'none');

  for (const d of [
    'M7.4 8.6a3.3 3.3 0 1 0-4.7 4.7 3.3 3.3 0 0 0 4.7-4.7Z',
    'M7.4 8.6 14 2',
    'M11.2 4.8l1.6 1.6',
    'M9.4 6.6l1.6 1.6',
  ]) {
    const path = document.createElementNS(namespace, 'path');

    path.setAttribute('d', d);
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.append(path);
  }

  return svg;
}

/**
 * The mark for a provider, or nothing where there is none. Returning nothing rather than
 * the provider's name keeps this to one job: a caller that also writes the name would
 * otherwise print it twice, and only the caller knows where the name belongs.
 */
export function providerMark(provider: string): SVGSVGElement | undefined {
  const marks: Record<string, () => SVGSVGElement> = { github, openpgp: key };

  return marks[provider]?.();
}
