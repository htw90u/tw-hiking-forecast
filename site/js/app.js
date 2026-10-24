// Entry point: map setup, data loading, overlays, controls and settings.
import { S } from './state.js';
import { loadSettings, saveSettings, applySettings, DEFAULTS } from './settings.js';
import { getJSON, setDataVersion, fmtTime, ageText, esc, bbox, $, intText, isStrongQuake } from './util.js';
import { LAYERS, showLayer, setOpacity, stopAnimation, setWeatherVisible } from './layers.js';
import { PALETTE_NAMES } from './palettes.js';
import {
  showPoint, closeSheet, sheetBack, setSheetMini, showSources, showAlerts, showRecent, showAffected, showQuake, showQuakes, showTyphoon, search, flyTo,
} from './views.js';
import { clearAll } from './store.js';

const BASEMAPS = {
  topo: { label: '等高線地形圖 (OpenTopoMap)', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', max: 17, sub: 'abc',
    attr: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)' },
  emap: { label: '臺灣通用電子地圖 (國土測繪中心)', url: 'https://wmts.nlsc.gov.tw/wmts/EMAP/default/GoogleMapsCompatible/{z}/{y}/{x}', max: 19,
    attr: '© <a href="https://maps.nlsc.gov.tw/">內政部國土測繪中心</a>' },
  photo: { label: '正射影像 (國土測繪中心)', url: 'https://wmts.nlsc.gov.tw/wmts/PHOTO2/default/GoogleMapsCompatible/{z}/{y}/{x}', max: 19,
    attr: '© <a href="https://maps.nlsc.gov.tw/">內政部國土測繪中心</a>' },
  osm: { label: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', max: 19,
    attr: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors' },
  cycle: { label: '自行車／步道地圖 (OpenCycleMap)', url: 'https://{s}.tile.thunderforest.com/cycle/{z}/{x}/{y}{r}.png?apikey={apikey}', max: 22, sub: 'abc',
    attr: 'Maps © <a href="https://www.thunderforest.com/">Thunderforest</a>, Data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', noBulk: true, tf: 'OpenCycleMap' },
  landscape: { label: '地景地圖 (Thunderforest Landscape)', url: 'https://{s}.tile.thunderforest.com/landscape/{z}/{x}/{y}{r}.png?apikey={apikey}', max: 22, sub: 'abc',
    attr: 'Maps © <a href="https://www.thunderforest.com/">Thunderforest</a>, Data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', noBulk: true, tf: 'Landscape' },
  outdoors: { label: '戶外地圖 (Thunderforest Outdoors)', url: 'https://{s}.tile.thunderforest.com/outdoors/{z}/{x}/{y}{r}.png?apikey={apikey}', max: 22, sub: 'abc',
    attr: 'Maps © <a href="https://www.thunderforest.com/">Thunderforest</a>, Data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', noBulk: true, tf: 'Outdoors' },
  custom: { label: '自訂圖磚網址', url: '', max: 19, attr: '自訂底圖' },
};

let baseLayer = null;
let strongLayer = null;
const STRONG_QUAKE_MS = 3 * 864e5;

/** Personal key from the settings, else the site-wide key from the manifest. */
function thunderforestKey() {
  return (S.settings.tfKey || S.manifest?.config?.thunderforestKey || '').trim();
}

function setBasemap() {
  const s = S.settings;
  let key = s.basemap;
  S.baseNotice = '';
  // Thunderforest maps without an API key only return "API Key Required" tiles: show the topo map instead.
  const tf = BASEMAPS[key]?.tf;
  if (tf && !thunderforestKey()) {
    key = 'topo';
    S.baseNotice = `${tf} 需要 Thunderforest API key（設定 → 底圖），目前先以等高線地形圖顯示。`;
  }
  const def = BASEMAPS[key] || BASEMAPS.topo;
  const url = key === 'custom' ? s.customTile : def.url;
  if (baseLayer) S.map.removeLayer(baseLayer);
  if (url) {
    // Thunderforest tiles are shown as plain images (no CORS request needed).
    baseLayer = L.tileLayer(url, { maxZoom: def.max, maxNativeZoom: def.max, subdomains: def.sub || 'abc', attribution: def.attr,
      crossOrigin: !def.tf, apikey: thunderforestKey() });
    if (def.tf) {
      let errors = 0;
      baseLayer.on('tileerror', () => {
        errors += 1;
        if (errors === 6) { S.baseNotice = `${def.tf} 圖磚載入失敗：請確認 API key 是否正確或額度是否用完。`; updateStatus(); }
      });
    }
    baseLayer.addTo(S.map);
  }
  if (S.manifest) updateStatus();
}

// ---------------------------------------------------------------- overlays
// Map icons for the CWA recreation-forecast categories (F-B0053): white line glyphs (24 px grid)
// on a rounded square in the category group's colour; mountains keep the ▲ pin.
const SPOT_GLYPHS = {
  beach: 'M3 12a9 9 0 0 1 18 0z M12 12v7a2 2 0 0 0 4 0',
  park: 'M12 3a5 5 0 0 1 5 5 4 4 0 0 1-1 7.5H8A4 4 0 0 1 7 8a5 5 0 0 1 5-5z M12 15.5V21',
  farm: 'M3 21V10l9-6 9 6v11z M9 21v-6h6v6',
  fishing: 'M3 12c3-4 8-5 12-3l5-3v12l-5-3c-4 2-9 1-12-3z M8 11h.01',
  coast: 'M2 13c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2 M2 18c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2',
  np: 'M2 20 9 8l4 6 3-4 6 10z',
  nsa: 'M4 8h3l2-3h6l2 3h3v11H4z M12 10.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  port: 'M12 6.5v14 M8 10h8 M5 13a7 7 0 0 0 14 0 M12 2.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  forest: 'M12 2l5 7h-3l4 6h-4.5l3 4H7.5l3-4H6l4-6H7z M12 19v3',
  reservoir: 'M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z',
  scenic: 'M3 19h18 M7 19a5 5 0 0 1 10 0 M12 7v3 M5 11l2 2 M19 11l-2 2',
  water: 'M3 16c6 3 12 3 18 0 M6 5l12 12 M4 7l3-3 M17 20l3-3',
  sea: 'M3 17l2 3h14l2-3z M12 4v13 M12 5l6 9h-6',
};
const spotIcon = (c) => (SPOT_GLYPHS[c]
  ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${SPOT_GLYPHS[c]}"/></svg>`
  : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l8 8-8 8-8-8z"/></svg>');
/** Strong earthquakes (max intensity >= 5弱 or M >= 6) in the last 3 days: a warning icon that is always shown. */
function buildStrongQuakes() {
  if (strongLayer) S.map.removeLayer(strongLayer);
  strongLayer = L.layerGroup();
  S.quakes.filter((q) => isStrongQuake(q) && Date.now() - new Date(q.time).getTime() < STRONG_QUAKE_MS).forEach((q) => {
    const label = `強震 M${Number(q.mag).toFixed(1)}`;
    const icon = L.divIcon({ className: 'eq-strong', iconSize: [40, 40],
      html: `<span class="eq-pulse" aria-hidden="true"></span><span class="eq-core" aria-hidden="true">震</span><span class="eq-tag">${esc(label)}</span>` });
    L.marker([q.lat, q.lon], { icon, pane: 'alerts', title: `${label}・最大震度 ${intText(q.maxInt)}：查看地震報告`, alt: label, keyboard: true, zIndexOffset: 1000 })
      .bindTooltip(`${esc(label)}<br>${esc(fmtTime(q.time))}・最大震度 ${esc(intText(q.maxInt))}`, { direction: 'top', offset: [0, -18] })
      .on('click', (e) => { L.DomEvent.stop(e); showQuake(q); })
      .addTo(strongLayer);
  });
  if (!S.quakeMode) strongLayer.addTo(S.map);
}

function buildOverlays() {
  const o = S.overlays;
  Object.values(o).forEach((g) => S.map.removeLayer(g));

  o.stations = L.layerGroup();
  S.stations.forEach((s) => {
    const weather = s.k !== 'rain';
    const m = L.circleMarker([s.lat, s.lon], {
      radius: weather ? 4 : 3, weight: 1, color: '#222', fillColor: weather ? '#ffffff' : '#9ec5ff', fillOpacity: 0.9, pane: 'stations',
    });
    const parts = [];
    if (s.T !== undefined) parts.push(`${s.T}°C`);
    if (s.R1h !== undefined) parts.push(`時雨量 ${s.R1h}`);
    if (s.G !== undefined) parts.push(`陣風 ${s.G}`);
    m.bindTooltip(`${esc(s.n)}${s.alt !== undefined ? ` ${Math.round(s.alt)}m` : ''}<br>${parts.join('・')}`);
    m.on('click', (e) => { L.DomEvent.stop(e); showPoint(s.lat, s.lon, { stationId: s.id, label: `${s.n}測站` }); });
    o.stations.addLayer(m);
  });

  o.mountains = L.layerGroup();
  o.spots = L.layerGroup();
  S.spots.forEach((p) => {
    const mountain = p.c === 'mountain';
    const icon = mountain ? L.divIcon({ className: 'pin-mtn', html: '▲', iconSize: [18, 18] })
      : L.divIcon({ className: `pin-cat cat-${p.c}`, html: spotIcon(p.c), iconSize: [22, 22] });
    const m = L.marker([p.lat, p.lon], { icon, title: p.n, keyboard: true, alt: p.n, pane: 'spots' });
    const cat = mountain ? '' : S.spotCats.find((c) => c.id === p.c)?.label;
    m.bindTooltip(`${esc(p.n)}${cat ? `<br><small>${esc(cat)}</small>` : ''}`, { direction: 'top', offset: [0, -10] });
    m.on('click', () => showPoint(p.lat, p.lon, { spotKey: p.k }));
    (mountain ? o.mountains : o.spots).addLayer(m);
  });

  // OSM peaks: thousands of points, so markers are created only for the visible area (see updatePeaks).
  o.peaks = L.layerGroup([], { attribution: '山頭 © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)' });

  o.quakes = L.layerGroup();
  S.quakes.filter((q) => Date.now() - new Date(q.time).getTime() < 7 * 864e5).forEach((q) => {
    const m = L.circleMarker([q.lat, q.lon], { radius: 4 + q.mag * 2, color: '#b00020', weight: 2, fillColor: '#ff5a5f', fillOpacity: 0.35, pane: 'spots' });
    m.bindTooltip(`地震 M${q.mag}<br>${esc(fmtTime(q.time))}・最大震度 ${intText(q.maxInt)}`);
    m.on('click', (e) => { L.DomEvent.stop(e); showQuake(q); });
    o.quakes.addLayer(m);
  });

  buildStrongQuakes();

  o.typhoon = L.layerGroup();
  tyLabels = [];
  if (S.typhoon?.active) {
    S.typhoon.cyclones.forEach((c) => {
      const past = c.past.map((f) => [f.lat, f.lon]);
      const fc = c.fcst.map((f) => [f.lat, f.lon]);
      if (past.length) L.polyline(past, { color: '#222', weight: 3, interactive: false }).addTo(o.typhoon);
      if (fc.length && past.length) L.polyline([past[past.length - 1], ...fc], { color: '#d00', weight: 3, dashArray: '8 6', interactive: false }).addTo(o.typhoon);
      const cur = c.past[c.past.length - 1];
      if (cur) {
        const now = c.fcst[0] || cur;
        if (now.r15) L.circle([cur.lat, cur.lon], { radius: now.r15 * 1000, color: '#e69f00', weight: 2, fillOpacity: 0.08, interactive: false }).addTo(o.typhoon);
        if (now.r25) L.circle([cur.lat, cur.lon], { radius: now.r25 * 1000, color: '#d55e00', weight: 2, fillOpacity: 0.12, interactive: false }).addTo(o.typhoon);
        L.marker([cur.lat, cur.lon], { icon: L.divIcon({ className: 'ty-icon', html: '🌀', iconSize: [30, 30] }), title: `${c.cname}颱風` })
          .on('click', () => showTyphoon()).addTo(o.typhoon);
      }
      const labels = [];
      if (cur) labels.push({ lat: cur.lat, lon: cur.lon, text: `現在 ${tyTime(cur.t)}`, priority: true });
      c.fcst.forEach((f) => {
        if (f.r70) L.circle([f.lat, f.lon], { radius: f.r70 * 1000, color: '#d00', weight: 1, dashArray: '3 4', fill: false, interactive: false }).addTo(o.typhoon);
        const when = f.t && f.h !== null ? new Date(new Date(f.t).getTime() + f.h * 3600e3).toISOString() : null;
        L.circleMarker([f.lat, f.lon], { radius: 4, color: '#d00', fillColor: '#fff', fillOpacity: 1 })
          .bindTooltip(`${when ? fmtTime(when) : ''}（+${f.h} 小時）<br>最大風速 ${f.ws ?? '—'} m/s・70% 機率半徑 ${f.r70 ?? '—'} km`).addTo(o.typhoon);
        if (when) labels.push({ lat: f.lat, lon: f.lon, text: tyTime(when) });
      });
      tyLabels.push(...labels.map((l) => ({ ...l, marker: L.marker([l.lat, l.lon], {
        icon: L.divIcon({ className: `ty-lbl${l.priority ? ' now' : ''}`, html: esc(l.text), iconSize: [90, 18], iconAnchor: [-8, 9] }),
        interactive: false, keyboard: false,
      }) })));
    });
  }
  applyOverlayVisibility();
  layoutTyLabels();
}

// Typhoon track time labels: "25日08時". Labels that would overlap at the
// current zoom are hidden (the point tooltip still shows the full time).
let tyLabels = [];
function tyTime(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', day: 'numeric', hour: '2-digit', hour12: false })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.day}日${p.hour === '24' ? '00' : p.hour}時`;
}

function layoutTyLabels() {
  const group = S.overlays.typhoon;
  if (!group) return;
  const shown = [];
  tyLabels.forEach((l) => {
    const pt = S.map.latLngToContainerPoint([l.lat, l.lon]);
    const clash = shown.some((q) => Math.abs(q.x - pt.x) < 78 && Math.abs(q.y - pt.y) < 20);
    if (!clash || l.priority) {
      shown.push(pt);
      if (!group.hasLayer(l.marker)) group.addLayer(l.marker);
    } else if (group.hasLayer(l.marker)) {
      group.removeLayer(l.marker);
    }
  });
}

function applyOverlayVisibility() {
  const show = S.settings.overlays;
  Object.entries(S.overlays).forEach(([k, g]) => {
    // In the earthquake view, ordinary station dots would be confused with intensity markers.
    const hiddenByQuake = S.quakeMode && (k === 'stations' || k === 'spots' || k === 'quakes');
    const minZoom = { stations: 9, spots: 9, peaks: PEAK_MIN_ZOOM }[k] || 0;
    const on = show[k] && !hiddenByQuake && S.map.getZoom() >= minZoom;
    if (on && !S.map.hasLayer(g)) g.addTo(S.map);
    if (!on && S.map.hasLayer(g)) S.map.removeLayer(g);
  });
  document.getElementById('map').dataset.zoom = String(S.map.getZoom());
  updatePeaks();
  updateLabels();
}

const PEAK_MIN_ZOOM = 10;
// Highest peaks first: fewer markers when zoomed out.
const peakLimit = (z) => (z <= 10 ? 250 : z === 11 ? 500 : 800);
let peakKeys = '';
let peakView = [];

/** (Re)create OSM peak markers for the current view. */
function updatePeaks() {
  const g = S.overlays.peaks;
  if (!g) return;
  if (!S.map.hasLayer(g)) { g.clearLayers(); peakKeys = ''; peakView = []; return; }
  const view = S.map.getBounds().pad(0.2);
  const list = S.peaks.filter((p) => view.contains([p.lat, p.lon])).slice(0, peakLimit(S.map.getZoom()));
  peakView = list;
  const keys = list.map((p) => p.k).join();
  if (keys === peakKeys) return;
  peakKeys = keys;
  g.clearLayers();
  list.forEach((p) => {
    const icon = L.divIcon({ className: 'pin-peak', html: '▲', iconSize: [14, 14] });
    const m = L.marker([p.lat, p.lon], { icon, title: p.n, alt: p.n, keyboard: false, pane: 'spots' });
    m.bindTooltip(`${esc(p.n)}${p.ele ? ` ${p.ele} m` : ''}`, { direction: 'top', offset: [0, -6] });
    m.on('click', () => showPoint(p.lat, p.lon, { peak: p }));
    g.addLayer(m);
  });
}

// ---------------------------------------------------------------- name labels
// [kind, min zoom, items]: labels follow their marker layer and skip any that would overlap.
// [kind, min zoom, items, marker half-size px]; earlier kinds win when labels collide.
const LABEL_KINDS = [
  ['mountains', 9, () => S.spots.filter((p) => p.c === 'mountain'), 8],
  ['spots', 10, () => S.spots.filter((p) => p.c !== 'mountain'), 11],
  ['peaks', 10, () => peakView, 7],
  ['stations', 11, () => S.stations, 5],
];
const MAX_LABELS = 300;
let labelLayer = null;

function updateLabels() {
  if (!S.map) return;
  if (!labelLayer) labelLayer = L.layerGroup().addTo(S.map);
  labelLayer.clearLayers();
  const z = S.map.getZoom();
  const view = S.map.getBounds().pad(0.05);
  // Matches .map-lbl: 16px * min(font scale, 1.4) * .75 * label scale; CJK glyphs are about 1em wide.
  const lblScale = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--lbl')) || 1.25;
  const fontPx = 12 * Math.min(Number(S.settings.fontScale) || 1, 1.4) * lblScale;
  const charW = fontPx + 1;
  const h = Math.ceil(fontPx * 1.2) + 4;
  const overlaps = (r, list) => list.some((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h);
  const kinds = LABEL_KINDS.filter(([k, minZ]) => S.settings.labels?.[k] && z >= minZ && S.overlays[k] && S.map.hasLayer(S.overlays[k]))
    .map(([k, , items, half]) => {
      const list = items().filter((p) => view.contains([p.lat, p.lon]));
      if (k === 'stations') list.sort((a, b) => (a.k === 'rain') - (b.k === 'rain')); // weather stations first
      return [k, list.map((p) => ({ p, pt: S.map.latLngToContainerPoint([p.lat, p.lon]) })), half];
    });
  // Labels must not cover any labelled kind's own markers.
  const marks = kinds.flatMap(([, list, half]) => list.map(({ pt }) => ({ x: pt.x - half, y: pt.y - half, w: half * 2, h: half * 2, pt })));
  const placed = [];
  for (const [k, list, half] of kinds) {
    const gap = half + 2;
    for (const { p, pt } of list) {
      if (placed.length >= MAX_LABELS) return;
      const w = p.n.length * charW + 6;
      const others = marks.filter((q) => q.pt !== pt);
      // Right of the marker first, then left.
      const r = [{ x: pt.x + gap, left: false }, { x: pt.x - gap - w, left: true }]
        .map((c) => ({ x: c.x, y: pt.y - h / 2, w, h, left: c.left }))
        .find((c) => !overlaps(c, placed) && !overlaps(c, others));
      if (!r) continue;
      placed.push(r);
      labelLayer.addLayer(L.marker([p.lat, p.lon], {
        pane: 'labels', interactive: false, keyboard: false,
        // Left labels: a zero-width box at the marker with the text right-aligned against it.
        icon: r.left
          ? L.divIcon({ className: `map-lbl lbl-${k} lbl-left`, html: `<span>${esc(p.n)}</span>`, iconSize: [0, h], iconAnchor: [gap, h / 2] })
          : L.divIcon({ className: `map-lbl lbl-${k}`, html: esc(p.n), iconSize: null, iconAnchor: [-gap, h / 2] }),
      }));
    }
  }
}

// ---------------------------------------------------------------- controls
function buildChips() {
  const box = document.getElementById('chips');
  const tyTables = S.typhoon?.tables || {};
  const items = LAYERS.filter((l) => !l.typhoonOnly || (S.typhoon?.active && (tyTables.rain24 || tyTables.rainTotal)));
  box.innerHTML = items.map((l) => `<button class="chip" role="radio" data-layer="${l.id}" aria-checked="${l.id === S.settings.layer}"${l.id === 'none' ? '' : ` title="${esc(l.label)}（選取中再點一次可關閉圖層）"`}>${esc(l.label)}</button>`).join('');
  box.querySelectorAll('[data-layer]').forEach((b) => b.addEventListener('click', () => {
    let id = b.dataset.layer;
    // Choosing a weather layer during the earthquake view shows it again.
    if (S.layer.hidden) { setWeatherVisible(true); document.getElementById('legend').classList.remove('quake-hide'); }
    // Tapping the active layer again turns the weather layer off.
    else if (id === S.layer.id) id = 'none';
    S.settings.layer = id;
    saveSettings(S.settings);
    showLayer(id);
    updateBarLabel();
  }));
  // Arrow-key navigation inside the radio group.
  box.addEventListener('keydown', (e) => {
    if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
    const btns = [...box.querySelectorAll('[data-layer]')];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const n = btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
    n.focus();
    n.click();
    e.preventDefault();
  });
}

function buildOverlayToggles() {
  const items = [['stations', '測站'], ['mountains', '山岳'], ['peaks', '山頭(OSM)'], ['spots', '景點'], ['quakes', '地震'], ['typhoon', '颱風']];
  const box = document.getElementById('toggles');
  const names = [['mountains', '山岳'], ['peaks', '山頭'], ['spots', '景點'], ['stations', '測站']];
  const group = (id, title, attr, list, state) => `<div class="tog-group" role="group" aria-labelledby="${id}-t">
<div class="tog-head"><span class="tog-lbl" id="${id}-t">${title}</span><span class="tog-all"><button type="button" class="link" data-all="${attr}" data-on="1">全選</button><button type="button" class="link" data-all="${attr}" data-on="0">全部取消</button></span></div>
${list.map(([k, label]) => `<label class="tog"><input type="checkbox" data-${attr}="${k}"${state[k] ? ' checked' : ''}> ${label}</label>`).join('')}</div>`;
  const cats = S.spotCats.filter((c) => c.id !== 'mountain' && S.spots.some((p) => p.c === c.id));
  box.innerHTML = group('tg-ov', '地圖標記', 'ov', items, S.settings.overlays)
    + group('tg-lbl', '顯示名稱', 'lbl', names, S.settings.labels)
    + `<details class="cat-legend"><summary>景點圖示說明</summary><ul>${cats.map((c) => `<li><span class="pin-cat cat-${c.id}" aria-hidden="true">${spotIcon(c.id)}</span>${esc(c.label)}</li>`).join('')}</ul></details>`;
  const apply = { ov: applyOverlayVisibility, lbl: updateLabels };
  const store = { ov: S.settings.overlays, lbl: S.settings.labels };
  // 全選 is disabled when everything is on, 全部取消 when everything is off.
  const refreshAll = () => box.querySelectorAll('[data-all]').forEach((b) => {
    const inputs = [...box.querySelectorAll(`input[data-${b.dataset.all}]`)];
    b.disabled = b.dataset.on === '1' ? inputs.every((c) => c.checked) : !inputs.some((c) => c.checked);
  });
  ['ov', 'lbl'].forEach((attr) => box.querySelectorAll(`input[data-${attr}]`).forEach((c) => c.addEventListener('change', () => {
    store[attr][c.dataset[attr]] = c.checked;
    saveSettings(S.settings);
    apply[attr]();
    refreshAll();
  })));
  box.querySelectorAll('[data-all]').forEach((b) => b.addEventListener('click', () => {
    const attr = b.dataset.all;
    const inputs = [...box.querySelectorAll(`input[data-${attr}]`)];
    const on = b.dataset.on === '1';
    inputs.forEach((c) => { c.checked = on; store[attr][c.dataset[attr]] = on; });
    saveSettings(S.settings);
    apply[attr]();
    refreshAll();
  }));
  refreshAll();
}

/** Keep the floating legend just below the status bar, whose height varies (typhoon banner, font size). */
function placeLegend() {
  const r = document.getElementById('status').getBoundingClientRect();
  const btn = document.getElementById('btn-more').getBoundingClientRect();
  const bottom = btn.height ? Math.max(r.bottom, btn.bottom) : r.bottom;
  document.documentElement.style.setProperty('--legend-top', `${Math.round(bottom + 6)}px`);
  // The open options panel must fit above the bottom controls.
  const map = document.getElementById('map').getBoundingClientRect();
  document.documentElement.style.setProperty('--opts-max-h', `${Math.max(120, Math.round(map.bottom - btn.bottom - 16))}px`);
}

// ---------------------------------------------------------------- map options control
function setOptsOpen(open) {
  $('#more').classList.toggle('open', open);
  $('#btn-more').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('opts-open', open);
  if (open) placeLegend();
}

function initMapOptions() {
  const el = $('#map-opts');
  L.DomEvent.disableClickPropagation(el);
  L.DomEvent.disableScrollPropagation(el);
  const Ctl = L.Control.extend({ onAdd: () => el });
  new Ctl({ position: 'topright' }).addTo(S.map);
  $('#btn-more').addEventListener('click', () => setOptsOpen(!$('#more').classList.contains('open')));
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { setOptsOpen(false); $('#btn-more').focus(); } });
  // Font sliders apply while dragging so the map shows the result at once.
  const pct = (v) => `${Math.round(v * 100)}%`;
  const slider = (id, key) => {
    const input = $(`#${id}`);
    const out = $(`#${id}-out`);
    const show = () => { out.textContent = pct(input.value); input.setAttribute('aria-valuetext', pct(input.value)); };
    input.value = String(S.settings[key] ?? DEFAULTS[key]);
    show();
    input.addEventListener('input', () => {
      S.settings[key] = Number(input.value);
      applySettings(S.settings);
      show();
      updateLabels();
      placeLegend();
    });
    input.addEventListener('change', () => saveSettings(S.settings));
    return input;
  };
  slider('lbl-size', 'labelScale');
  buildUiOptions();
  // Layer bar: collapse for a larger map; a bottom-left map button brings it back.
  const show = $('#btn-bar-show');
  L.DomEvent.disableClickPropagation(show);
  const BarCtl = L.Control.extend({ onAdd: () => show });
  new BarCtl({ position: 'bottomleft' }).addTo(S.map);
  $('#btn-bar-hide').addEventListener('click', () => { setLayerBar(false); show.focus(); });
  show.addEventListener('click', () => { setLayerBar(true); $('#chips [aria-checked="true"]')?.focus(); });
  setLayerBar(S.settings.layerBar !== false, { save: false });
}

function setLayerBar(on, { save = true } = {}) {
  S.settings.layerBar = on;
  if (save) saveSettings(S.settings);
  document.body.classList.toggle('bar-hidden', !on);
  $('#controls').hidden = !on;
  $('#btn-bar-show').hidden = on;
  $('#btn-bar-hide').setAttribute('aria-expanded', String(on));
  $('#btn-bar-show').setAttribute('aria-expanded', String(on));
  const tog = $('#set-bar');
  if (tog) tog.checked = on;
  updateBarLabel();
  setTimeout(() => { S.map.invalidateSize(); placeLegend(); }, 50);
}

/** The collapsed-bar button names the current weather layer. */
function updateBarLabel() {
  const l = LAYERS.find((x) => x.id === S.settings.layer);
  $('#bar-show-layer').textContent = l && l.id !== 'none' ? `：${l.label}` : '';
}

/** Interface and display settings, shown in the map options panel so changes are visible at once. */
function buildUiOptions() {
  const s = S.settings;
  const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(v)}</option>`).join('');
  const pct = (v) => `${Math.round(v * 100)}%`;
  const box = $('#opts-ui-body');
  box.innerHTML = `
<label class="field">介面樣式 <select id="set-ui">${opt({ text: '文字版（文字標示，好讀）', icon: '圖示版（圖示選單，簡潔）' }, s.ui)}</select></label>
<label class="range">介面字體 <input type="range" id="set-fs" min="0.9" max="2" step="0.05" value="${s.fontScale}" aria-valuetext="${pct(s.fontScale)}"> <output id="set-fs-out">${pct(s.fontScale)}</output></label>
<p class="note">介面字體放大選單、面板與說明文字；名稱字體只調整地圖上的山名、景點、測站名稱。</p>
<label class="field">主題 <select id="set-theme">${opt({ auto: '跟隨系統', light: '淺色', dark: '深色', contrast: '高對比（黑底黃字）' }, s.theme)}</select></label>
<label class="field">色盤 <select id="set-pal">${opt(PALETTE_NAMES, s.palette)}</select></label>
<p class="note">「色弱友善」使用明度遞增的色階，紅綠色弱或藍黃色弱皆可分辨；「高對比」適合強光下或低視力。</p>
<label class="tog"><input type="checkbox" id="set-bar"${s.layerBar !== false ? ' checked' : ''}> 顯示底部圖層列</label>
<label class="tog"><input type="checkbox" id="set-smooth"${s.smooth !== false ? ' checked' : ''}> 圖層平滑顯示（關閉則顯示原始格點）</label>
<label class="tog"><input type="checkbox" id="set-bold"${s.boldText ? ' checked' : ''}> 粗體文字</label>
<label class="tog"><input type="checkbox" id="set-motion"${s.reduceMotion ? ' checked' : ''}> 減少動畫</label>`;
  const save = () => { saveSettings(s); applySettings(s); placeLegend(); };
  box.querySelector('#set-fs').addEventListener('input', (e) => {
    s.fontScale = Number(e.target.value);
    box.querySelector('#set-fs-out').textContent = pct(s.fontScale);
    e.target.setAttribute('aria-valuetext', pct(s.fontScale));
    applySettings(s);
    updateLabels();
    placeLegend();
  });
  box.querySelector('#set-fs').addEventListener('change', save);
  box.querySelector('#set-ui').addEventListener('change', (e) => { s.ui = e.target.value; save(); });
  box.querySelector('#set-theme').addEventListener('change', (e) => { s.theme = e.target.value; save(); });
  box.querySelector('#set-pal').addEventListener('change', (e) => { s.palette = e.target.value; save(); showLayer(S.layer.id, { keepFrame: true }); });
  box.querySelector('#set-bar').addEventListener('change', (e) => setLayerBar(e.target.checked));
  box.querySelector('#set-smooth').addEventListener('change', (e) => { s.smooth = e.target.checked; save(); showLayer(S.layer.id, { keepFrame: true }); });
  box.querySelector('#set-bold').addEventListener('change', (e) => { s.boldText = e.target.checked; save(); });
  box.querySelector('#set-motion').addEventListener('change', (e) => { s.reduceMotion = e.target.checked; save(); if (s.reduceMotion) stopAnimation(); });
}

const QUAKE_RECENT_MS = 24 * 3600e3;

function updateStatus() {
  const el = document.getElementById('status');
  const built = S.manifest?.built;
  const off = !navigator.onLine;
  const failed = Object.entries(S.manifest?.status || {}).filter(([, v]) => !v.ok).map(([k]) => k);
  const ty = S.typhoon?.active ? S.typhoon : null;
  const tyNames = ty ? ty.cyclones.map((c) => c.cname || c.name).filter(Boolean).join('、') : '';
  const tyTitle = ty ? (ty.warnings || []).map((w) => w.title).filter(Boolean)[0] || '颱風警報' : '';
  const tyBanner = ty ? `<button class="ty-banner" id="ty-banner"><span aria-hidden="true">🌀</span><span>${esc(tyNames ? `${tyNames}颱風` : '颱風')}｜${esc(tyTitle)}</span><span class="ty-more">詳情 ›</span></button>` : '';
  // Felt earthquakes in the last 24 hours get their own banner and tab (like a typhoon warning).
  const recentQ = (S.quakes || []).filter((q) => Date.now() - new Date(q.time).getTime() < QUAKE_RECENT_MS);
  const q0 = recentQ[0];
  const qPlace = q0 ? (q0.loc.match(/位於([^)）]+)/)?.[1] || q0.loc).trim() : '';
  const eqBanner = q0 ? `<button class="ty-banner eq-banner" id="eq-banner"><span aria-hidden="true">〰</span><span>地震｜${esc(fmtTime(q0.time))} ${esc(qPlace)} 規模${esc(Number(q0.mag).toFixed(1))}・最大震度${esc(intText(q0.maxInt))}${recentQ.length > 1 ? `（24 小時內 ${recentQ.length} 起）` : ''}</span><span class="ty-more">詳情 ›</span></button>` : '';
  const baseNote = S.baseNotice ? `<span class="base-note">${esc(S.baseNotice)}</span> ` : '';
  el.innerHTML = `${tyBanner}${eqBanner}${baseNote}${off ? '<span class="offline">離線模式・顯示已快取資料</span> ' : ''}資料更新：${esc(fmtTime(built))}（${esc(ageText(built))}）${failed.length ? `・<span class="warn-txt">部分資料暫缺：${esc(failed.join(', '))}</span>` : ''}・<button class="link inline" id="btn-sources">資料來源：中央氣象署</button>`;
  el.querySelector('#btn-sources').addEventListener('click', showSources);
  el.querySelector('#ty-banner')?.addEventListener('click', showTyphoon);
  placeLegend();
  const openQuakes = () => (recentQ.length === 1 ? showQuake(q0) : showQuakes({ recentMs: QUAKE_RECENT_MS }));
  el.querySelector('#eq-banner')?.addEventListener('click', openQuakes);
  const eqBtn = document.getElementById('btn-quake');
  eqBtn.hidden = !q0;
  eqBtn.onclick = openQuakes;
  if (q0) eqBtn.setAttribute('aria-label', `近期地震 ${recentQ.length} 起：查看地震報告`);
  const tyBtn = document.getElementById('btn-typhoon');
  tyBtn.hidden = !ty;
  if (ty) tyBtn.setAttribute('aria-label', `${tyNames}颱風${tyTitle}生效中：查看颱風資訊`);
  const n = (S.warnings?.counties || []).filter((c) => c.hazards.length).length + (S.typhoon?.active ? 1 : 0);
  const badge = document.getElementById('alert-badge');
  badge.hidden = !n;
  badge.textContent = String(n);
  document.getElementById('btn-alerts').setAttribute('aria-label', n ? `警特報與災害，${n} 項生效中` : '警特報與災害');
}

function bindSearch() {
  const input = document.getElementById('q');
  const list = document.getElementById('q-results');
  let results = [];
  const choose = (r) => {
    list.hidden = true;
    input.value = r.label;
    flyTo(r.lat, r.lon, 12);
    showPoint(r.lat, r.lon, { spotKey: r.spot, stationId: r.station, peak: r.peak, label: r.type === '鄉鎮' ? r.label : undefined });
  };
  input.addEventListener('input', () => {
    results = search(input.value);
    list.innerHTML = results.map((r, i) => `<li role="option" id="qr-${i}" tabindex="-1" data-i="${i}"><span class="tag">${esc(r.type)}</span>${esc(r.label)}</li>`).join('');
    list.hidden = !results.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
  });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]');
    if (li) choose(results[Number(li.dataset.i)]);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && results[0]) { e.preventDefault(); choose(results[0]); }
    if (e.key === 'ArrowDown' && results.length) { e.preventDefault(); list.querySelector('li')?.focus(); }
    if (e.key === 'Escape') { list.hidden = true; }
  });
  list.addEventListener('keydown', (e) => {
    const li = document.activeElement.closest('li');
    if (!li) return;
    if (e.key === 'Enter') choose(results[Number(li.dataset.i)]);
    if (e.key === 'ArrowDown') (li.nextElementSibling || li).focus();
    if (e.key === 'ArrowUp') (li.previousElementSibling || input).focus();
    if (e.key === 'Escape') { list.hidden = true; input.focus(); }
  });
  document.getElementById('search-form').addEventListener('submit', (e) => e.preventDefault());
}

// ---------------------------------------------------------------- settings dialog
function openSettings() {
  const s = S.settings;
  const dlg = document.getElementById('dlg-settings');
  const body = dlg.querySelector('.dlg-body');
  const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(typeof v === 'string' ? v : v.label)}</option>`).join('');
  const th = s.thresholds;
  body.innerHTML = `
<p class="note">介面樣式、字體大小、主題、色盤等顯示設定在地圖右上角「選項 → 介面與顯示」，調整時可直接看到效果。</p>
<fieldset><legend>底圖</legend>
<label class="field">底圖 <select id="set-base">${opt(BASEMAPS, s.basemap)}</select></label>
<label class="field">自訂圖磚網址 <input type="url" id="set-custom" value="${esc(s.customTile)}" placeholder="https://.../{z}/{x}/{y}.png"></label>
<label class="field">Thunderforest API key <input type="text" id="set-tfkey" value="${esc(s.tfKey)}" autocomplete="off" spellcheck="false" placeholder="${S.manifest?.config?.thunderforestKey ? '已使用本站提供的 key' : '選填'}"></label>
<p class="note" id="set-tf-note">OpenCycleMap、Landscape、Outdoors 由 Thunderforest 提供，共用同一組 API key（至 thunderforest.com 註冊免費 Hobby 方案即可取得）；未設定時改以等高線地形圖顯示。</p>
<p class="note">可填入魯地圖等提供 XYZ 圖磚的網址（請遵守該服務的使用條款）。</p>
<button class="btn" id="set-dl">下載目前範圍底圖供離線使用</button> <output id="set-dl-out"></output>
</fieldset>
<fieldset><legend>安全評估門檻</legend>
<div class="grid2">
<label>時雨量 注意 ≥ <input type="number" class="num" data-th="rain1h" value="${th.rain1h}"> mm</label><label>危險 ≥ <input type="number" class="num" data-th="rain1hRed" value="${th.rain1hRed}"> mm</label>
<label>24h 雨量 注意 ≥ <input type="number" class="num" data-th="rain24" value="${th.rain24}"> mm</label><label>危險 ≥ <input type="number" class="num" data-th="rain24Red" value="${th.rain24Red}"> mm</label>
<label>陣風 注意 ≥ <input type="number" class="num" data-th="gust" value="${th.gust}"> m/s</label><label>危險 ≥ <input type="number" class="num" data-th="gustRed" value="${th.gustRed}"> m/s</label>
<label>體感溫度 注意 ≤ <input type="number" class="num" data-th="cold" value="${th.cold}"> °C</label><label>危險 ≤ <input type="number" class="num" data-th="coldRed" value="${th.coldRed}"> °C</label>
</div></fieldset>
<fieldset><legend>資料與離線</legend>
<p>資料更新：${esc(fmtTime(S.manifest?.built))}</p>
<table class="kv"><tbody>${Object.entries(S.manifest?.status || {}).map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${v.ok ? '<span class="ok">PASS</span>' : `<span class="bad">FAIL</span> ${esc(v.error || '')}`}</td></tr>`).join('')}</tbody></table>
<button class="btn" id="set-src">資料來源與授權</button>
<button class="btn" id="set-clear">清除最近查詢與收藏</button>
<button class="btn" id="set-reset">恢復預設設定</button>
</fieldset>`;
  const save = () => { saveSettings(s); applySettings(s); };
  body.querySelector('#set-base').addEventListener('change', (e) => { s.basemap = e.target.value; save(); setBasemap(); });
  body.querySelector('#set-custom').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (v && !/^https:\/\/.+\{z\}.+\{x\}.+\{y\}|^https:\/\/.+\{z\}.+\{y\}.+\{x\}/.test(v)) { e.target.setCustomValidity('網址需為 https 並包含 {z} {x} {y}'); e.target.reportValidity(); return; }
    e.target.setCustomValidity('');
    s.customTile = v; save(); if (s.basemap === 'custom') setBasemap();
  });
  body.querySelector('#set-tfkey').addEventListener('change', (e) => { s.tfKey = e.target.value.trim(); save(); if (BASEMAPS[s.basemap]?.tf) setBasemap(); });
  body.querySelectorAll('[data-th]').forEach((i) => i.addEventListener('change', () => { s.thresholds[i.dataset.th] = Number(i.value); save(); }));
  body.querySelector('#set-dl').addEventListener('click', () => downloadTiles(body.querySelector('#set-dl-out')));
  body.querySelector('#set-src').addEventListener('click', () => { dlg.close(); showSources(); });
  body.querySelector('#set-clear').addEventListener('click', async (e) => { await clearAll(); e.target.textContent = '已清除'; });
  body.querySelector('#set-reset').addEventListener('click', () => {
    Object.assign(s, JSON.parse(JSON.stringify(DEFAULTS)));
    save(); setBasemap(); showLayer(s.layer); dlg.close();
    $('#lbl-size').value = String(s.labelScale);
    $('#lbl-size-out').textContent = `${Math.round(s.labelScale * 100)}%`;
    buildUiOptions();
    setLayerBar(s.layerBar);
    buildOverlayToggles();
    applyOverlayVisibility();
  });
  dlg.showModal();
}

async function downloadTiles(out) {
  if (!baseLayer) return;
  if ((BASEMAPS[S.settings.basemap] || {}).noBulk) {
    out.textContent = 'Thunderforest 底圖不提供批次下載（用量計費）；瀏覽過的圖磚仍會快取供離線使用。';
    return;
  }
  const b = S.map.getBounds();
  const z0 = S.map.getZoom();
  const maxZ = Math.min(z0 + 3, 15, baseLayer.options.maxZoom);
  const urls = [];
  for (let z = Math.max(z0, 8); z <= maxZ; z += 1) {
    const p1 = S.map.project(b.getNorthWest(), z).divideBy(256).floor();
    const p2 = S.map.project(b.getSouthEast(), z).divideBy(256).floor();
    for (let x = p1.x; x <= p2.x; x += 1) for (let y = p1.y; y <= p2.y; y += 1) urls.push(baseLayer.getTileUrl({ x, y, z }));
  }
  if (urls.length > 1500) { out.textContent = `範圍太大（${urls.length} 張圖磚），請放大地圖後再試（上限 1500）。`; return; }
  let done = 0;
  for (const u of urls) {
    try { await fetch(u, { mode: 'cors' }); } catch { /* ignore individual failures */ }
    done += 1;
    if (done % 20 === 0 || done === urls.length) out.textContent = `${done}/${urls.length}`;
  }
  out.textContent = `完成：${urls.length} 張圖磚已快取`;
}

// Swipe the sheet header: up = expand, down = shrink / close (bottom-sheet layout only).
function bindSheetSwipe() {
  const head = document.querySelector('.sheet-head');
  let y0 = null;
  head.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
  head.addEventListener('touchend', (e) => {
    if (y0 === null) return;
    const dy = e.changedTouches[0].clientY - y0;
    y0 = null;
    if (Math.abs(dy) < 50) return;
    const sh = $('#sheet');
    const mini = sh.classList.contains('mini');
    const full = sh.classList.contains('full');
    // Down: full -> normal -> minimised (never closes; the close button does that).
    if (dy > 0) {
      if (full) $('#sheet-toggle').click();
      else if (!mini) setSheetMini(true);
    } else if (mini) {
      setSheetMini(false);
    } else if (!full && getComputedStyle($('.sheet-grab')).display !== 'none') {
      $('#sheet-toggle').click();
    }
  });
}

// ---------------------------------------------------------------- boot
async function loadData() {
  const manifest = await getJSON('manifest.json');
  S.manifest = manifest;
  setDataVersion(manifest.built);
  const [st, spots, quakes, typhoon, warnings, sat, topo] = await Promise.all([
    getJSON('stations.json', { optional: true }), getJSON('spots/index.json', { optional: true }),
    getJSON('quakes.json', { optional: true }), getJSON('typhoon.json', { optional: true }),
    getJSON('warnings.json', { optional: true }), getJSON('sat/index.json', { optional: true }),
    fetch('geo/towns-10t.json').then((r) => r.json()),
  ]);
  const peaks = await getJSON('peaks.json', { optional: true });
  S.peaks = (peaks?.peaks || []).map(([n, lat, lon, ele, osm]) => ({ k: `osm-${osm}`, n, lat, lon, ele }));
  S.stations = st?.stations || [];
  S.stationsTime = st?.time;
  S.spots = spots?.spots || [];
  S.spotCats = spots?.categories || [];
  S.quakes = quakes?.quakes || [];
  S.typhoon = typhoon;
  S.warnings = warnings;
  S.sat = sat || [];
  S.towns = topojson.feature(topo, topo.objects.towns).features.map((f) => ({ ...f, bbox: bbox(f.geometry) }));
  S.counties = topojson.feature(topo, topo.objects.counties).features;
}

async function main() {
  S.settings = loadSettings();
  applySettings(S.settings);
  try { matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applySettings(S.settings)); } catch { /* old browsers */ }

  S.map = L.map('map', { zoomControl: true, preferCanvas: true, minZoom: 6, maxZoom: 18, keyboard: true })
    .setView([23.75, 121.0], 8);
  S.map.createPane('shake').style.zIndex = 350; // below vector overlays (rings, markers)
  S.map.createPane('labels').style.zIndex = 605; // names, below the clickable markers
  S.map.getPane('labels').style.pointerEvents = 'none';
  S.map.createPane('stations').style.zIndex = 610;
  S.map.createPane('spots').style.zIndex = 620;
  S.map.createPane('alerts').style.zIndex = 640; // strong-earthquake icons, above all other markers
  S.map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  L.control.scale({ imperial: false }).addTo(S.map);
  setBasemap();
  initMapOptions();
  // A map tap first closes the options panel instead of opening a point.
  S.map.on('click', (e) => {
    if ($('#more').classList.contains('open')) { setOptsOpen(false); return; }
    showPoint(e.latlng.lat, e.latlng.lng);
  });
  S.map.on('zoomend', applyOverlayVisibility);
  S.map.on('moveend', () => { updatePeaks(); updateLabels(); });
  S.map.on('zoomend', layoutTyLabels);
  document.addEventListener('quakemode', (e) => {
    applyOverlayVisibility();
    setWeatherVisible(!e.detail);
    document.getElementById('legend').classList.toggle('quake-hide', e.detail);
    // The earthquake view draws its own epicentre marker.
    if (strongLayer) { if (e.detail) S.map.removeLayer(strongLayer); else strongLayer.addTo(S.map); }
  });

  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-back').addEventListener('click', sheetBack);
  $('#sheet-min').addEventListener('click', () => setSheetMini(!$('#sheet').classList.contains('mini')));
  $('#sheet-title').addEventListener('click', () => { if ($('#sheet').classList.contains('mini')) setSheetMini(false); });
  $('#sheet-toggle').addEventListener('click', () => {
    const sh = $('#sheet');
    if (sh.classList.contains('mini')) setSheetMini(false, { refit: false });
    const full = sh.classList.toggle('full');
    if (full) sh.classList.remove('peek');
    document.body.classList.toggle('sheet-full', full);
    $('#sheet-toggle').setAttribute('aria-expanded', String(full));
    setTimeout(() => S.map.invalidateSize(), 50);
  });
  bindSheetSwipe();
  // Keep the map sized correctly when the side panel opens/closes on wide screens.
  new MutationObserver(() => S.map.invalidateSize()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  new MutationObserver(() => S.map.invalidateSize()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-ui'] });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('dialog[open]') && !$('#sheet').hidden) closeSheet();
  });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-alerts').addEventListener('click', showAlerts);
  $('#btn-typhoon').addEventListener('click', showTyphoon);
  $('#btn-recent').addEventListener('click', showRecent);
  $('#btn-affected').addEventListener('click', () => { setOptsOpen(false); showAffected(); });
  $('#btn-locate').addEventListener('click', () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((p) => {
      flyTo(p.coords.latitude, p.coords.longitude, 12);
      showPoint(p.coords.latitude, p.coords.longitude, { label: '我的位置' });
    }, () => alert('無法取得目前位置'), { enableHighAccuracy: true, timeout: 15000 });
  });
  const op = $('#opacity');
  op.value = String(S.settings.opacity);
  op.addEventListener('input', () => { setOpacity(Number(op.value)); op.setAttribute('aria-valuetext', `${Math.round(op.value * 100)}%`); });
  op.addEventListener('change', () => saveSettings(S.settings));
  $('#dlg-settings').addEventListener('close', () => updateStatus());
  window.addEventListener('resize', placeLegend);
  new ResizeObserver(placeLegend).observe($('#status'));
  window.addEventListener('online', updateStatus);
  window.addEventListener('offline', updateStatus);

  try {
    await loadData();
  } catch (e) {
    console.error(e);
    $('#status').innerHTML = '<span class="warn-txt">無法載入資料。若為首次開啟請連上網路；之後即可離線使用已快取的資料。</span>';
    return;
  }
  if (BASEMAPS[S.settings.basemap]?.tf) setBasemap(); // the site-wide key arrives with the manifest
  buildChips();
  buildOverlayToggles();
  bindSearch();
  showTyphoonByDefault();
  buildOverlays();
  updateStatus();
  showLayer(S.settings.layer);
  document.body.classList.add('ready');
}

/** While a typhoon warning is in force, the typhoon layer is shown on start-up and the map frames Taiwan with the typhoon and its next 24 h. */
function showTyphoonByDefault() {
  const ty = S.typhoon?.active ? S.typhoon : null;
  if (!ty) return;
  S.settings.overlays.typhoon = true;
  const pts = ty.cyclones.flatMap((c) => [c.past[c.past.length - 1], ...c.fcst.filter((f) => (f.h ?? 0) <= 24)]).filter(Boolean);
  if (!pts.length) return;
  const b = L.latLngBounds([[21.9, 119.3], [25.3, 122.0]]);
  pts.forEach((p) => b.extend([p.lat, p.lon]));
  S.map.fitBounds(b, { padding: [20, 20], maxZoom: 8, animate: false });
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e)));
  // A new version took over (the service worker activates immediately): reload once so the page matches it.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || reloaded) return;
    reloaded = true;
    location.reload();
  });
}

main();
