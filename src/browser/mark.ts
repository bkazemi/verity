/**
 * How sure the mark is: `current` for a verification that holds, `inactive` for one that
 * does not, and `pending` for one nobody has confirmed yet, which claims nothing and is
 * drawn in the surrounding text colour.
 */
export type MarkTone = 'current' | 'inactive' | 'pending';

const tones: Record<MarkTone, [string, string]> = {
  current: ['#D3444C', '#149766'],
  inactive: ['#149766', '#D3444C'],
  pending: ['currentColor', 'currentColor'],
};

/**
 * The check draws itself in from its left end once the verification holds: when a pill's
 * mark first becomes `current`, and each time the dialog opens on a current one.
 */
export const markStyles = `
  @media (prefers-reduced-motion: no-preference) {
    .mark.current path:last-child { animation: verity-draw .8s cubic-bezier(.65, 0, .35, 1) .1s backwards; }
  }
  @keyframes verity-draw { from { stroke-dasharray: 0 176; } to { stroke-dasharray: 108 176; } }
`;

/** Repaints a mark in place, so answering a check never replaces the drawing. */
export function paintMark(svg: SVGSVGElement, tone: MarkTone): void {
  const colors = tones[tone];

  svg.setAttribute('class', `mark ${tone}`);

  for (const [layer, path] of [...svg.children].entries())
    path.setAttribute('stroke', colors[layer] ?? colors[0]);
}

/** V2: the green check fills its section of the symmetric red V. */
export function verificationMark(tone: MarkTone = 'current'): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');

  svg.setAttribute('viewBox', '-4 -4 264 264');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const layer of [0, 1]) {
    const path = document.createElementNS(namespace, 'path');

    path.setAttribute('d', 'M40 36 128 220 216 36');
    path.setAttribute('stroke-width', '32');
    path.setAttribute('stroke-linejoin', 'miter');

    if (layer === 1) {
      path.setAttribute('pathLength', '176');
      path.setAttribute('stroke-dasharray', '108 176');
      path.setAttribute('stroke-dashoffset', '-54');
    }

    svg.append(path);
  }

  paintMark(svg, tone);

  return svg;
}
