// Weather map layers: grid overlays, satellite, typhoon rain choropleth; legend and time control.
import { S } from './state.js';
import { getJSON, fmtTime, esc, normCounty } from './util.js';
import { loadGrid, renderGrid } from './grid.js';
import { scaleFor, colourFn, classLabel } from './palettes.js';

export const LAYERS = [
  { id: 'radar', label: '雷達回波', kind: 'radar', unit: 'dBZ' },
  { id: 'qpe1h', label: '1小時雨量', kind: 'rain', unit: 'mm' },
  { id: 'rainacc', label: '累積雨量', kind: 'rainacc', unit: 'mm' },
  { id: 'qpf1h', label: '未來1小時雨量', kind: 'rain', unit: 'mm' },
  { id: 'qpf', label: '定量降水預報', kind: 'rain', unit: 'mm/12h' },
  { id: 'temp', label: '溫度', kind: 'temp', unit: '°C' },
  { id: 'sat', label: '衛星雲圖', kind: 'sat' },
  { id: 'tyrain', label: '颱風雨量預測', kind: 'rain', unit: 'mm', typhoonOnly: true },
  { id: 'none', label: '關閉圖層', kind: 'none' },
];

// Interpolation fill for no-data cells per layer kind (temperature: ignore no-data).
const FILL = { radar: -20, rain: 0, rainacc: 0, temp: NaN };
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
  if (id === 'qpf') return (L_.qpf?.periods || []).map((p) => p.meta);
  if (id === 'rainacc') return (L_.rainacc?.periods || [{ meta: 'grids/rainday.json' }]).map((p) => p.meta);
  if (['qpe1h', 'rainday', 'qpf1h', 'temp'].includes(id)) return [`grids/${id}.json`];
  return [];
}

function clearOverlay() {
  if (S.layer.overlay) { S.map.removeLayer(S.layer.overlay); S.layer.overlay = null; }
}

export function stopAnimation() {
  if (S.layer.timer) { clearInterval(S.layer.timer); S.layer.timer = null; }
  const b = document.getElementById('btn-play');
  if (b) { b.textContent = '▶ 播放'; b.setAttribute('aria-pressed', 'false'); }
}

export async function showLayer(id, { keepFrame = false } = {}) {
  const def = layerDef(id);
  if (S.layer.id !== id) stopAnimation();
  S.layer.id = id;
  if (!keepFrame) {
    S.layer.frame = Math.max(0, framesFor(id).length - 1);
    S.layer.period = id === 'rainacc' ? Math.max(0, (S.manifest?.layers?.rainacc?.periods || []).findIndex((p) => p.id === '24h')) : 0;
  }
  document.querySelectorAll('.chip[data-layer]').forEach((b) => {
    b.setAttribute('aria-checked', String(b.dataset.layer === id));
  });
  renderTimeControl();
  try {
    if (def.kind === 'none') { clearOverlay(); renderLegend(); return; }
    if (id === 'sat') { await showSatellite(); return; }
    if (id === 'tyrain') { showTyphoonRain(); return; }
    const frames = framesFor(id);
    const path = PERIOD_LAYERS.includes(id) ? frames[S.layer.period] : frames[S.layer.frame];
    if (!path) { clearOverlay(); renderLegend(null, '此圖層目前沒有資料'); return; }
    const grid = await getGrid(path);
    if (S.layer.id !== id) return; // user switched meanwhile
    const colour = colourFn(scaleFor(def.kind, S.settings.palette));
    // Smooth rendering interpolates between cells; "no echo / no rain" counts as a low value
    // so that rain areas fade out at their edges instead of ending in square steps.
    const opts = { smooth: S.settings.smooth !== false, fill: FILL[def.kind] ?? NaN };
    const ov = L.layerGroup([grid, ...(grid.parts || [])].map((g) => {
      const [w, s, e, n] = g.bounds;
      return L.imageOverlay(renderGrid(g, colour, opts).toDataURL('image/png'), [[s, w], [n, e]],
        { opacity: S.settings.opacity, interactive: false, className: 'wx-grid' });
    }));
    if (!S.layer.hidden) ov.addTo(S.map);
    clearOverlay();
    S.layer.overlay = ov;
    renderLegend(grid.meta);
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
    opacity: S.settings.opacity, interactive: false, alt: `${im.label}衛星雲圖 ${fmtTime(im.time)}`,
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
  const scale = scaleFor('rain', S.settings.palette);
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
  renderLegend({ label: tbl.name, unit: 'mm', time: tbl.issue, period: tbl.period, note: tbl.note, kindOverride: 'rain' });
}

/** Temporarily hide / restore the weather overlay (e.g. while the shakemap is shown). */
export function setWeatherVisible(on) {
  const ov = S.layer.overlay;
  S.layer.hidden = !on;
  if (!ov) return;
  if (on && !S.map.hasLayer(ov)) ov.addTo(S.map);
  if (!on && S.map.hasLayer(ov)) S.map.removeLayer(ov);
}

export function setOpacity(v) {
  S.settings.opacity = v;
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
    el.open = window.innerWidth >= 700;
    el.addEventListener('toggle', () => { S.legendOpen = el.open; });
    S.legendInit = true;
  }
  if (S.legendOpen !== undefined) el.open = S.legendOpen;
  if (message) {
    el.innerHTML = `<summary>${esc(def.label)}</summary><div class="lg-body"><p>${esc(message)}</p></div>`;
    el.hidden = false;
    return;
  }
  if (!meta || def.kind === 'none') { el.hidden = true; el.innerHTML = ''; return; }
  const kind = meta.kindOverride || def.kind;
  let body = '';
  if (kind !== 'sat') {
    const scale = scaleFor(kind, S.settings.palette);
    const unit = meta.unit || def.unit || '';
    body = '<ol class="swatches">' + scale.map((s, i) => `<li><span class="sw" style="background:${s[1]}"></span>${esc(classLabel(scale, i, unit))}</li>`).reverse().join('') + '</ol>';
  }
  let when = '';
  if (meta.start && meta.end) when = `${fmtTime(meta.start)} ～ ${fmtTime(meta.end)}`;
  else if (meta.period) when = meta.period;
  else if (meta.time) when = fmtTime(meta.time);
  const title = meta.title ? `<img class="qpf-title" src="data/${esc(meta.title)}" alt="氣象署原圖標題（含發布與有效時間）">` : '';
  const note = meta.note ? `<p class="note">${esc(meta.note)}</p>` : '';
  const qpfNote = meta.kind === 'class' ? '<p class="note">由氣象署定量降水預報圖自動對位轉換；時間以原圖標題為準。</p>' : '';
  el.innerHTML = `<summary>${esc(meta.label || def.label)}<span class="when">${esc(when)}</span></summary>
<div class="lg-body">${title}${body}${note}${qpfNote}<p class="src">來源：中央氣象署 ${esc(meta.src || '')}</p></div>`;
  el.hidden = false;
}

export function renderTimeControl(meta) {
  const el = document.getElementById('time-ctl');
  const id = S.layer.id;
  let h = '';
  if (id === 'radar') {
    const frames = S.manifest?.layers?.radarFrames?.frames || [];
    if (frames.length > 1) {
      const playing = Boolean(S.layer.timer);
      h = `<button id="btn-play" class="btn" aria-pressed="${playing}">${playing ? '❚❚ 暫停' : '▶ 播放'}</button>
<label class="range"><span class="sr-only">雷達時間</span><input id="frame" type="range" min="0" max="${frames.length - 1}" value="${S.layer.frame}" aria-valuetext="${esc(fmtTime(frames[S.layer.frame]?.time))}"></label>
<output id="frame-time">${esc(fmtTime(frames[S.layer.frame]?.time, { date: false }))}</output>`;
    }
  } else if (id === 'rainacc') {
    const periods = S.manifest?.layers?.rainacc?.periods || [];
    h = '<div class="seg" role="radiogroup" aria-label="累積時段">' + periods.map((p, i) => `<button class="seg-btn" role="radio" aria-checked="${i === S.layer.period}" data-period="${i}">${esc(p.label)}</button>`).join('') + '</div>';
  } else if (id === 'qpf') {
    const periods = S.manifest?.layers?.qpf?.periods || [];
    h = '<div class="seg" role="radiogroup" aria-label="預報時段">' + periods.map((p, i) => {
      const end = new Date(new Date(p.start).getTime() + 12 * 3600e3).toISOString();
      return `<button class="seg-btn" role="radio" aria-checked="${i === S.layer.period}" data-period="${i}">${esc(fmtTime(p.start))}–${esc(fmtTime(end, { date: false }))}</button>`;
    }).join('') + '</div>';
  } else if (id === 'sat') {
    h = '<div class="seg" role="radiogroup" aria-label="雲圖種類">' + S.sat.map((s, i) => `<button class="seg-btn" role="radio" aria-checked="${i === S.layer.frame}" data-frame="${i}">${esc(s.label)}</button>`).join('') + '</div>';
  } else if (id === 'tyrain') {
    const t = S.typhoon?.tables || {};
    h = '<div class="seg" role="radiogroup" aria-label="雨量預測種類">'
      + (t.rain24 ? `<button class="seg-btn" role="radio" aria-checked="${S.layer.period === 0}" data-period="0">24小時雨量</button>` : '')
      + (t.rainTotal ? `<button class="seg-btn" role="radio" aria-checked="${S.layer.period === 1}" data-period="1">總雨量</button>` : '') + '</div>';
  } else if (meta?.time) {
    h = `<span class="muted">資料時間 ${esc(fmtTime(meta.time))}</span>`;
  }
  el.innerHTML = h;
  const frame = el.querySelector('#frame');
  if (frame) {
    frame.addEventListener('input', () => {
      stopAnimation();
      S.layer.frame = Number(frame.value);
      showLayer('radar', { keepFrame: true });
    });
  }
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
  const frames = framesFor('radar');
  // Preload all frames before animating.
  Promise.all(frames.map((f) => getGrid(f))).then(() => {
    const b = document.getElementById('btn-play');
    if (b) { b.textContent = '❚❚ 暫停'; b.setAttribute('aria-pressed', 'true'); }
    S.layer.timer = setInterval(() => {
      S.layer.frame = (S.layer.frame + 1) % frames.length;
      showLayer('radar', { keepFrame: true });
    }, S.settings.reduceMotion ? 2500 : 900);
  });
}
