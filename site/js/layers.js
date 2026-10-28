// Weather map layers: grid overlays, satellite, typhoon rain choropleth; legend and time control.
import { S } from './state.js';
import { getJSON, fmtTime, esc, normCounty, beaufort, haversineKm, apparentTemp } from './util.js';
import { loadGrid, renderGrid } from './grid.js';
import { scaleFor, colourFn, classLabel } from './palettes.js';
import { saveSettings } from './settings.js';
import { loadAloft, stepOf, compass, altText } from './aloft.js';
import { loadHydro, riverStatus, reservoirStatus, riverTip, reservoirTip, townAlerts } from './hydro.js';

export const LAYERS = [
  { id: 'radar', label: '雷達回波', kind: 'radar', unit: 'dBZ' },
  { id: 'qpe1h', label: '1小時雨量', kind: 'rain', unit: 'mm' },
  { id: 'rainacc', label: '累積雨量', kind: 'rainacc', unit: 'mm' },
  { id: 'qpf1h', label: '未來1小時雨量', kind: 'rain', unit: 'mm' },
  { id: 'qpf', label: '定量降水預報', kind: 'rain', unit: 'mm/12h' },
  { id: 'temp', label: '溫度', kind: 'temp', unit: '°C' },
  { id: 'wind', label: '風力', kind: 'wind' },
  { id: 'pop', label: '降雨機率', kind: 'pop', unit: '%' },
  { id: 'uv', label: '紫外線', kind: 'uv', unit: '' },
  { id: 'heat', label: '熱傷害', kind: 'heat', unit: '' },
  { id: 'wrf3', label: 'WRF 3km', kind: 'rain', unit: 'mm' },
  { id: 'wrfg', label: '全球模式', kind: 'rain', unit: 'mm' },
  { id: 'visib', label: '能見度', kind: 'visib', unit: 'km' },
  { id: 'water', label: '水位', kind: 'water', unit: 'm' },
  { id: 'debris', label: '土石流', kind: 'debris', unit: '' },
  { id: 'lightning', label: '閃電', kind: 'ltage' },
  { id: 'sat', label: '衛星雲圖', kind: 'sat' },
  { id: 'tyrain', label: '颱風雨量預測', kind: 'rain', unit: 'mm', typhoonOnly: true },
  { id: 'none', label: '關閉圖層', kind: 'none' },
];

// Interpolation fill for no-data cells per layer kind (temperature, satellite: ignore no-data).
const FILL = { radar: -20, rain: 0, rainacc: 0, temp: NaN };

// Attribution required by the Open Government Data License (顯名聲明).
export const OGDL_TEXT = '此開放資料依政府資料開放授權條款 (Open Government Data License) 進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。';
export const OGDL_URL = 'https://data.gov.tw/license';

// QPF display modes and satellite products (numeric grids from the pipeline).
export const QPF_MODES = [{ id: '12', label: '12小時' }, { id: '6', label: '6小時' }, { id: 'acc', label: '24／48小時累積' }];
const SAT_MODES = [
  { label: '紅外線（黑白）', key: 'ir', kind: 'irgray' },
  { label: '紅外線（色調強化）', key: 'ir', kind: 'irenh' },
  { label: '可見光', key: 'vis', kind: 'vis' },
];

function satGrids() { return S.manifest?.layers?.satellite?.grids || {}; }

/** Wide-interval (大間距) classes: chosen by the user, or automatically when totals exceed 400 mm (CWA's advice). */
export function useBigSpacing() {
  return S.settings.rainSpacing === 'big';
}
// Layers whose colour classes can switch between 小間距 and 大間距.
const SPACING_KINDS = ['rainacc', 'rainbig'];

/** Colour-scale kind actually used for the current layer / mode. */
export function layerKind(id) {
  if (id === 'qpf' && S.layer.qpfMode === 'acc') return 'rainacc';
  if (id === 'wrf3') return S.layer.wrf3Mode === 'temp' ? 'temp' : 'rain';
  if (id === 'wrfg') return { msl: 'msl', temp: 'temp' }[S.layer.wrfgMode] || 'rain';
  if (id === 'sat' && satGrids().ir) return SAT_MODES[Math.min(S.layer.frame, SAT_MODES.length - 1)].kind;
  return layerDef(id).kind;
}
// Layers whose frames are selectable periods (S.layer.period) rather than animation frames.
export const PERIOD_LAYERS = ['qpf', 'rainacc'];

export function layerDef(id) { return LAYERS.find((l) => l.id === id) || LAYERS[0]; }

export function getMeta(path) {
  if (!S.metas.has(path)) S.metas.set(path, getJSON(path));
  return S.metas.get(path);
}

export async function getGrid(path) {
  if (!S.grids.has(path)) {
    // Grids may carry extra "parts" (e.g. outlying-island insets of the QPF);
    // they are loaded together and consulted first by sample().
    const p = getMeta(path).then(async (meta) => {
      const grid = await loadGrid(meta);
      grid.parts = await Promise.all((meta.parts || []).map((pp) => getMeta(pp).then((m) => loadGrid(m))));
      return grid;
    });
    p.catch(() => S.grids.delete(path));
    S.grids.set(path, p);
  }
  return S.grids.get(path);
}

/** Meta path(s) of the grid currently represented by a layer id. */
export function framesFor(id) {
  const L_ = S.manifest?.layers || {};
  if (id === 'radar') {
    const fr = L_.radarFrames?.frames || [];
    return fr.length ? fr.map((f) => f.meta) : ['grids/radar.json'];
  }
  if (id === 'qpf') {
    if (S.layer.qpfMode === '6') return (L_.qpf6?.periods || []).map((p) => p.meta);
    if (S.layer.qpfMode === 'acc') return (L_.qpfacc?.periods || []).map((p) => p.meta);
    return (L_.qpf?.periods || []).map((p) => p.meta);
  }
  if (id === 'sat') {
    const g = satGrids();
    return g.ir ? SAT_MODES.map((m) => g[m.key]?.meta).filter(Boolean) : [];
  }
  if (id === 'wrf3') return wrf3Frames().map((f) => f.meta);
  if (id === 'wrfg') return wrfgFrames().map((f) => f.meta);
  if (id === 'rainacc') return (L_.rainacc?.periods || [{ meta: 'grids/rainday.json' }]).map((p) => p.meta);
  if (['qpe1h', 'rainday', 'qpf1h', 'temp'].includes(id)) return [`grids/${id}.json`];
  return [];
}

/** Coast and county outlines (dark halo + light line) so Taiwan and the islands stay visible on the satellite picture. */
function outlines() {
  if (!S.map.getPane('outline')) S.map.createPane('outline').style.zIndex = 410;
  const data = { type: 'FeatureCollection', features: S.counties };
  const mk = (style) => L.geoJSON(data, { pane: 'outline', interactive: false, style: { fill: false, lineJoin: 'round', ...style } });
  return [mk({ color: '#000', weight: 2.2, opacity: 0.35 }), mk({ color: '#fff', weight: 0.9, opacity: 0.9 })];
}

function clearOverlay() {
  if (S.layer.overlay) { S.map.removeLayer(S.layer.overlay); S.layer.overlay = null; }
}

export function stopAnimation() {
  if (S.layer.timer) { clearInterval(S.layer.timer); S.layer.timer = null; }
  const b = document.getElementById('btn-play');
  if (b) { b.textContent = '▶'; b.setAttribute('aria-pressed', 'false'); b.setAttribute('aria-label', '播放'); b.title = '播放'; }
}

/** Play / pause button shared by every time-stepped layer (the radar has always had one). */
function playButton() {
  const playing = Boolean(S.layer.timer);
  return `<button id="btn-play" class="btn play" aria-pressed="${playing}" aria-label="${playing ? '暫停' : '播放'}" title="${playing ? '暫停' : '播放'}">${playing ? '❚❚' : '▶'}</button>`;
}

/** Underline tabs for the modes of a layer: items [[key, label]]; `attr` is the data attribute that carries the key. */
function modeTabs(aria, items, attr, cur, icons = {}) {
  const icon = S.settings.ui === 'icon';
  return `<div class="seg tabs" role="radiogroup" aria-label="${aria}">` + items.map(([k, l]) => `<button class="seg-btn" role="radio" aria-checked="${k === cur}" data-${attr}="${k}">${icon && icons[k] ? `<i aria-hidden="true">${icons[k]}</i>` : ''}${l}</button>`).join('') + '</div>';
}

/** Mountain (as high as Yushan, 3,952 m) with a line at the altitude of a level: low levels cut the mountain, the high ones float above it.
 *  The height scale is a square root so that the low levels can still be told apart. */
function levelIcon(m) {
  const H = 17;
  const y = (z) => (19 - H * Math.sqrt(Math.min(z, 12500) / 12500)).toFixed(1);
  const top = y(3952);
  const gap = Number(top) + (19 - Number(top)) * 0.45;
  return `<svg class="lvic" viewBox="0 0 22 20" aria-hidden="true"><path d="M1 19 9 ${top} 12.5 ${gap.toFixed(1)} 14.5 ${(Number(top) + (19 - Number(top)) * 0.25).toFixed(1)} 21 19z"/><line class="gr" x1="1" x2="21" y1="19" y2="19"/><line class="lv" x1="1" x2="21" y1="${y(m)}" y2="${y(m)}"/></svg>`;
}

/** Number of steps (and a preloader) of the current layer when it can be played, else null. */
function playInfo() {
  const id = S.layer.id;
  const grids = (list) => ({ n: list.length, pre: () => Promise.all(list.map((p) => getGrid(p))) });
  if (id === 'radar') return grids(framesFor('radar'));
  if (id === 'wrf3') return grids(framesFor('wrf3'));
  if (id === 'wrfg') return grids(framesFor('wrfg'));
  if (id === 'heat') return { n: S.heat?.times?.length || 0 };
  if (id === 'pop' || (id === 'wind' && (S.layer.windMode || 'fc') === 'fc') || (id === 'visib' && S.layer.visMode === 'fc')) return { n: S.wind?.times?.length || 0 };
  if (id === 'wind' && S.layer.windMode === 'aloft') return { n: wrfDs()?.steps?.length || 0 };
  return null;
}

export async function showLayer(id, { keepFrame = false } = {}) {
  const def = layerDef(id);
  if (S.layer.id !== id) stopAnimation();
  S.layer.id = id;
  if (!keepFrame) {
    S.layer.frame = id === 'sat' ? 0 : Math.max(0, framesFor(id).length - 1);
    S.layer.period = id === 'rainacc' ? Math.max(0, (S.manifest?.layers?.rainacc?.periods || []).findIndex((p) => p.id === '24h')) : 0;
  }
  document.querySelectorAll('.chip[data-layer]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.layer === id));
  });
  const slider = document.getElementById('opacity');
  if (slider) { slider.value = String(layerOpacity(id)); slider.setAttribute('aria-valuetext', `${Math.round(layerOpacity(id) * 100)}%`); }
  renderTimeControl();
  try {
    if (def.kind === 'none') { clearOverlay(); renderLegend(); return; }
    if (id === 'sat' && !satGrids().ir) { await showSatellite(); return; }
    if (id === 'tyrain') { showTyphoonRain(); return; }
    if (id === 'wind') { await showWind(keepFrame); return; }
    if (id === 'water') { await showWater(); return; }
    if (id === 'debris') { await showDebris(); return; }
    if (id === 'pop') { await showPop(keepFrame); return; }
    if (id === 'uv') { await showUV(); return; }
    if (id === 'heat') { await showHeat(keepFrame); return; }
    if (id === 'visib') { await showVisibility(keepFrame); return; }
    if (id === 'lightning') { await showLightning(); return; }
    if (id === 'wrf3' && (!keepFrame || S.layer.frame >= framesFor(id).length)) S.layer.frame = wrf3NowIndex(wrf3Frames());
    if (id === 'wrfg' && (!keepFrame || S.layer.frame >= framesFor(id).length)) S.layer.frame = 0;
    const frames = framesFor(id);
    const path = PERIOD_LAYERS.includes(id) ? frames[Math.min(S.layer.period, frames.length - 1)] : frames[S.layer.frame];
    if (!path) { clearOverlay(); renderLegend(null, '此圖層目前沒有資料'); return; }
    const grid = await getGrid(path);
    if (S.layer.id !== id) return; // user switched meanwhile
    let kind = layerKind(id);
    if (kind === 'rainacc' && useBigSpacing()) kind = 'rainbig';
    const colour = colourFn(scaleFor(kind, S.settings.palette));
    // Smooth rendering interpolates between cells; "no echo / no rain" counts as a low value
    // so that rain areas fade out at their edges instead of ending in square steps.
    const opts = { smooth: S.settings.smooth !== false, fill: FILL[kind] ?? NaN };
    // The temperature analysis covers land only, in 3 km cells: cut it to the real coastline (no gaps, no sea spill-over).
    if (kind === 'temp' && id !== 'wrf3' && id !== 'wrfg') Object.assign(opts, { landClip: S.counties, extend: 2, maxK: 8 });
    const ov = L.layerGroup([grid, ...(grid.parts || [])].map((g) => {
      const [w, s, e, n] = g.bounds;
      return L.imageOverlay(renderGrid(g, colour, opts).toDataURL('image/png'), [[s, w], [n, e]],
        { opacity: layerOpacity(id), interactive: false, className: 'wx-grid' });
    }));
    if (id === 'sat') outlines().forEach((o) => ov.addLayer(o));
    if (!S.layer.hidden) ov.addTo(S.map);
    clearOverlay();
    S.layer.overlay = ov;
    const wf = id === 'wrf3' ? wrf3Frames()[S.layer.frame] : null;
    renderLegend({ ...grid.meta, kindOverride: kind, ...(wf ? { src: '中央氣象署 區域數值模式 WRF 3 km（M-A0064）', issued: S.manifest.layers.wrf3.time,
      ...(S.layer.wrf3Mode === 'temp' ? {} : { start: grid.meta.start, end: grid.meta.time, time: undefined }),
      note: `模式輸出的格點預報（3 km 網格、每 6 小時一步、最長 84 小時），${S.layer.wrf3Mode === 'temp' ? '為 2 m 高度氣溫；模式地形高度與實際海拔不同，山區氣溫請與測站、氣象署山區預報對照。' : '為每 6 小時累積降水，由模式累積雨量相減而得，位置與強度都可能有偏差，不是機率，也不等於氣象署的定量降水預報。'}` } : {}) });
    if (id === 'wrfg') {
      const mode = S.layer.wrfgMode || 'rain';
      renderLegend({ ...grid.meta, kindOverride: kind, src: '中央氣象署 全球模式（M-A0060）', issued: S.manifest.layers.wrfg.time,
        ...(mode === 'rain' ? { start: grid.meta.start, end: grid.meta.time, time: undefined } : {}),
        note: `全球模式 0.25°（約 25 km）網格，預報到第 16 天（前 10 天每 6 小時、之後每 12 小時，這裡每天取一個時間）。${mode === 'rain' ? '為該日前 24 小時累積降水，由模式累積雨量相減而得，山區細節與強度偏差大，只適合看遠期趨勢與降雨範圍。' : mode === 'msl' ? '海平面氣壓（hPa）：低壓、颱風與鋒面看低值，高壓看高值，可看出天氣系統的移動。' : '2 m 氣溫；25 km 網格的地形比實際平滑，山區氣溫偏高，請以地點預報為準。'}` });
    }
    renderTimeControl(grid.meta);
  } catch (e) {
    console.error(e);
    clearOverlay();
    renderLegend(null, `圖層載入失敗（${e.message}）。若為離線狀態，僅能顯示曾經開啟過的圖層。`);
  }
}

async function showSatellite() {
  const imgs = S.sat;
  if (!imgs.length) { clearOverlay(); renderLegend(null, '沒有衛星雲圖資料'); return; }
  const im = imgs[Math.min(S.layer.frame, imgs.length - 1)];
  const [w, s, e, n] = im.bounds;
  const ov = L.imageOverlay(`data/${im.img}?t=${encodeURIComponent(im.time)}`, [[s, w], [n, e]], {
    opacity: layerOpacity('sat'), interactive: false, alt: `${im.label}衛星雲圖 ${fmtTime(im.time)}`,
  });
  ov.addTo(S.map);
  clearOverlay();
  S.layer.overlay = ov;
  renderLegend({ label: `衛星雲圖：${im.label}`, time: im.time, src: im.src });
}

function tyTable() {
  const t = S.typhoon?.tables || {};
  return S.layer.period === 1 ? t.rainTotal : t.rain24;
}

function showTyphoonRain() {
  const tbl = tyTable();
  if (!tbl || !S.counties.length) { clearOverlay(); renderLegend(null, '目前沒有颱風雨量預測'); return; }
  const tyMax = Math.max(0, ...tbl.areas.map((a) => a.hi ?? a.lo ?? 0));
  const tyKind = useBigSpacing() ? 'rainbig' : 'rain';
  const scale = scaleFor(tyKind, S.settings.palette);
  const col = colourFn(scale);
  const byCounty = {};
  tbl.areas.forEach((a) => {
    const k = normCounty(a.area);
    byCounty[k] = byCounty[k] || {};
    byCounty[k][a.region] = a;
  });
  const ov = L.geoJSON({ type: 'FeatureCollection', features: S.counties }, {
    style: (f) => {
      const rec = byCounty[normCounty(f.properties.COUNTYNAME)] || {};
      const a = rec.mountain || rec.flat;
      const c = a ? col(a.hi ?? a.lo) : [0, 0, 0, 0];
      return { color: '#333', weight: 1, fillColor: `rgb(${c[0]},${c[1]},${c[2]})`, fillOpacity: c[3] ? S.settings.opacity : 0 };
    },
    onEachFeature: (f, layer) => {
      const rec = byCounty[normCounty(f.properties.COUNTYNAME)] || {};
      const parts = ['flat', 'mountain'].filter((r) => rec[r]).map((r) => `${r === 'flat' ? '平地' : '山區'} ${rec[r].value} mm`);
      layer.bindTooltip(`${esc(f.properties.COUNTYNAME)}：${parts.join('、') || '無預測'}`, { sticky: true });
    },
  });
  ov.addTo(S.map);
  clearOverlay();
  S.layer.overlay = ov;
  renderLegend({ label: tbl.name, unit: 'mm', time: tbl.issue, period: tbl.period, note: tbl.note, kindOverride: tyKind, spacing: true, tyMax });
}

// ---------------------------------------------------------------- wind
export const WIND_DIRS = ['偏北風', '東北風', '偏東風', '東南風', '偏南風', '西南風', '偏西風', '西北風'];

export async function loadWind() {
  if (!S.wind) S.wind = await getJSON('wind.json', { optional: true });
  return S.wind;
}

/** Forecast step nearest to now (the first one not yet ended). */
function windNowIndex(times) {
  const now = Date.now();
  const i = times.findIndex((t) => new Date(t).getTime() + 3 * 3600e3 > now);
  return i < 0 ? times.length - 1 : i;
}

/** [lat, lon, name] of each township (bounding-box centre), by TOWNCODE; computed once. */
function townCentres() {
  if (S.townCentres) return S.townCentres;
  const out = {};
  S.towns.forEach((f) => {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (c) => { if (typeof c[0] === 'number') { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); } else c.forEach(walk); };
    walk(f.geometry.coordinates);
    out[f.properties.TOWNCODE] = [(y0 + y1) / 2, (x0 + x1) / 2, `${normCounty(f.properties.COUNTYNAME)}${f.properties.TOWNNAME}`];
  });
  S.townCentres = out;
  return out;
}

/** Arrow pointing downwind (the wind comes from `fromDeg`), with the Beaufort number. */
function windArrow(fromDeg, bf, colour, title, town = false) {
  const html = `<span class="wa" style="--c:${colour}"><svg viewBox="0 0 24 24" style="transform:rotate(${fromDeg + 180}deg)" aria-hidden="true"><path d="M12 3v15M6.5 12.5 12 19l5.5-6.5"/></svg><b>${bf ?? ''}</b></span>`;
  return L.divIcon({ className: town ? 'wind-mk town' : 'wind-mk', html, iconSize: [30, 30] });
}

async function showWind(keepFrame) {
  const mode = S.layer.windMode || 'fc';
  if (mode === 'aloft') { await showWrf(keepFrame); return; }
  const scale = scaleFor('wind', S.settings.palette);
  const col = colourFn(scale);
  const hex = (bf) => { const c = col(bf ?? 0); return c[3] ? `rgb(${c[0]},${c[1]},${c[2]})` : '#ffffff'; };
  const ov = L.layerGroup();
  if (mode === 'obs') {
    const sts = S.stations.filter((s) => s.WS !== undefined && s.WD !== undefined && s.k !== 'rain');
    sts.forEach((s) => {
      const bf = beaufort(s.WS);
      L.marker([s.lat, s.lon], { icon: windArrow(s.WD, bf, hex(bf), ''), keyboard: false, pane: 'stations' })
        .bindTooltip(`${esc(s.n)}：${s.WS} m/s（${bf}級）${s.G !== undefined ? `・陣風 ${s.G} m/s（${beaufort(s.G)}級）` : ''}${windChill(s)}`).addTo(ov);
    });
    finishOverlay(ov);
    renderLegend({ label: '風力觀測（測站）', time: S.manifest?.layers?.stations?.time, kindOverride: 'wind',
      note: '箭頭指向風吹去的方向，數字為平均風蒲福風級；陣風見各測站說明。' });
    renderTimeControl();
    return;
  }
  const w = await loadWind();
  if (S.layer.id !== 'wind') return;
  if (!w || !w.times?.length) { clearOverlay(); renderLegend(null, '目前沒有風力預報資料'); return; }
  if (!keepFrame || S.layer.frame >= w.times.length) S.layer.frame = windNowIndex(w.times);
  const i = S.layer.frame;
  const towns = L.geoJSON({ type: 'FeatureCollection', features: S.towns }, {
    style: (f) => {
      const r = w.towns[f.properties.TOWNCODE];
      const bf = r?.[1]?.[i];
      return { color: '#555', weight: 0.5, fillColor: hex(bf), fillOpacity: bf ? S.settings.opacity : 0 };
    },
    onEachFeature: (f, layer) => {
      const r = w.towns[f.properties.TOWNCODE];
      if (!r) return;
      layer.bindTooltip(`${esc(normCounty(f.properties.COUNTYNAME))}${esc(f.properties.TOWNNAME)}：${windText(r, i)}`, { sticky: true });
    },
  });
  towns.addTo(ov);
  // One arrow per 42 px screen cell so the whole island is covered at any zoom: mountain hiking forecasts first (ridges are
  // windier than the township centres), strongest first, then the township centres for the cells that are still empty.
  const taken = new Set();
  const place = (lat, lon, bf, wd, tip, zi, town) => {
    const pt = S.map.latLngToLayerPoint([lat, lon]);
    const key = `${Math.floor(pt.x / 42)},${Math.floor(pt.y / 42)}`;
    if (taken.has(key)) return;
    taken.add(key);
    L.marker([lat, lon], { icon: windArrow(wd * 45, bf, hex(bf), '', town), keyboard: false, pane: 'spots', zIndexOffset: zi }).bindTooltip(tip).addTo(ov);
  };
  const spotPos = Object.fromEntries(S.spots.map((p) => [p.k, p]));
  w.mountains.filter((m) => m.w[0][i] !== null && m.w[2][i] !== null).sort((a, b) => (b.w[1][i] ?? 0) - (a.w[1][i] ?? 0)).forEach((m) => {
    const sp = spotPos[m.k] || m; // snapped summit position when available
    place(sp.lat, sp.lon, m.w[1][i], m.w[2][i], `${esc(m.n)}（登山預報）：${windText(m.w, i)}`, 200, false);
  });
  const centres = townCentres();
  Object.entries(w.towns).filter(([g, r]) => centres[g] && r[1]?.[i] != null && r[2]?.[i] != null).sort((a, b) => (b[1][1][i] ?? 0) - (a[1][1][i] ?? 0)).forEach(([g, r]) => {
    place(centres[g][0], centres[g][1], r[1][i], r[2][i], `${esc(centres[g][2])}（鄉鎮預報）：${windText(r, i)}`, 0, true);
  });
  finishOverlay(ov);
  const t = w.times[i];
  renderLegend({ label: '風力預報（蒲福風級）', start: t, end: new Date(new Date(t).getTime() + 3 * 3600e3).toISOString(), issued: w.issue, kindOverride: 'wind',
    note: `色塊為鄉鎮預報（平地），箭頭指向風吹去的方向（縮小時每個畫面格只畫一個：登山預報點優先，其餘為鄉鎮預報，顏色較淡；放大可看到更多），數字為平均風蒲福風級；點選或停留可看陣風與體感溫度。${w.gustSource ? `陣風僅提供鄉鎮（平地），為 Open-Meteo 數值模式預報（${fmtTime(w.gustSource.time)} 取得，CC BY 4.0），非氣象署發布；登山預報點不提供模式陣風（模式地形高度遠低於山頂，會低估）。` : '目前沒有陣風預報資料。'}6 級以上山區行走困難，8 級以上請避免稜線。` });
  renderTimeControl();
}

// ---------------------------------------------------------------- WRF winds aloft (CWA regional model, pressure levels)
export async function loadWrf() {
  if (!S.wrf) S.wrf = await getJSON('wrf.json', { optional: true });
  return S.wrf;
}

export async function loadWrf3() {
  if (S.wrf3 !== undefined) return S.wrf3;
  const w = await getJSON('wrf3.json', { optional: true });
  if (w) {
    // Winds are int16 (0.1 m/s) arrays of shape (steps, ny, nx), base64 encoded.
    w.dec = {};
    Object.entries(w.wind).forEach(([k, b64]) => {
      const bin = window.atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      w.dec[k] = new Int16Array(bytes.buffer);
    });
  }
  S.wrf3 = w;
  return w;
}

/** The loaded WRF wind dataset of the chosen resolution in one shape (null while it is not loaded): levels (0 = 10 m wind), heights, uv(level, step, cell). */
export function wrfDs() {
  const three = S.layer.wrfRes === '3';
  const w = three ? S.wrf3 : S.wrf;
  if (!w) return null;
  const n = three ? w.grid.nx * w.grid.ny : 0;
  // Altitude entries, lowest first: the 10 m wind (3 km only), the pressure levels, and the fixed altitudes interpolated between them (level < 0).
  const ents = [];
  if (three) ents.push({ lv: 0, z: 10, get: (k, c) => [w.dec.u10[k * n + c] / 10, w.dec.v10[k * n + c] / 10] });
  w.levels.forEach((lv, i) => ents.push({ lv, z: w.z[i], get: three ? (k, c) => [w.dec[`u${lv}`][k * n + c] / 10, w.dec[`v${lv}`][k * n + c] / 10] : (k, c) => [w.u[i][k][c] / 10, w.v[i][k][c] / 10] }));
  (w.alts || []).forEach((alt, i) => ents.push({ lv: -alt, z: alt, get: three ? (k, c) => [w.dec[`ua${alt}`][k * n + c] / 10, w.dec[`va${alt}`][k * n + c] / 10] : (k, c) => [w.ua[i][k][c] / 10, w.va[i][k][c] / 10] }));
  ents.sort((a, b) => a.z - b.z);
  return { res: three ? 3 : 15, steps: w.steps, init: w.init, grid: w.grid, levels: ents.map((e) => e.lv), z: ents.map((e) => e.z), uv: (li, k, c) => ents[li].get(k, c),
    src: three ? '區域數值模式 WRF 3 km 預報（M-A0064；顯示時降採樣為約 6 km 間距）' : '區域數值模式 WRF 15 km 預報（M-A0061）',
    desc: three ? '3 km 網格、每 6 小時一步、最長 84 小時' : '15 km 網格、每 6 小時一步、最長 72 小時' };
}

const fmtM = (m) => `${m.toLocaleString('en-US')} m`;
const wrfLevelText = (ds, li) => (ds.levels[li] === 0 ? '距地面 10 m' : ds.levels[li] < 0 ? `海拔 ${fmtM(-ds.levels[li])}（內插）` : `海拔${altText(ds.z[li])}（${ds.levels[li]} hPa 氣壓層）`);

/** Wind arrows on the WRF grid at one pressure level (or 10 m) and forecast step; thinned to about 36 px apart. */
async function showWrf(keepFrame) {
  if (S.layer.wrfRes === '3') await loadWrf3(); else await loadWrf();
  if (S.layer.id !== 'wind') return;
  const w = wrfDs();
  if (!w?.steps?.length) { clearOverlay(); renderLegend(null, '目前沒有氣象署 WRF 高空風場資料'); return; }
  if (!keepFrame || S.layer.frame >= w.steps.length) {
    const i = w.steps.findIndex((t) => new Date(t).getTime() >= Date.now() - 3 * 3600e3);   // the step nearest to now (the last one when all are past)
    S.layer.frame = i < 0 ? w.steps.length - 1 : i;
  }
  const li = Math.max(0, w.levels.indexOf(S.layer.wrfHpa ?? 850));
  const k = S.layer.frame;
  const col = colourFn(scaleFor('wind', S.settings.palette));
  const g = w.grid;
  const p0 = S.map.latLngToLayerPoint([g.lat0, g.lon0]);
  const p1 = S.map.latLngToLayerPoint([g.lat0 + g.res, g.lon0 + g.res]);
  const px = Math.max(1, Math.hypot(p1.x - p0.x, p1.y - p0.y) / Math.SQRT2);
  const stride = Math.max(1, Math.ceil(46 / px));   // about 46 px between arrows: the arrow and its number need room
  const bounds = S.map.getBounds().pad(0.1);
  const ov = L.layerGroup();
  for (let r = 0; r < g.ny; r += stride) {
    for (let c = 0; c < g.nx; c += stride) {
      const lat = g.lat0 + r * g.res; const lon = g.lon0 + c * g.res;
      if (!bounds.contains([lat, lon])) continue;
      const [u, v] = w.uv(li, k, r * g.nx + c);
      const ws = Math.hypot(u, v);
      const bf = beaufort(ws);
      const from = (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360;
      const rgb = col(bf);
      L.marker([lat, lon], { icon: windArrow(from, bf, `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`), keyboard: false, pane: 'spots', interactive: true })
        .bindTooltip(`${wrfLevelText(w, li)}：${esc(compass(from))} ${ws.toFixed(1)} m/s（${bf}級）`).addTo(ov);
    }
  }
  finishOverlay(ov);
  const lvl = w.levels[li] === 0 ? '距地面 10 m' : w.levels[li] < 0 ? `海拔 ${fmtM(-w.levels[li])}｜由氣壓層內插` : `海拔${altText(w.z[li])}｜${w.levels[li]} hPa 氣壓層`;
  renderLegend({ label: `${w.levels[li] === 0 ? '地面風' : '高空風場'}（WRF ${w.res} km・${lvl}）`, time: w.steps[k], issued: w.init, kindOverride: 'wind',
    src: w.src,
    note: `箭頭指向風吹去的方向，數字為蒲福風級。氣象署區域數值模式（${w.desc}）${w.levels[li] === 0 ? '' : w.levels[li] < 0 ? '；固定海拔的風由上下兩個氣壓層依高度內插而得，不是模式直接輸出，山區地形高於此海拔處為模式內推，僅供參考' : '，「海拔」為該氣壓層在臺灣上空的概略高度（hPa 是氣壓，不是高度）'}；高空風場可看出鋒面、噴流與颱風環流，稜線的實際風速另受地形加強。${w.res === 3 ? '3 km 模式的山區地形較細緻，但解析度高不代表一定更準，請與 15 km 版、測站及氣象署預報對照。' : ''}` });
  renderTimeControl();
}

// ---------------------------------------------------------------- WRF 3 km rain and temperature grids
/** Frames of the WRF 3 km layer: [{meta, time}] for the chosen mode (6-hour rain or 2 m temperature). */
function wrf3Frames() {
  const m = S.manifest?.layers?.wrf3;
  if (!m) return [];
  const list = S.layer.wrf3Mode === 'temp' ? m.temp : m.rain;
  return (list || []).map((x) => ({ meta: x.meta, time: m.steps[x.fh / 6] }));
}

/** Frames of the global-model layer: one per forecast day [{meta, time}] for the chosen mode (24-hour rain, sea-level pressure or 2 m temperature). */
function wrfgFrames() {
  const m = S.manifest?.layers?.wrfg;
  if (!m) return [];
  const k = ['rain', 'msl', 'temp'].includes(S.layer.wrfgMode) ? S.layer.wrfgMode : 'rain';
  return m.days.map((d) => ({ meta: d[k], time: d.time }));
}

function wrf3NowIndex(frames) {
  const i = frames.findIndex((f) => new Date(f.time).getTime() >= Date.now() - 3 * 3600e3);
  return i < 0 ? Math.max(0, frames.length - 1) : i;
}

// ---------------------------------------------------------------- river water level, reservoirs, debris-flow alerts
/** Round marker with a short text, coloured by status; the worst status is drawn first and crowded markers wait for zoom. */
function statusMarkers(items, kind, text, tip, pos) {
  const col = colourFn(scaleFor(kind, S.settings.palette));
  const ov = L.layerGroup();
  const placed = [];
  items.sort((a, b) => b.st - a.st || (b.sort ?? 0) - (a.sort ?? 0)).forEach((it) => {
    const pt = S.map.latLngToLayerPoint(pos(it));
    if (it.st === 0 && placed.some((q) => q.distanceTo(pt) < 42)) return;
    placed.push(pt);
    const c = col(it.st);
    const html = `<span class="vis-mk${it.st >= 2 ? ' alert' : ''}" style="--c:rgb(${c[0]},${c[1]},${c[2]})">${esc(text(it))}</span>`;
    L.marker(pos(it), { icon: L.divIcon({ className: 'vis-wrap', html, iconSize: [40, 20] }), keyboard: false, pane: 'stations', zIndexOffset: it.st * 100 })
      .bindTooltip(tip(it)).addTo(ov);
  });
  return ov;
}

async function showWater() {
  const h = await loadHydro();
  if (S.layer.id !== 'water') return;
  const mode = S.layer.waterMode || 'river';
  const list = mode === 'river' ? h?.rivers : h?.reservoirs;
  if (!list?.length) { clearOverlay(); renderLegend(null, mode === 'river' ? '目前沒有河川水位資料' : '目前沒有水庫資料'); renderTimeControl(); return; }
  const latest = list.map((r) => r.t).filter(Boolean).sort().pop();
  let ov;
  if (mode === 'river') {
    ov = statusMarkers(list.map((r) => ({ r, st: riverStatus(r), sort: r.wl })), 'water', (x) => x.r.wl.toFixed(1), (x) => riverTip(x.r), (x) => [x.r.lat, x.r.lon]);
  } else {
    ov = statusMarkers(list.map((r) => ({ r, st: reservoirStatus(r), sort: r.outflow ?? 0 })), 'rsv', (x) => (x.r.wl === null ? '—' : x.r.wl.toFixed(0)), (x) => reservoirTip(x.r), (x) => [x.r.lat, x.r.lon]);
  }
  finishOverlay(ov);
  renderLegend({ label: mode === 'river' ? '河川水位（水利署）' : '水庫水位與放流（水利署）', time: latest, kindOverride: mode === 'river' ? 'water' : 'rsv',
    unit: 'm', src: '即時水位資料（未經品管）', license: 'ogdl',
    note: mode === 'river'
      ? '數字為水位（公尺），顏色為是否達到該站的警戒水位（正常＝藍；三級＝黃、二級＝橘、一級＝紅；未公告警戒水位的站一律顯示藍色）。水位站只在放大後才全部顯示；溪流水位上漲很快，渡溪前請確認上游天氣。'
      : '數字為水位（公尺），顏色為放流狀態：灰＝無放流、藍＝放流中（含發電、供水）、橘＝預定洩洪（預洩洪）、紅＝溢洪道洩洪中。只列出能對到氣象署水庫景點位置的水庫。' });
  renderTimeControl();
}

async function showDebris() {
  const h = await loadHydro();
  if (S.layer.id !== 'debris') return;
  const alerts = h?.debris;
  if (alerts === null || alerts === undefined) { clearOverlay(); renderLegend(null, '目前沒有土石流警戒資料'); return; }
  const col = colourFn(scaleFor('debris', S.settings.palette));
  const level = (f) => {
    const a = townAlerts(h, f.properties.COUNTYNAME, f.properties.TOWNNAME);
    return a.length ? (a.some((x) => x.level === 'red') ? 2 : 1) : 0;
  };
  const ov = L.geoJSON({ type: 'FeatureCollection', features: S.towns }, {
    style: (f) => {
      const v = level(f);
      const c = v ? col(v) : null;
      return { color: v ? '#333' : '#aaa', weight: v ? 1.2 : 0.3, fillColor: c ? `rgb(${c[0]},${c[1]},${c[2]})` : '#fff', fillOpacity: v ? layerOpacity('debris') : 0 };
    },
    onEachFeature: (f, layer) => {
      const a = townAlerts(h, f.properties.COUNTYNAME, f.properties.TOWNNAME);
      if (a.length) layer.bindTooltip(`${esc(normCounty(f.properties.COUNTYNAME))}${esc(f.properties.TOWNNAME)}：${a.map((x) => `${x.level === 'red' ? '紅色' : '黃色'}警戒${x.village ? `（${esc(x.village)}）` : ''}`).join('、')}`, { sticky: true });
    },
  });
  finishOverlay(L.layerGroup([ov]));
  renderLegend({ label: alerts.length ? `土石流警戒（${alerts.length} 條溪流）` : '土石流警戒', time: h.time, kindOverride: 'debris', unit: '',
    src: '農業部農村發展及水土保持署土石流警戒', license: 'ogdl',
    note: alerts.length ? '色塊為有土石流警戒的鄉鎮（以鄉鎮為單位，並非精確到溪流）。黃色警戒：降雨已達警戒基準，應準備疏散；紅色警戒：已達應疏散的程度。山區步道、林道與溪谷請避開。'
      : '目前沒有任何土石流警戒（水保署只在發布警戒時才有資料）。豪雨與颱風期間請隨時回來查看。' });
  renderTimeControl();
}

// ---------------------------------------------------------------- rain probability, UV, visibility
/** Township choropleth: colour from value(code) (null = no fill); tooltip text from tip(code). */
function townChoropleth(scale, value, tip) {
  const col = colourFn(scale);
  return L.geoJSON({ type: 'FeatureCollection', features: S.towns }, {
    style: (f) => {
      const v = value(f.properties.TOWNCODE);
      const c = v === null || v === undefined ? null : col(v);
      return { color: '#555', weight: 0.5, fillColor: c?.[3] ? `rgb(${c[0]},${c[1]},${c[2]})` : '#fff', fillOpacity: c?.[3] ? layerOpacity(S.layer.id) : 0 };
    },
    onEachFeature: (f, layer) => {
      const t = tip(f.properties.TOWNCODE);
      if (t) layer.bindTooltip(`${esc(normCounty(f.properties.COUNTYNAME))}${esc(f.properties.TOWNNAME)}：${t}`, { sticky: true });
    },
  });
}

async function showPop(keepFrame) {
  const w = await loadWind();
  if (S.layer.id !== 'pop') return;
  if (!w?.times?.length) { clearOverlay(); renderLegend(null, '目前沒有降雨機率預報資料'); return; }
  if (!keepFrame || S.layer.frame >= w.times.length) S.layer.frame = windNowIndex(w.times);
  const i = S.layer.frame;
  const ov = L.layerGroup();
  townChoropleth(scaleFor('pop', S.settings.palette), (g) => w.towns[g]?.[5]?.[i] ?? null, (g) => {
    const v = w.towns[g]?.[5]?.[i];
    return v === null || v === undefined ? '無預報' : `${v}%`;
  }).addTo(ov);
  finishOverlay(ov);
  const t = w.times[i];
  renderLegend({ label: '降雨機率（鄉鎮・3 小時）', start: t, end: new Date(new Date(t).getTime() + 3 * 3600e3).toISOString(), issued: w.issue,
    kindOverride: 'pop', unit: '%', src: '鄉鎮天氣預報',
    note: '機率為該 3 小時內「出現降雨」的可能性（降雨機率 30% 表示 10 次類似天氣約 3 次下雨），並非雨勢大小；雨量請看雨量圖層。10% 以下不著色。' });
  renderTimeControl();
}

export const HEAT_WARN = ['', '注意', '警戒', '危險', '極度危險'];

export async function loadHeat() {
  if (!S.heat) S.heat = await getJSON('heat.json', { optional: true });
  return S.heat;
}

async function showHeat(keepFrame) {
  const h = await loadHeat();
  if (S.layer.id !== 'heat') return;
  if (!h?.times?.length) { clearOverlay(); renderLegend(null, '目前沒有熱傷害指數預報資料'); return; }
  if (!keepFrame || S.layer.frame >= h.times.length) S.layer.frame = windNowIndex(h.times);
  const i = S.layer.frame;
  const ov = L.layerGroup();
  townChoropleth(scaleFor('heat', S.settings.palette), (g) => h.towns[g]?.[0]?.[i] ?? null, (g) => {
    const r = h.towns[g];
    if (r?.[0]?.[i] === null || r?.[0]?.[i] === undefined) return '無預報';
    return `熱傷害指數 ${r[0][i]}${r[1][i] ? `（${HEAT_WARN[r[1][i]]}）` : ''}`;
  }).addTo(ov);
  finishOverlay(ov);
  const t = h.times[i];
  renderLegend({ label: '熱傷害指數（鄉鎮・3 小時）', start: t, end: new Date(new Date(t).getTime() + 3 * 3600e3).toISOString(), issued: h.issue,
    kindOverride: 'heat', unit: '', src: '中央氣象署 健康氣象熱傷害指數（M-A0085）',
    note: '依氣溫、濕度等估算的人體熱危害程度。分級：27–31 注意、32–35 警戒、36–39 危險、40 以上極度危險；27 以下為淡色。滑鼠指到或點鄉鎮可看氣象署發布的警示。炎熱日請避開正午、補充水分與鹽分。' });
  renderTimeControl();
}

/** Dates (YYYY-MM-DD) with a township UV forecast, in order. */
function uvDates(w) {
  const set = new Set();
  Object.values(w.uv || {}).forEach((l) => l.forEach(([d]) => set.add(d)));
  return [...set].sort();
}

const UV_LEVEL = (v) => (v >= 11 ? '危險級' : v >= 8 ? '過量級' : v >= 6 ? '高量級' : v >= 3 ? '中量級' : '低量級');

async function showUV() {
  const w = await loadWind();
  if (S.layer.id !== 'uv') return;
  const dates = w ? uvDates(w) : [];
  if (!dates.length) { clearOverlay(); renderLegend(null, '目前沒有紫外線預報資料'); return; }
  const di = Math.min(S.layer.period, dates.length - 1);
  const d = dates[di];
  const at = (g) => w.uv[g]?.find((x) => x[0] === d)?.[1] ?? null;
  const ov = L.layerGroup();
  townChoropleth(scaleFor('uv', S.settings.palette), at, (g) => { const v = at(g); return v === null ? '無預報' : `UV ${v}（${UV_LEVEL(v)}）`; }).addTo(ov);
  finishOverlay(ov);
  renderLegend({ label: `紫外線指數預報（${d.slice(5).replace('-', '/')}）`, time: w.issue, kindOverride: 'uv', unit: '', src: '鄉鎮天氣預報',
    note: '為當日白天最大值（天氣晴朗時）。分級：0–2 低量級、3–5 中量級、6–7 高量級、8–10 過量級、11 以上危險級。3 以上建議防曬，6 以上減少正午曝曬，8 以上盡量避開。海拔每升高 1,000 m 紫外線約增加 10%，雪地與水面會再反射，高山請加強防護。' });
  renderTimeControl();
}

/** Visibility text of a station ("10", ">30", "0.8") -> km, or null. */
function visKm(s) {
  const n = parseFloat(String(s).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

async function showVisibility(keepFrame) {
  const mode = S.layer.visMode || 'obs';
  const w = await loadWind();
  if (S.layer.id !== 'visib') return;
  if (w?.times?.length && (!keepFrame || S.layer.frame >= w.times.length)) S.layer.frame = windNowIndex(w.times);
  const scale = scaleFor('visib', S.settings.palette);
  const col = colourFn(scale);
  const rgb = (v) => { const c = col(v); return `rgb(${c[0]},${c[1]},${c[2]})`; };
  const ov = L.layerGroup();
  const fog = (S.warnings?.counties || []).flatMap((c) => c.hazards.filter((h) => /霧/.test(h.ph)).map((h) => `${normCounty(c.county)}${h.ph}${h.sig || ''}`));
  const fogNote = fog.length ? `目前有濃霧特報：${fog.join('、')}。` : '';
  if (mode === 'obs') {
    S.stations.filter((s) => s.vis !== undefined && visKm(s.vis) !== null).forEach((s) => {
      const v = visKm(s.vis);
      const html = `<span class="vis-mk" style="--c:${rgb(v)}">${esc(String(s.vis))}</span>`;
      L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'vis-wrap', html, iconSize: [34, 20] }), keyboard: false, pane: 'stations' })
        .bindTooltip(`${esc(s.n)}：能見度 ${esc(String(s.vis))} km${v < 1 ? '（濃霧）' : v < 2 ? '（有霧）' : ''}`).addTo(ov);
    });
    finishOverlay(ov);
    renderLegend({ label: '能見度（測站觀測）', time: S.manifest?.layers?.stations?.time, kindOverride: 'visib', unit: 'km',
      note: `${fogNote}能見度只有有人員觀測的局屬測站才提供；山區沒有測站的地方請看「預報」模式（數值模式）。分級：低於 1 km 濃霧、1–2 km 有霧、2–5 km 能見度差、5–10 km 普通、10–20 km 良好、20 km 以上極佳。山區濃霧容易迷途，請放慢速度並確認航跡。` });
    renderTimeControl();
    return;
  }
  const a = await loadAloft();
  if (S.layer.id !== 'visib') return;
  if (!a?.times?.length || !w?.times?.length) { clearOverlay(); renderLegend(null, '目前沒有能見度預報資料'); return; }
  const k = stepOf(a.times, w.times[S.layer.frame]);
  const spotPos = Object.fromEntries(S.spots.map((p) => [p.k, p]));
  // Poorest visibility first; markers closer than 40 px to one already drawn wait until the map is zoomed in.
  const placed = [];
  Object.entries(a.points).filter(([key, p]) => spotPos[key] && p.vis[k] !== null).sort((x, y) => x[1].vis[k] - y[1].vis[k]).forEach(([key, p]) => {
    const v = p.vis[k];
    const sp = spotPos[key];
    const pt = S.map.latLngToLayerPoint([sp.lat, sp.lon]);
    if (placed.some((q) => q.distanceTo(pt) < 40)) return;
    placed.push(pt);
    const html = `<span class="vis-mk" style="--c:${rgb(v)}">${v >= 30 ? '>30' : v.toFixed(v < 10 ? 1 : 0)}</span>`;
    L.marker([sp.lat, sp.lon], { icon: L.divIcon({ className: 'vis-wrap', html, iconSize: [34, 20] }), keyboard: false, pane: 'spots' })
      .bindTooltip(`${esc(sp.n)}：能見度約 ${v} km${v < 1 ? '（濃霧）' : v < 2 ? '（有霧）' : ''}`).addTo(ov);
  });
  finishOverlay(ov);
  const t = w.times[S.layer.frame];
  renderLegend({ label: '能見度預報（登山預報點）', start: t, end: new Date(new Date(t).getTime() + 3 * 3600e3).toISOString(), time: a.time,
    kindOverride: 'visib', unit: 'km', license: 'open-meteo',
    note: `${fogNote}Open-Meteo 數值模式預報（CC BY 4.0），非氣象署發布；模式對山區局部霧氣的掌握有限，僅供參考。` });
  renderTimeControl();
}

/** "東北風 6 m/s（4級）・陣風 12 m/s（6級）・體感 18°" for forecast step i of [ws, bf, wd, gust, at] columns. */
export function windText(cols, i) {
  const [ws, bf, wd, g, at] = [0, 1, 2, 3, 4].map((k) => cols[k]?.[i] ?? null);
  return [`${WIND_DIRS[wd] || ''} ${ws ?? '—'} m/s（${bf ?? '—'}級）`, g !== null ? `陣風 ${g} m/s（${beaufort(g)}級）` : null,
    at !== null ? `體感 ${at}°C` : null].filter(Boolean).join('・');
}

/** Estimated apparent temperature for a station tooltip. */
function windChill(s) {
  const at = apparentTemp(s.T, s.RH, s.WS);
  return at === null ? '' : `・體感約 ${at}°C`;
}

function finishOverlay(ov) {
  if (!S.layer.hidden) ov.addTo(S.map);
  clearOverlay();
  S.layer.overlay = ov;
}

// ---------------------------------------------------------------- lightning
export async function loadLightning() {
  if (!S.lightning) S.lightning = await getJSON('lightning.json', { optional: true });
  return S.lightning;
}

/** Strikes within km of a point during the last hour: { n, nearest km }. */
export function lightningNear(lat, lon, km = 15) {
  const list = (S.lightning?.strikes || []).map((s) => haversineKm(lat, lon, s.lat, s.lon)).filter((d) => d <= km);
  return { n: list.length, nearest: list.length ? Math.min(...list) : null };
}

async function showLightning() {
  const lt = await loadLightning();
  if (S.layer.id !== 'lightning') return;
  if (!lt) { clearOverlay(); renderLegend(null, '目前沒有閃電資料'); return; }
  const scale = scaleFor('ltage', S.settings.palette);
  const col = colourFn(scale);
  const end = new Date(lt.end || Date.now()).getTime();
  const ov = L.layerGroup();
  lt.strikes.forEach((s) => {
    const age = s.t ? Math.max(0, (end - new Date(s.t).getTime()) / 60e3) : 59;
    const c = col(age);
    const icon = L.divIcon({ className: `lt-mk${s.cloud ? ' cloud' : ''}`, iconSize: [16, 16],
      html: `<svg viewBox="0 0 16 16" style="--c:rgb(${c[0]},${c[1]},${c[2]})" aria-hidden="true"><path d="M9.5 1 3 9h4l-1 6 6.5-8.5H8.5z"/></svg>` });
    L.marker([s.lat, s.lon], { icon, keyboard: false, pane: 'spots' })
      .bindTooltip(`${s.cloud ? '雲間閃電' : '對地閃電'}${s.t ? `・${esc(fmtTime(s.t))}` : ''}${s.ka !== null ? `・${s.ka} kA` : ''}`).addTo(ov);
  });
  finishOverlay(ov);
  renderLegend({ label: `閃電（過去 1 小時 ${lt.count} 次）`, start: lt.start, end: lt.end, kindOverride: 'ltage',
    note: lt.count ? '實心為對地閃電、空心為雲間閃電。看到閃電或聽到雷聲應立即離開稜線、山頂與空曠處。' : '過去 1 小時臺灣附近沒有偵測到閃電。' });
  renderTimeControl();
}

/** Temporarily hide / restore the weather overlay (e.g. while the shakemap is shown). */
export function setWeatherVisible(on) {
  const ov = S.layer.overlay;
  S.layer.hidden = !on;
  if (!ov) return;
  if (on && !S.map.hasLayer(ov)) ov.addTo(S.map);
  if (!on && S.map.hasLayer(ov)) S.map.removeLayer(ov);
}

/** Weather layers default to 70 % so the map shows through; the satellite picture defaults to 100 % (it is a picture, not a thin overlay). */
export function layerOpacity(id = S.layer.id) {
  return id === 'sat' ? (S.settings.satOpacity ?? 1) : S.settings.opacity;
}

export function setOpacity(v) {
  if (S.layer.id === 'sat') S.settings.satOpacity = v; else S.settings.opacity = v;
  const ov = S.layer.overlay;
  if (!ov) return;
  if (ov.setOpacity) ov.setOpacity(v);
  else if (ov.setStyle) ov.eachLayer((l) => { if (l.options.fillOpacity) l.setStyle({ fillOpacity: v }); });
  else ov.eachLayer((l) => l.setOpacity && l.setOpacity(v));
}

export function renderLegend(meta, message) {
  const el = document.getElementById('legend');
  const def = layerDef(S.layer.id);
  if (!S.legendInit) {
    // Expanded by default on wide screens, collapsed on phones; remembers the user's choice.
    el.open = window.innerWidth >= 700 && window.innerHeight >= 600;
    el.addEventListener('toggle', () => { S.legendOpen = el.open; });
    S.legendInit = true;
  }
  if (S.legendOpen !== undefined) el.open = S.legendOpen;
  if (message) {
    el.innerHTML = `<summary><span class="lg-unit"><small>說明</small></span></summary><div class="lg-body"><p>${esc(message)}</p></div>`;
    el.hidden = false;
    setBanner(def.label, '');
    return;
  }
  if (!meta || def.kind === 'none') { el.hidden = true; el.innerHTML = ''; setBanner('', ''); return; }
  const kind = meta.kindOverride || def.kind;
  let body = '';
  let strip = '';
  if (kind !== 'sat') {
    const scale = scaleFor(kind, S.settings.palette);
    const unit = meta.unit || def.unit || '';
    if (scale.length > 30) {
      // Continuous satellite scale: gradient bar with a few labels.
      const stops = scale.map((x, i) => `${x[1]} ${(i / (scale.length - 1) * 100).toFixed(1)}%`).join(',');
      const lo = scale[0][0]; const hi = scale[scale.length - 1][0];
      const fmt = (v) => (kind === 'vis' ? `${Math.round(v * 100)}%` : `${v}${unit}`);
      strip = `<span class="lg-strip grad-v"><span class="grad" style="background:linear-gradient(0deg,${stops})"></span><span class="ticks"><span style="bottom:0">${esc(fmt(lo))}</span><span style="bottom:50%">${esc(fmt((lo + hi) / 2))}</span><span style="bottom:100%">${esc(fmt(hi))}</span></span></span>`;
      body = (kind === 'vis' ? '<p class="note">可見光僅白天可用（夜間為黑色）。</p>' : '<p class="note">越白（或越鮮豔）代表雲頂越高、越冷，常伴隨強對流。</p>');
    } else {
      body = '<ol class="swatches">' + scale.map((x, i) => `<li><span class="sw" style="background:${x[1]}"></span>${esc(classLabel(scale, i, unit))}</li>`).reverse().join('') + '</ol>';
      strip = colourStrip(scale, kind);
    }
    if (SPACING_KINDS.includes(kind) || meta.spacing) {
      const cur = S.settings.rainSpacing === 'big' ? 'big' : 'small';
      const over = kind !== 'rainbig' && Number(meta.max ?? meta.tyMax) > 300;
      body = `<div class="seg lg-spacing" role="radiogroup" aria-label="色階間距">${[['small', '小間距'], ['big', '大間距']]
        .map(([k, l]) => `<button type="button" class="seg-btn" role="radio" data-spacing="${k}" aria-checked="${k === cur}">${l}</button>`).join('')}</div>
<p class="note">${kind === 'rainbig' ? '目前為大間距色階（1、10、20、60、100…2000 mm，色系依雨量換色）。' : '目前為小間距色階（氣象署原色，1、2、6、10…300 mm 以上）。'}</p>
${over ? `<p class="warn-txt">最大值 ${Math.round(meta.max ?? meta.tyMax)} mm 超過小間距最高級距（300 mm），可改選大間距看出差異。</p>` : ''}${body}`;
    }
  }
  let when = '';
  if (meta.start && meta.end) when = `${fmtTime(meta.start)} ～ ${fmtTime(meta.end)}`;
  else if (meta.period) when = meta.period;
  else if (meta.time) when = fmtTime(meta.time);
  const title = meta.title ? `<img class="qpf-title" src="data/${esc(meta.title)}" alt="氣象署原圖標題（含發布與有效時間）">` : '';
  const note = meta.note ? `<p class="note">${esc(meta.note)}</p>` : '';
  const qpfNote = meta.kind === 'class' ? '<p class="note">由氣象署定量降水預報圖自動對位轉換；時間以原圖標題為準。</p>' : '';
  // The layer name and time go to the banner at the top of the map; the legend keeps the unit and colours.
  setBanner((meta.label || def.label).replace(/（雨量站內插）/, ''), when);
  const [u1, u2] = legendUnit(kind, meta.unit || def.unit);
  el.innerHTML = `<summary><span class="lg-unit"><small>${esc(u1)}</small><b>${esc(u2)}</b></span>${strip}</summary>
<div class="lg-body">${title}${body}${note}${qpfNote}${attribution(meta)}</div>`;
  el.querySelectorAll('[data-spacing]').forEach((b) => b.addEventListener('click', () => {
    S.settings.rainSpacing = b.dataset.spacing;
    saveSettings(S.settings);
    showLayer(S.layer.id, { keepFrame: true });
  }));
  el.hidden = false;
}

/** Unit shown on two lines in the legend: ['單位', 'mm']. */
function legendUnit(kind, unit) {
  if (kind === 'wind') return ['單位', '風級'];
  if (kind === 'ltage') return ['單位', '分鐘前'];
  if (kind === 'pop') return ['單位', '%'];
  if (kind === 'water') return ['單位', 'm'];
  if (kind === 'rsv') return ['狀態', '放流'];
  if (kind === 'debris') return ['等級', '警戒'];
  if (kind === 'uv') return ['單位', '指數'];
  if (kind === 'heat') return ['單位', '指數'];
  if (kind === 'msl') return ['單位', 'hPa'];
  if (kind === 'visib') return ['單位', 'km'];
  if (kind === 'intensity') return ['單位', '震度'];
  if (kind === 'vis') return ['單位', '反照率'];
  if (kind === 'irgray' || kind === 'irenh') return ['單位', '°C'];
  return ['單位', unit || '—'];
}

/** Banner at the top centre of the map: layer name and data time (hidden when empty). */
export function setBanner(name, when) {
  const b = document.getElementById('map-banner');
  if (!b) return;
  b.hidden = !name;
  b.innerHTML = name ? `<strong>${esc(name)}</strong>${when ? `<span class="bn-time">${esc(when)}</span>` : ''}` : '';
}

/** Always-visible colour bar (like the CWA maps): one cell per class, boundary values underneath. */
function colourStrip(scale, kind) {
  // Vertical bar like the CWA maps: highest class on top, each label at its class's lower edge.
  const n = scale.length;
  const step = n > 13 ? 2 : 1;
  const cells = scale.map((x) => `<span style="background:${x[1]}"></span>`).reverse().join('');
  const lbls = scale.map((x, i) => {
    if ((n - 1 - i) % step) return ''; // count down from the top class so the highest value is always labelled
    const text = kind === 'ltage' ? String(x[0]) : (x[2] || (kind === 'temp' ? `${x[0]}°` : String(x[0])));
    return `<span style="bottom:${(i / n * 100).toFixed(2)}%">${esc(text)}</span>`;
  }).join('');
  return `<span class="lg-strip" style="--n:${n};--ch:${n > 16 ? 8 : n > 13 ? 9.5 : 12.5}px"><span class="cells">${cells}</span><span class="ticks">${lbls}</span></span>`;
}

/** Attribution block (顯名聲明); derived products carry the full statement and a disclaimer. */
const CWA_WEB_TERMS = 'https://www.cwa.gov.tw/V8/C/information.html';

export function attribution(meta) {
  const year = (meta.issued || meta.time || meta.start || '').slice(0, 4) || new Date().getFullYear();
  const version = meta.issued || meta.time || '';
  if (meta.derived) {
    return `<div class="attr"><p><strong>中央氣象署 ${esc(year)} 定量降水預報（${esc(meta.src || '')}，發布 ${esc(fmtTime(version))}）</strong></p>
<p>${esc(OGDL_TEXT)} 政府資料開放授權條款：<a href="${OGDL_URL}" target="_blank" rel="noopener">${OGDL_URL}</a></p>
<p class="warn-txt">本圖為本網站將上述各時段預報加總計算之衍生資料，非中央氣象署發布之預報，未經中央氣象署審閱。${esc(meta.method || '')}</p></div>`;
  }
  if (meta.license === 'ogdl') {
    return `<p class="src">資料來源：${esc(meta.src || '')}${version ? `（${esc(fmtTime(version))}）` : ''}・依<a href="${OGDL_URL}" target="_blank" rel="noopener">政府資料開放授權條款</a>釋出</p>`;
  }
  if (meta.license === 'open-meteo') {
    return `<p class="src">資料來源：<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> 數值模式預報${version ? `（${esc(fmtTime(version))} 取得）` : ''}・CC BY 4.0；非氣象署發布</p>`;
  }
  if (meta.license === 'cwa-web') {
    return `<p class="src">資料來源：中央氣象署全球資訊網 ${esc(meta.src || '')}${version ? `（發布 ${esc(fmtTime(version))}）` : ''}・依<a href="${CWA_WEB_TERMS}" target="_blank" rel="noopener">政府網站資料開放宣告</a>引用；本網站將原圖自動對位並依圖例換算為級距，<a href="${esc(meta.url || CWA_WEB_TERMS)}" target="_blank" rel="noopener">原圖</a></p>`;
  }
  return `<p class="src">資料來源：中央氣象署 ${esc(year)} ${esc(meta.src || '')}${version ? `（${esc(fmtTime(version))}）` : ''}・依<a href="${OGDL_URL}" target="_blank" rel="noopener">政府資料開放授權條款</a>釋出</p>`;
}

export function renderTimeControl(meta) {
  const el = document.getElementById('time-ctl');
  const id = S.layer.id;
  let h = '';
  if (id === 'radar') {
    const frames = S.manifest?.layers?.radarFrames?.frames || [];
    if (frames.length > 1) {
      h = `<div class="tc-play">${playButton()}
<label class="range"><span class="sr-only">雷達時間</span><input id="frame" type="range" min="0" max="${frames.length - 1}" value="${S.layer.frame}" aria-valuetext="${esc(fmtTime(frames[S.layer.frame]?.time))}"></label>
<output id="frame-time">${esc(fmtTime(frames[S.layer.frame]?.time, { date: false }))}</output></div>`;
    }
  } else if (id === 'wrf3') {
    const mode = S.layer.wrf3Mode || 'rain';
    const fr = wrf3Frames();
    const t = fr[S.layer.frame]?.time;
    h = modeTabs('WRF 3 km 項目', [['rain', '6小時降水'], ['temp', '2 m 氣溫']], 'wrf3mode', mode, { rain: '☂', temp: '🌡' });
    if (fr.length) {
      h += `<div class="tc-play">${playButton()}<label class="range"><span class="sr-only">預報時間</span><input id="wrf3-frame" type="range" min="0" max="${fr.length - 1}" value="${S.layer.frame}" aria-valuetext="${esc(fmtTime(t))}"></label>
<output id="wrf3-time">${esc(fmtTime(t))}</output></div>`;
    }
  } else if (id === 'wrfg') {
    const mode = S.layer.wrfgMode || 'rain';
    const fr = wrfgFrames();
    const t = fr[S.layer.frame]?.time;
    h = modeTabs('全球模式項目', [['rain', '24小時降水'], ['msl', '海平面氣壓'], ['temp', '2 m 氣溫']], 'wrfgmode', mode, { rain: '☂', msl: '◎', temp: '🌡' });
    if (fr.length) {
      h += `<div class="tc-play">${playButton()}<label class="range"><span class="sr-only">預報日期</span><input id="wrfg-frame" type="range" min="0" max="${fr.length - 1}" value="${S.layer.frame}" aria-valuetext="${esc(fmtTime(t))}"></label>
<output id="wrfg-time">第 ${S.layer.frame + 1} 天 ${esc(fmtTime(t, { date: true }))}</output></div>`;
    }
  } else if (id === 'rainacc') {
    const periods = S.manifest?.layers?.rainacc?.periods || [];
    h = '<div class="seg" role="radiogroup" aria-label="累積時段">' + periods.map((p, i) => `<button class="seg-btn" role="radio" aria-checked="${i === S.layer.period}" data-period="${i}">${esc(p.label)}</button>`).join('') + '</div>';
  } else if (id === 'qpf') {
    const L_ = S.manifest?.layers || {};
    const mode = S.layer.qpfMode || '12';
    const has6 = Boolean(L_.qpf6?.available);
    h = '<div class="seg tabs" role="radiogroup" aria-label="預報種類">' + QPF_MODES.map((m) => {
      const off = m.id === '6' && !has6;
      return `<button class="seg-btn" role="radio" aria-checked="${m.id === mode}" data-qpfmode="${m.id}"${off ? ' aria-disabled="true" title="目前無法取得6小時定量降水預報"' : ''}>${esc(m.label)}${off ? '（暫無）' : ''}</button>`;
    }).join('') + '</div>';
    let periods = [];
    if (mode === '6') periods = (L_.qpf6?.periods || []).map((p, i) => ({ label: `${fmtTime(p.start)}–${fmtTime(p.end || new Date(new Date(p.start).getTime() + 6 * 3600e3).toISOString(), { date: false })}`, i }));
    else if (mode === 'acc') periods = (L_.qpfacc?.periods || []).map((p, i) => ({ label: `未來${p.hours}小時`, i }));
    else periods = (L_.qpf?.periods || []).map((p, i) => ({ label: `${fmtTime(p.start)}–${fmtTime(new Date(new Date(p.start).getTime() + 12 * 3600e3).toISOString(), { date: false })}`, i }));
    h += '<div class="seg" role="radiogroup" aria-label="預報時段">' + periods.map((p) => `<button class="seg-btn" role="radio" aria-checked="${p.i === S.layer.period}" data-period="${p.i}">${esc(p.label)}</button>`).join('') + '</div>';
  } else if (id === 'sat') {
    const list = satGrids().ir ? SAT_MODES : S.sat;
    h = '<div class="seg tabs" role="radiogroup" aria-label="雲圖種類">' + list.map((x, i) => `<button class="seg-btn" role="radio" aria-checked="${i === S.layer.frame}" data-frame="${i}">${esc(x.label)}</button>`).join('') + '</div>';
  } else if (id === 'tyrain') {
    const t = S.typhoon?.tables || {};
    h = '<div class="seg" role="radiogroup" aria-label="雨量預測種類">'
      + (t.rain24 ? `<button class="seg-btn" role="radio" aria-checked="${S.layer.period === 0}" data-period="0">24小時雨量</button>` : '')
      + (t.rainTotal ? `<button class="seg-btn" role="radio" aria-checked="${S.layer.period === 1}" data-period="1">總雨量</button>` : '') + '</div>';
  } else if (id === 'water') {
    const mode = S.layer.waterMode || 'river';
    h = modeTabs('水情資料', [['river', '河川水位'], ['rsv', '水庫放流']], 'watermode', mode, { river: '≈', rsv: '▥' });
  } else if (id === 'wind' || id === 'pop' || id === 'visib' || id === 'uv' || id === 'heat') {
    const mode = id === 'wind' ? (S.layer.windMode || 'fc') : id === 'visib' ? (S.layer.visMode || 'obs') : 'fc';
    const times = (id === 'heat' ? S.heat?.times : S.wind?.times) || [];
    if (id === 'wind') {
      h = modeTabs('風力資料', [['fc', '預報'], ['aloft', '高空風'], ['obs', '測站觀測']], 'windmode', mode, { fc: '◷', aloft: '▲', obs: '◎' });
      const w = mode === 'aloft' ? wrfDs() : null;
      if (mode === 'aloft') {
        // One row: the model resolution switch and the altitude buttons (they scroll sideways).
        let row = '';
        if (S.manifest?.layers?.wrf3) {
          row += '<div class="seg res" role="radiogroup" aria-label="模式解析度">' + [['15', '15 km'], ['3', '3 km']]
            .map(([k, l]) => `<button class="seg-btn" role="radio" aria-checked="${k === (S.layer.wrfRes || '15')}" data-wrfres="${k}">${l}</button>`).join('') + '</div>';
        }
        if (w?.steps?.length) {
          const cur = Math.max(0, w.levels.indexOf(S.layer.wrfHpa ?? 850));
          const icon = S.settings.ui === 'icon';
          row += '<div class="seg levels" role="radiogroup" aria-label="高空風海拔">' + w.levels.map((lv, li) => {
            const big = lv === 0 ? '10 m' : lv < 0 ? fmtM(-lv) : altText(w.z[li]).replace(/^約\s*/, '');
            return `<button class="seg-btn alt" role="radio" aria-checked="${li === cur}" data-wrflevel="${li}">${icon ? levelIcon(w.z[li]) : ''}<b>${esc(big)}</b><span class="hpa">${lv === 0 ? '地面風' : lv < 0 ? '內插' : `${lv} hPa`}</span></button>`;
          }).join('') + '</div>';
        }
        if (row) h += `<div class="tc-row">${row}</div>`;
      }
      if (w?.steps?.length) {
        const t = w.steps[S.layer.frame] || w.steps[0];
        h += `<div class="tc-play">${playButton()}<label class="range"><span class="sr-only">預報時間</span><input id="wrf-frame" type="range" min="0" max="${w.steps.length - 1}" value="${S.layer.frame}" aria-valuetext="${esc(fmtTime(t))}"></label>
<output id="wrf-time">${esc(fmtTime(t))}</output></div>`;
      }
    } else if (id === 'visib') {
      h = modeTabs('能見度資料', [['obs', '測站觀測'], ['fc', '預報']], 'vismode', mode, { obs: '◎', fc: '◷' });
    } else if (id === 'uv') {
      const dates = S.wind ? uvDates(S.wind) : [];
      h = '<div class="seg" role="radiogroup" aria-label="日期">' + dates.map((d, i) => `<button class="seg-btn" role="radio" aria-checked="${i === S.layer.period}" data-period="${i}">${esc(d.slice(5).replace('-', '/'))}</button>`).join('') + '</div>';
    }
    if (mode === 'fc' && id !== 'uv' && times.length) {
      const t = times[S.layer.frame] || times[0];
      h += `<div class="tc-play">${playButton()}<label class="range"><span class="sr-only">預報時間</span><input id="wind-frame" type="range" min="0" max="${times.length - 1}" value="${S.layer.frame}" aria-valuetext="${esc(fmtTime(t))}"></label>
<output id="wind-time">${esc(fmtTime(t))}</output></div>`;
    }
  } else if (meta?.time) {
    h = `<span class="muted">資料時間 ${esc(fmtTime(meta.time))}</span>`;
  }
  el.innerHTML = h;
  // The altitude buttons scroll sideways: bring the chosen one into view and fade the right edge while more are hidden.
  const lv = el.querySelector('.seg.levels');
  if (lv) {
    const act = lv.querySelector('[aria-checked="true"]');
    if (act) lv.scrollLeft = Math.max(0, act.offsetLeft - (lv.clientWidth - act.offsetWidth) / 2);
    const hint = () => lv.classList.toggle('more', lv.scrollLeft + lv.clientWidth < lv.scrollWidth - 4);
    lv.addEventListener('scroll', hint, { passive: true });
    hint();
  }
  const frame = el.querySelector('#frame');
  if (frame) {
    frame.addEventListener('input', () => {
      stopAnimation();
      S.layer.frame = Number(frame.value);
      showLayer('radar', { keepFrame: true });
    });
  }
  el.querySelectorAll('[data-windmode]').forEach((b) => b.addEventListener('click', () => {
    S.layer.windMode = b.dataset.windmode;
    showLayer('wind', { keepFrame: false });   // each mode starts at its own "now" step
  }));
  el.querySelectorAll('[data-wrflevel]').forEach((b) => b.addEventListener('click', () => {
    S.layer.wrfHpa = wrfDs().levels[Number(b.dataset.wrflevel)];
    showLayer('wind', { keepFrame: true });
  }));
  el.querySelectorAll('[data-wrfres]').forEach((b) => b.addEventListener('click', () => {
    S.layer.wrfRes = b.dataset.wrfres;
    showLayer('wind', { keepFrame: false });
  }));
  el.querySelectorAll('[data-wrf3mode]').forEach((b) => b.addEventListener('click', () => {
    S.layer.wrf3Mode = b.dataset.wrf3mode;
    showLayer('wrf3', { keepFrame: false });
  }));
  el.querySelectorAll('[data-wrfgmode]').forEach((b) => b.addEventListener('click', () => {
    S.layer.wrfgMode = b.dataset.wrfgmode;
    showLayer('wrfg', { keepFrame: true });
  }));
  const wg = el.querySelector('#wrfg-frame');
  if (wg) {
    wg.addEventListener('input', () => { stopAnimation(); el.querySelector('#wrfg-time').textContent = `第 ${Number(wg.value) + 1} 天 ${fmtTime(wrfgFrames()[Number(wg.value)].time)}`; });
    wg.addEventListener('change', () => { S.layer.frame = Number(wg.value); showLayer('wrfg', { keepFrame: true }); });
  }
  const w3 = el.querySelector('#wrf3-frame');
  if (w3) {
    w3.addEventListener('input', () => { stopAnimation(); el.querySelector('#wrf3-time').textContent = fmtTime(wrf3Frames()[Number(w3.value)].time); });
    w3.addEventListener('change', () => { S.layer.frame = Number(w3.value); showLayer('wrf3', { keepFrame: true }); });
  }
  const rf = el.querySelector('#wrf-frame');
  if (rf) {
    rf.addEventListener('input', () => { stopAnimation(); el.querySelector('#wrf-time').textContent = fmtTime(wrfDs().steps[Number(rf.value)]); });
    rf.addEventListener('change', () => { S.layer.frame = Number(rf.value); showLayer('wind', { keepFrame: true }); });
  }
  el.querySelectorAll('[data-watermode]').forEach((b) => b.addEventListener('click', () => {
    S.layer.waterMode = b.dataset.watermode;
    showLayer('water', { keepFrame: true });
  }));
  el.querySelectorAll('[data-vismode]').forEach((b) => b.addEventListener('click', () => {
    S.layer.visMode = b.dataset.vismode;
    showLayer('visib', { keepFrame: true });
  }));
  const wf = el.querySelector('#wind-frame');
  if (wf) {
    wf.addEventListener('input', () => { stopAnimation(); el.querySelector('#wind-time').textContent = fmtTime((id === 'heat' ? S.heat : S.wind).times[Number(wf.value)]); });
    wf.addEventListener('change', () => { S.layer.frame = Number(wf.value); showLayer(id, { keepFrame: true }); });
  }
  el.querySelectorAll('[data-qpfmode]').forEach((b) => b.addEventListener('click', () => {
    if (b.getAttribute('aria-disabled') === 'true') {
      renderLegend(null, '目前無法取得6小時定量降水預報（氣象署網站的預報圖暫時讀不到）；請先使用12小時版本。');
      return;
    }
    S.layer.qpfMode = b.dataset.qpfmode;
    S.layer.period = 0;
    showLayer('qpf', { keepFrame: true });
  }));
  el.querySelectorAll('[data-period]').forEach((b) => b.addEventListener('click', () => {
    S.layer.period = Number(b.dataset.period);
    showLayer(id, { keepFrame: true });
  }));
  el.querySelectorAll('[data-frame]').forEach((b) => b.addEventListener('click', () => {
    S.layer.frame = Number(b.dataset.frame);
    showLayer(id, { keepFrame: true });
  }));
  const play = el.querySelector('#btn-play');
  if (play) play.addEventListener('click', () => toggleAnimation());
}

function toggleAnimation() {
  if (S.layer.timer) { stopAnimation(); return; }
  const info = playInfo();
  if (!info || info.n < 2) return;
  // Preload the pictures before stepping so the animation does not stutter.
  Promise.resolve(info.pre ? info.pre() : null).then(() => {
    const b = document.getElementById('btn-play');
    if (b) { b.textContent = '❚❚'; b.setAttribute('aria-pressed', 'true'); b.setAttribute('aria-label', '暫停'); b.title = '暫停'; }
    S.layer.timer = setInterval(() => {
      const cur = playInfo();
      if (!cur || cur.n < 2) { stopAnimation(); return; }   // the mode or layer changed meanwhile
      S.layer.frame = (S.layer.frame + 1) % cur.n;
      showLayer(S.layer.id, { keepFrame: true });
    }, S.settings.reduceMotion ? 2500 : 800);
  });
}
