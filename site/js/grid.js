// Decoding of the 16-bit PNG grids produced by pipeline/grids.py and
// rendering them onto Web-Mercator canvases for Leaflet image overlays.
//   code = R * 256 + G ; code 0 = no data ; value = offset + (code - 1) * scale
//   row 0 = north ; bounds = [west, south, east, north] (cell edges)

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`image load failed: ${url}`));
    img.src = url;
  });
}

export async function loadGrid(meta, base = 'data/') {
  const img = await loadImage(base + meta.png + (meta.time ? `?t=${encodeURIComponent(meta.time)}` : ''));
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);
  const px = ctx.getImageData(0, 0, w, h).data;
  const values = new Float32Array(w * h);
  for (let i = 0, p = 0; i < values.length; i += 1, p += 4) {
    const code = px[p] * 256 + px[p + 1];
    values[i] = code === 0 ? NaN : meta.offset + (code - 1) * meta.scale;
  }
  // QPF grids hold rainfall classes; expose the class lower bound in mm.
  if (meta.kind === 'class') {
    for (let i = 0; i < values.length; i += 1) {
      const c = values[i];
      if (!Number.isNaN(c)) values[i] = c >= 1 ? meta.classes[Math.round(c) - 1].lo : NaN;
    }
  }
  return { meta, w, h, values, bounds: meta.bounds };
}

/** Value at a WGS84 point (nearest cell) or null; higher-resolution parts win. */
export function sample(grid, lat, lon) {
  for (const part of grid.parts || []) {
    const v = sample(part, lat, lon);
    if (v !== null) return v;
  }
  const [west, south, east, north] = grid.bounds;
  if (lon < west || lon >= east || lat <= south || lat > north) return null;
  const i = Math.floor((lon - west) / (east - west) * grid.w);
  const j = Math.floor((north - lat) / (north - south) * grid.h);
  const v = grid.values[j * grid.w + i];
  return Number.isNaN(v) ? null : v;
}

/** For class grids: the [lo, hi] range of the class at a point. */
export function classRange(grid, lat, lon) {
  const v = sample(grid, lat, lon);
  if (v === null || grid.meta.kind !== 'class') return null;
  const c = grid.meta.classes.find((k) => k.lo === v);
  return c ? [c.lo, c.hi] : null;
}

const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const invMercY = (y) => (Math.atan(Math.exp(y)) * 360) / Math.PI - 90;

/** Render to a Web-Mercator canvas; colour(v) -> [r,g,b,a]. */
export function renderGrid(grid, colour) {
  const [, south, , north] = grid.bounds;
  const yN = mercY(north);
  const yS = mercY(south);
  const outH = Math.round(grid.h * (yN - yS) / ((north - south) * Math.PI / 180));
  const cv = document.createElement('canvas');
  cv.width = grid.w;
  cv.height = outH;
  const ctx = cv.getContext('2d');
  const out = ctx.createImageData(grid.w, outH);
  const d = out.data;
  const cache = new Map();
  for (let r = 0; r < outH; r += 1) {
    const lat = invMercY(yN - ((r + 0.5) / outH) * (yN - yS));
    const j = Math.min(grid.h - 1, Math.max(0, Math.floor(((north - lat) / (north - south)) * grid.h)));
    const row = j * grid.w;
    for (let i = 0; i < grid.w; i += 1) {
      const v = grid.values[row + i];
      if (Number.isNaN(v)) continue;
      let c = cache.get(v);
      if (!c) { c = colour(v); cache.set(v, c); }
      if (!c[3]) continue;
      const p = (r * grid.w + i) * 4;
      d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = c[3];
    }
  }
  ctx.putImageData(out, 0, 0);
  return cv;
}
