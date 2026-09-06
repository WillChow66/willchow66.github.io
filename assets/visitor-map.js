// No tracking or network requests until the owner's statistics service is connected.
const root = document.getElementById('visitor-map');
const endpoint = root?.dataset.endpoint?.trim();

async function start() {
  const service = new URL(endpoint);
  if (service.protocol !== 'https:') return;
  const base = service.href.replace(/\/$/, '');
  if (navigator.doNotTrack !== '1' && navigator.globalPrivacyControl !== true) {
    // Empty body: location must come from trusted server metadata, not the client.
    try {
      await fetch(`${base}/hit`, {
        method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(5000)
      });
    } catch { /* Reading the existing map can still work if counting fails. */ }
  }
  const [mapResponse, statsResponse] = await Promise.all([
    fetch(new URL('./land-points.json', import.meta.url)),
    fetch(`${base}/points`, {
      credentials: 'omit', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(8000)
    })
  ]);
  if (!mapResponse.ok || !statsResponse.ok) return;
  const land = await mapResponse.json();
  const stats = await statsResponse.json();
  if (!Array.isArray(stats.points) || !Number.isSafeInteger(stats.views) || stats.views < 0) return;
  const points = stats.points.filter(p =>
    Number.isFinite(p.lon) && p.lon >= -180 && p.lon <= 180 &&
    Number.isFinite(p.lat) && p.lat >= -90 && p.lat <= 90 &&
    Number.isSafeInteger(p.views) && p.views > 0
  );
  const canvas = root.querySelector('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const countries = new Set(points.map(p => p.country).filter(Boolean)).size;
  const caption = `${stats.views.toLocaleString()} page views · ${countries} ${countries === 1 ? 'country' : 'countries'}`;
  root.querySelector('.visitor-map-caption').textContent = caption;
  canvas.setAttribute('aria-label', `${caption}. Locations are approximate; views are not unique visitors.`);
  const list = root.querySelector('.visitor-map-locations');
  points.sort((a, b) => b.views - a.views).forEach(p => {
    const item = document.createElement('li');
    item.textContent = `${[p.city, p.country].filter(Boolean).join(', ') || 'Unknown location'}: ${p.views.toLocaleString()} ${p.views === 1 ? 'view' : 'views'}`;
    list.append(item);
  });
  root.querySelector('details').hidden = points.length === 0;
  root.hidden = false;
  function draw() {
    const width = root.clientWidth;
    const height = width * 150 / 360;
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const project = (lon, lat) => [(lon + 180) / 360 * width, (90 - lat) / 150 * height];
    const dot = (lon, lat, radius) => {
      const [x, y] = project(lon, lat);
      ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
    };
    ctx.fillStyle = '#d4d6d8';
    land.forEach(([lon, lat]) => dot(lon, lat, Math.max(.65, width / 620)));
    points.filter(p => p.lat >= -60).forEach(p => {
      const r = Math.min(6, 1.7 + Math.log2(p.views + 1) * .55);
      ctx.fillStyle = 'rgba(8,117,154,.15)'; dot(p.lon, p.lat, r + 2);
      ctx.fillStyle = '#08759a'; dot(p.lon, p.lat, r);
    });
  }
  draw();
  new ResizeObserver(draw).observe(root);
}

if (endpoint) start().catch(() => { root.hidden = true; });
