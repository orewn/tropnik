/** Geographic direction control for the shared custom map. The map engine owns
 * the 44px button's coordinate; only its label may move during collision layout. */
export function createDirectionMarker(
  direction: {id: string; name: string},
  ownerDocument: Document = document,
): HTMLButtonElement {
  const button = ownerDocument.createElement('button');
  button.type = 'button';
  button.className = `region-marker region-marker-${direction.id}`;
  button.dataset.regionId = direction.id;
  button.setAttribute('aria-label', `Открыть ${direction.name}`);

  const emblem = ownerDocument.createElement('span');
  emblem.className = 'region-marker-emblem';
  emblem.setAttribute('aria-hidden', 'true');

  const namespace = 'http://www.w3.org/2000/svg';
  const svg = ownerDocument.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', '0 0 24 28');
  svg.setAttribute('width', '24');
  svg.setAttribute('height', '28');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('aria-hidden', 'true');

  const flag = ownerDocument.createElementNS(namespace, 'path');
  flag.setAttribute('class', 'region-marker-flag');
  flag.setAttribute('d', 'M2 1h20v26l-10-5-10 5Z');
  flag.setAttribute('stroke-width', '1.5');
  flag.setAttribute('stroke-linejoin', 'round');

  const ridge = ownerDocument.createElementNS(namespace, 'path');
  ridge.setAttribute('class', 'region-marker-ridge');
  ridge.setAttribute('d', 'm5 17 5-8 3 5 2-3 4 6M8 12l2 1 2-1');
  ridge.setAttribute('fill', 'none');
  ridge.setAttribute('stroke-width', '1.5');
  ridge.setAttribute('stroke-linecap', 'round');
  ridge.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(flag);
  svg.appendChild(ridge);

  // Counts are deliberately separate from the SVG: regrouping must never
  // replace the geographic emblem when it updates textContent.
  const count = ownerDocument.createElement('span');
  count.className = 'region-marker-count';
  count.setAttribute('aria-hidden', 'true');
  emblem.appendChild(svg);
  emblem.appendChild(count);

  const label = ownerDocument.createElement('span');
  label.className = 'region-marker-label';
  label.textContent = direction.name;
  button.appendChild(emblem);
  button.appendChild(label);
  return button;
}
