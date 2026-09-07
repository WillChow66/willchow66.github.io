// Aggregate city statistics from the owner's Cloudflare Worker.
(function () {
  'use strict';
  const root = document.getElementById('visitor-map');
  if (!root || root.dataset.initialized) return;
  root.dataset.initialized = 'true';
  const canvas = root.querySelector('canvas');
  const caption = root.querySelector('figcaption');
  const tooltip = root.querySelector('[role="tooltip"]');
  const context = canvas.getContext('2d');
  if (!context) { root.hidden = true; return; }
  const endpoint = root.dataset.endpoint.replace(/\/$/, '');
  const landURL = new URL('./land-points.json', document.currentScript.src);
  const production = location.origin === 'https://willchow66.github.io';
  let land = [];
  let points = [];
  let targets = [];
  let active = -1;
  let height = 145;
  let north = 85;
  let landLoaded = false;

  function dismiss() {
    active = -1;
    tooltip.hidden = true;
    canvas.removeAttribute('aria-describedby');
    canvas.style.cursor = 'default';
  }

  function label(point) {
    const place = point.city ? `${point.city}, ${point.country}` : `City unavailable, ${point.country}`;
    return `${place} · ${point.views.toLocaleString('en-US')} ${point.views === 1 ? 'visit' : 'visits'}`;
  }

  function show(index) {
    if (index < 0 || !targets[index]) { dismiss(); return; }
    active = index;
    tooltip.textContent = label(targets[index]);
    tooltip.hidden = false;
    canvas.setAttribute('aria-describedby', tooltip.id);
    canvas.style.cursor = 'help';
    const box = canvas.getBoundingClientRect();
    const origin = root.getBoundingClientRect();
    const x = targets[index].x * box.width / 360 + box.left - origin.left;
    const y = targets[index].y * box.height / height + box.top - origin.top;
    const left = Math.max(0, Math.min(x - tooltip.offsetWidth / 2, origin.width - tooltip.offsetWidth));
    const above = y - tooltip.offsetHeight - 8;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${above >= 0 ? above : y + 8}px`;
  }

  function draw() {
    dismiss();
    const cssWidth = canvas.getBoundingClientRect().width || 300;
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    canvas.style.height = `${cssWidth * height / 360}px`;
    canvas.width = Math.round(cssWidth * ratio);
    canvas.height = Math.round(cssWidth * height / 360 * ratio);
    context.setTransform(canvas.width / 360, 0, 0, canvas.height / height, 0, 0);
    context.clearRect(0, 0, 360, height);
    context.fillStyle = '#d5d9df';
    for (const [lon, lat] of land) {
      context.beginPath();
      context.arc(lon + 180, north - lat, 0.82, 0, Math.PI * 2);
      context.fill();
    }
    targets = points.map(point => ({ ...point, x: point.lon + 180, y: north - point.lat }));
    // Draw small circles last so nearby, less frequent cities remain visible.
    for (const point of [...targets].sort((a, b) => b.views - a.views)) {
      context.beginPath();
      context.arc(point.x, point.y, Math.min(6.5, 2.4 + Math.log2(point.views) * 0.55), 0, Math.PI * 2);
      context.fillStyle = 'rgba(153,0,0,0.82)';
      context.fill();
      context.strokeStyle = '#ffffff';
      context.lineWidth = 0.6;
      context.stroke();
    }
    canvas.tabIndex = targets.length ? 0 : -1;
    canvas.setAttribute('aria-label', targets.length
      ? 'Map of approximate visitor locations. Use Left and Right arrow keys to explore cities.'
      : 'Map of approximate visitor locations');
  }

  function nearest(event) {
    const box = canvas.getBoundingClientRect();
    let best = -1;
    let distance = 100; // 10 CSS pixels around a marker, including retina screens.
    targets.forEach((point, index) => {
      const dx = event.clientX - box.left - point.x * box.width / 360;
      const dy = event.clientY - box.top - point.y * box.height / height;
      const squared = dx * dx + dy * dy;
      if (squared < distance) { best = index; distance = squared; }
    });
    return best;
  }

  canvas.addEventListener('pointermove', event => show(nearest(event)));
  canvas.addEventListener('pointerleave', event => { if (event.pointerType !== 'touch') dismiss(); });
  canvas.addEventListener('click', event => { event.preventDefault(); show(nearest(event)); });
  canvas.addEventListener('auxclick', event => event.preventDefault());
  canvas.addEventListener('blur', dismiss);
  canvas.addEventListener('keydown', event => {
    if (event.key === 'Escape') { dismiss(); return; }
    if (!targets.length) return;
    if (['ArrowRight', 'ArrowDown', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      show((active + 1) % targets.length);
    } else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      show((active < 0 ? targets.length - 1 : active - 1 + targets.length) % targets.length);
    }
  });
  document.addEventListener('pointerdown', event => { if (!root.contains(event.target)) dismiss(); });
  if ('ResizeObserver' in window) new ResizeObserver(draw).observe(root);
  else window.addEventListener('resize', draw);

  async function request(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', ...options, signal: controller.signal });
      if (!response.ok) throw new Error('Request failed');
      return options.method === 'POST' ? null : await response.json();
    } finally { clearTimeout(timer); }
  }

  async function loadStatistics() {
    // The private site copy does not count visitors or call a disallowed origin.
    if (!production) return;
    caption.textContent = 'Loading visitor statistics…';
    const optedOut = navigator.doNotTrack === '1' || window.doNotTrack === '1' || navigator.globalPrivacyControl === true;
    if (!optedOut) {
      // One empty POST per page load. Never retry a counting request.
      try { await request(`${endpoint}/hit`, { method: 'POST' }); } catch { /* Still read existing totals. */ }
    }
    try {
      const data = await request(`${endpoint}/points`);
      if (!data || !Number.isSafeInteger(data.views) || data.views < 0 || !Array.isArray(data.points)) throw new Error('Invalid statistics');
      points = data.points.slice(0, 2000).filter(point =>
        point && Number.isFinite(point.lon) && Math.abs(point.lon) <= 180 &&
        Number.isFinite(point.lat) && Math.abs(point.lat) <= 90 &&
        typeof point.country === 'string' && /^[A-Z]{2}$/.test(point.country) &&
        Number.isSafeInteger(point.views) && point.views > 0
      ).map(point => ({ ...point, city: typeof point.city === 'string' ? point.city.slice(0, 80).trim() : '' }));
      north = Math.max(85, ...points.map(point => point.lat));
      height = north - Math.min(-60, ...points.map(point => point.lat));
      const countries = new Set(points.map(point => point.country)).size;
      const viewsText = `${data.views.toLocaleString('en-US')} ${data.views === 1 ? 'page view' : 'page views'}`;
      caption.textContent = viewsText + (countries ? ` from ${countries} ${countries === 1 ? 'country' : 'countries'}` : '');
      if (landLoaded) draw();
    } catch {
      caption.textContent = 'Visitor statistics temporarily unavailable';
    }
  }

  draw();
  request(landURL).then(data => {
    if (!Array.isArray(data) || !data.every(point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite))) throw new Error('Invalid map');
    land = data;
    landLoaded = true;
    draw();
  }).catch(() => { canvas.hidden = true; tooltip.hidden = true; });
  loadStatistics();
})();
