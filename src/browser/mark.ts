/** V2: the green check fills its section of the symmetric red V. */
export function verificationMark(inverted = false): SVGSVGElement {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');

  svg.setAttribute('viewBox', '-4 -4 264 264');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('class', 'mark');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const colors = inverted ? ['#149766', '#D3444C'] : ['#D3444C', '#149766'];

  for (const [layer, color] of colors.entries()) {
    const path = document.createElementNS(namespace, 'path');

    path.setAttribute('d', 'M40 36 128 220 216 36');
    path.setAttribute('stroke', color);
    path.setAttribute('stroke-width', '32');
    path.setAttribute('stroke-linejoin', 'miter');

    if (layer === 1) {
      path.setAttribute('pathLength', '176');
      path.setAttribute('stroke-dasharray', '108 176');
      path.setAttribute('stroke-dashoffset', '-54');
    }

    svg.append(path);
  }

  return svg;
}
