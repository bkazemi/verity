import { logoPaths, logoViewBox } from '../logo.js';

/** The logotype, drawn as nodes: nothing in the badge sets innerHTML. */
export function verityLogo(): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');

  svg.setAttribute('viewBox', logoViewBox);
  svg.setAttribute('class', 'logo');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Verity');

  for (const { d, fill } of logoPaths) {
    const path = document.createElementNS(namespace, 'path');

    path.setAttribute('d', d);
    path.setAttribute('fill', fill);
    svg.append(path);
  }

  return svg;
}
