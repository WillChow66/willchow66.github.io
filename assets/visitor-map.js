// Keep MapMyVisitors' live city data and hover behavior, without outbound links.
(function () {
  'use strict';
  const root = document.querySelector('#visitor-map .visitor-map-widget');
  if (!root) return;
  const markerSelector = '.jvectormap-marker, .mmvstarker';
  const tooltip = document.createElement('div');
  tooltip.className = 'visitor-map-tooltip';
  tooltip.id = 'visitor-map-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  root.append(tooltip);
  let selected = null;

  function nativeTips() {
    return [...document.querySelectorAll('.jvectormap-tip')];
  }

  function dismiss() {
    tooltip.hidden = true;
    if (selected) {
      selected.removeAttribute('aria-describedby');
      selected.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
      selected = null;
    }
    nativeTips().forEach(tip => { tip.style.display = 'none'; });
  }

  function show(marker) {
    if (selected === marker && !tooltip.hidden) return;
    dismiss();
    const box = marker.getBoundingClientRect();
    const point = { bubbles: true, clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2, view: window };
    // Let the widget produce its own label; do not invent visitor data or
    // depend on its private API. This also enables a tap or keyboard action.
    marker.dispatchEvent(new MouseEvent('mouseover', point));
    marker.dispatchEvent(new MouseEvent('mousemove', point));
    const label = nativeTips().find(tip => tip.textContent.trim() &&
      getComputedStyle(tip).display !== 'none')?.textContent.trim() ||
      marker.getAttribute('title');
    if (!label) return;
    selected = marker;
    tooltip.textContent = label;
    tooltip.hidden = false;
    marker.setAttribute('aria-label', label);
    marker.setAttribute('aria-describedby', tooltip.id);
    const bounds = root.getBoundingClientRect();
    const left = box.left + box.width / 2 - bounds.left - tooltip.offsetWidth / 2;
    tooltip.style.left = `${Math.max(0, Math.min(left, bounds.width - tooltip.offsetWidth))}px`;
    tooltip.style.top = `${box.top - bounds.top - tooltip.offsetHeight - 8}px`;
    nativeTips().forEach(tip => { tip.style.display = 'none'; });
  }

  // Capture only activation events. Pointer movement and the provider's
  // mouseover handlers continue to work normally.
  root.addEventListener('click', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
    const marker = event.target.closest?.(markerSelector) || nearestMarker(event);
    if (marker) show(marker); else dismiss();
  }, true);
  root.addEventListener('auxclick', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape') { dismiss(); return; }
    const marker = event.target.closest?.(markerSelector);
    if (marker && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      event.stopImmediatePropagation();
      show(marker);
    }
  }, true);
  root.addEventListener('pointerleave', dismiss);
  // Like a canvas hit test, accept a pointer within 10 CSS pixels of a dot.
  // Tiny markers and overlapping visits should not require pixel-perfect aim.
  function nearestMarker(event) {
    let nearest = null;
    let distance = 10 * 10;
    root.querySelectorAll(markerSelector).forEach(marker => {
      const box = marker.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const dx = event.clientX - box.left - box.width / 2;
      const dy = event.clientY - box.top - box.height / 2;
      const candidate = dx * dx + dy * dy;
      if (candidate <= distance) { distance = candidate; nearest = marker; }
    });
    return nearest;
  }
  root.addEventListener('pointermove', event => {
    const marker = nearestMarker(event);
    if (marker) show(marker); else dismiss();
  });
  root.addEventListener('mousemove', event => {
    // Keep only our readable tooltip after the provider handles real movement.
    // Synthetic events in show() must first be allowed to produce its label.
    if (event.isTrusted && selected) {
      nativeTips().forEach(tip => { tip.style.display = 'none'; });
    }
  });
  root.addEventListener('focusout', dismiss);
  document.addEventListener('pointerdown', event => {
    if (!root.contains(event.target)) dismiss();
  });

  function prepareWidget() {
    // The provider inserts its anchor and markers asynchronously. Removing
    // href also prevents opening statistics from the context menu.
    root.querySelectorAll('a[href]').forEach(link => {
      link.removeAttribute('href');
      link.removeAttribute('target');
    });
    root.querySelectorAll(markerSelector).forEach(marker => {
      marker.setAttribute('tabindex', '0');
      marker.setAttribute('role', 'button');
      if (!marker.hasAttribute('aria-label')) {
        marker.setAttribute('aria-label', 'Show visitor location and visits');
      }
    });
  }
  new MutationObserver(prepareWidget).observe(root, { childList: true, subtree: true });
  prepareWidget();
})();
