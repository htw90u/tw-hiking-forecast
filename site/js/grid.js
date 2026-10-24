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

/**
 * Render to a Web-Mercator canvas; colour(v) -> [r,g,b,a].
 * smooth: bilinear interpolation between cell centres at `scale` x resolution,
 *   so colour bands get smooth curved edges instead of square cells.
 * fill: value used for no-data neighbours while interpolating (e.g. "no echo");
 *   NaN means no-data neighbours are ignored (weights renormalised).
 */
export function renderGrid(grid, colour, { smooth = false, fill = NaN, maxPixels = 5e6 } = {}) {
  const [, south, , north] = grid.bounds;
  const yN = mercY(north);
  const yS = mercY(south);
  const k = smooth ? Math.max(1, Math.min(4, Math.floor(Math.sqrt(maxPixels / (grid.w * grid.h))))) : 1;
  const outW = grid.w * k;
  const outH = Math.round(grid.h * k * (yN - yS) / ((north - south) * Math.PI / 180));
  const cv = document.createElement('canvas');
  cv.width = outW;
  cv.height = outH;
  const ctx = cv.getContext('2d');
  const out = ctx.createImageData(outW, outH);
  const d = out.data;
  const cache = new Map();
  const { w, h, values } = grid;
  const put = (p, v) => {
    const key = Math.round(v * 10);
    let c = cache.get(key);
    if (!c) { c = colour(key / 10); cache.set(key, c); }
    if (!c[3]) return;
    d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = c[3];
  };
  const at = (i, j) => {
    if (i < 0 || j < 0 || i >= w || j >= h) return fill;
    const v = values[j * w + i];
    return Number.isNaN(v) ? fill : v;
  };
  for (let r = 0; r < outH; r += 1) {
    const lat = invMercY(yN - ((r + 0.5) / outH) * (yN - yS));
    const fyRaw = ((north - lat) / (north - south)) * h;
    if (!smooth) {
      const row = Math.min(h - 1, Math.max(0, Math.floor(fyRaw))) * w;
      for (let i = 0; i < w; i += 1) {
        const v = values[row + i];
        if (!Number.isNaN(v)) put((r * outW + i) * 4, v);
      }
      continue;
    }
    const fy = fyRaw - 0.5;
    const j0 = Math.floor(fy);
    const ty = fy - j0;
    for (let x = 0; x < outW; x += 1) {
      const fx = (x + 0.5) / k - 0.5;
      const i0 = Math.floor(fx);
      const tx = fx - i0;
      const v00 = at(i0, j0); const v10 = at(i0 + 1, j0); const v01 = at(i0, j0 + 1); const v11 = at(i0 + 1, j0 + 1);
      const w00 = (1 - tx) * (1 - ty); const w10 = tx * (1 - ty); const w01 = (1 - tx) * ty; const w11 = tx * ty;
      let sum = 0; let wsum = 0;
      if (!Number.isNaN(v00)) { sum += v00 * w00; wsum += w00; }
      if (!Number.isNaN(v10)) { sum += v10 * w10; wsum += w10; }
      if (!Number.isNaN(v01)) { sum += v01 * w01; wsum += w01; }
      if (!Number.isNaN(v11)) { sum += v11 * w11; wsum += w11; }
      // Without a fill value, only draw where most of the neighbourhood has data.
      if (wsum < (Number.isNaN(fill) ? 0.5 : 1e-9)) continue;
      put((r * outW + x) * 4, sum / wsum);
    }
  }
  ctx.putImageData(out, 0, 0);
  return cv;
}
