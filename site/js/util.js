// Small shared helpers: data fetching, formatting, geometry, DOM.

export const DATA = 'data/';
let version = '';

export function setDataVersion(v) { version = v || ''; }

export async function getJSON(path, { optional = false } = {}) {
  const url = DATA + path + (version ? `?v=${encodeURIComponent(version)}` : '');
  const res = await fetch(url);
  if (!res.ok) {
    if (optional) return null;
    throw new Error(`${res.status} ${path}`);
  }
  return res.json();
}

const TZ = 'Asia/Taipei';
const fmtCache = new Map();
function fmt(opts) {
  const key = JSON.stringify(opts);
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat('zh-TW', { timeZone: TZ, hour12: false, ...opts }));
  return fmtCache.get(key);
}

/** "10/23 22:10" in Taiwan time. */
export function fmtTime(iso, { date = true, weekday = false } = {}) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const parts = Object.fromEntries(fmt({ month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', weekday: 'short' })
    .formatToParts(d).map((p) => [p.type, p.value]));
  const hm = `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}`;
  if (!date) return hm;
  return `${parts.month}/${parts.day}${weekday ? `(${parts.weekday.replace('週', '')})` : ''} ${hm}`;
}

export function ageText(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return '剛剛';
  if (mins < 60) return `${mins} 分鐘前`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} 小時前`;
  return `${Math.round(mins / 1440)} 天前`;
}

export function fmtNum(v, digits = 1, unit = '') {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const n = Number(v);
  const s = Number.isInteger(n) ? String(n) : n.toFixed(digits);
  return unit ? `${s} ${unit}` : s;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function nearest(items, lat, lon, { limit = 5, maxKm = Infinity } = {}) {
  return items
    .map((it) => ({ it, d: haversineKm(lat, lon, it.lat, it.lon) }))
    .filter((x) => x.d <= maxKm)
    .sort((a, b) => a.d - b.d)
    .slice(0, limit);
}

const DIRS = ['北', '北北東', '東北', '東北東', '東', '東南東', '東南', '南南東', '南', '南南西', '西南', '西南西', '西', '西北西', '西北', '北北西'];
export function windDir(deg) {
  if (deg === null || deg === undefined || Number.isNaN(deg)) return '';
  return DIRS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** Beaufort scale from m/s. */
export function beaufort(ms) {
  if (ms === null || ms === undefined) return null;
  const lim = [0.3, 1.6, 3.4, 5.5, 8.0, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7, 37.0, 41.5, 46.2, 51.0, 56.1];
  let b = 0;
  while (b < lim.length && ms >= lim[b]) b += 1;
  return b;
}

/** Apparent temperature (°C) from temperature, relative humidity and wind, CWA's formula:
 * AT = 1.04 T + 0.2 e − 0.65 V − 2.7, with e the vapour pressure (hPa). */
export function apparentTemp(t, rh, ws) {
  if (![t, rh, ws].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const e = (rh / 100) * 6.105 * Math.exp((17.27 * t) / (237.7 + t));
  return Math.round((1.04 * t + 0.2 * e - 0.65 * ws - 2.7) * 10) / 10;
}

/** Tagged template that escapes interpolated values. Use raw() to opt out. */
export function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      if (v && v.__raw) out += v.html;
      else if (Array.isArray(v)) out += v.map((x) => (x && x.__raw ? x.html : esc(x))).join('');
      else out += esc(v);
    }
  });
  return { __raw: true, html: out };
}
export function raw(s) { return { __raw: true, html: String(s) }; }
export function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function $(sel, root = document) { return root.querySelector(sel); }

// ---------------------------------------------------------------- polygons
function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polygonContains(geometry, lon, lat) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polys.some((rings) => ringContains(rings[0], lon, lat) && !rings.slice(1).some((h) => ringContains(h, lon, lat)));
}

export function bbox(geometry) {
  let w = Infinity; let s = Infinity; let e = -Infinity; let n = -Infinity;
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  polys.forEach((rings) => rings[0].forEach(([x, y]) => {
    if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
  }));
  return [w, s, e, n];
}

export function normCounty(name) { return (name || '').replace(/台/g, '臺'); }

/** Intensity value from the pipeline (5 = 5弱, 5.5 = 5強) -> CWA label. */
export function intText(v) {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  if (n >= 5) return `${Math.floor(n)}${n % 1 ? '強' : '弱'}`;
  return `${n}級`;
}

/** Strong earthquake: maximum intensity 5弱 or above, or magnitude 6 or above. */
export function isStrongQuake(q) {
  return (Number(q.maxInt) || 0) >= 5 || (Number(q.mag) || 0) >= 6;
}

/** "3886 m", or "約 123 m" for an elevation estimated from a terrain model; '' when unknown. */
export function eleText(p) {
  return p && p.ele ? `${p.est ? '約 ' : ''}${p.ele} m` : '';
}
