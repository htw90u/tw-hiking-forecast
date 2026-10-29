// Entry point: map setup, data loading, overlays, controls and settings.
import { S } from './state.js';
import { loadSettings, saveSettings, applySettings, DEFAULTS } from './settings.js';
import { ico, paintIcons } from './icons.js';
import { getJSON, setDataVersion, fmtTime, ageText, esc, bbox, $, intText, isStrongQuake, eleText } from './util.js';
import { LAYERS, showLayer, setOpacity, stopAnimation, restartAnimation, setWeatherVisible } from './layers.js';
import { PALETTE_NAMES } from './palettes.js';
import {
  showPoint, closeSheet, sheetBack, setSheetMini, showSources, showAlerts, showRecent, showAffected, showQuake, showQuakes, showTyphoon, search, flyTo,
} from './views.js';
import { clearAll, toggleFav, listFav, pointId } from './store.js';

// Historical maps of Academia Sinica RCHSS (臺灣百年歷史地圖 WMTS; CC BY-NC). The RESTful tile address works; the KVP one answers 500.
// Tiles outside a map's coverage come back transparent, so partial maps can be stacked on any base map.
const HIST_ATTR = '歷史地圖 © <a href="https://gis.sinica.edu.tw/tileserver/">中央研究院人文社會科學研究中心 GIS 專題中心</a> (CC BY-NC)';
const histUrl = (h) => `https://gis.sinica.edu.tw/tileserver/file-exists.php?img=${h.id}-${h.ext}-{z}-{x}-{y}`;
const HIST_BASE = [
  { id: 'TM25K_2001', ext: 'jpg', max: 17, label: '經建3版地形圖 1:25,000（2001）' },
];
// Stack on top of the base map (oldest first); outside their coverage the base map shows through.
const HIST_OVER = [
  { id: 'TM25K_2003', ext: 'jpg', max: 17, label: '經建4版地形圖 1:25,000（2003）・部分地區' },
  { id: 'Sunriver_50K_N_2017', ext: 'png', max: 15, label: '臺灣歷史人文全覽圖 北島（2017）・僅北部都會區有詳圖，需放大' },
];

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
  ...Object.fromEntries(HIST_BASE.map((h) => [`h_${h.id}`, { label: `歷史：${h.label}`, url: histUrl(h), max: h.max, hist: true, noBulk: true, attr: HIST_ATTR }])),
  custom: { label: '自訂圖磚網址', url: '', max: 19, attr: '自訂底圖' },
};

let baseLayer = null;
let histLayers = [];
let strongLayer = null;
const STRONG_QUAKE_MS = 3 * 864e5;

/** Personal key from the settings, else the site-wide key from the manifest. */
function thunderforestKey() {
  return (S.settings.tfKey || S.manifest?.config?.thunderforestKey || '').trim();
}

// Thunderforest maps stop answering when the free monthly tile quota is used up. After enough failed tiles the map switches
// to the Taiwan e-map for a while (remembered, so a reload does not hammer the service again).
const TF_RETRY_MS = 6 * 3600e3;
const TF_OVER_KEY = 'hikingwx.tfOver.v1';

function tfOverQuota(key) {
  try {
    const o = JSON.parse(localStorage.getItem(TF_OVER_KEY) || 'null');
    return Boolean(o && o.key === key && Date.now() - o.t < TF_RETRY_MS);
  } catch { return false; }
}

function markTfOverQuota(key) {
  try { localStorage.setItem(TF_OVER_KEY, JSON.stringify({ key, t: Date.now() })); } catch { /* storage blocked: only this visit falls back */ }
}

function setBasemap() {
  const s = S.settings;
  let key = s.basemap;
  S.baseNotice = '';
  const tf = BASEMAPS[key]?.tf;
  if (tf && !thunderforestKey()) {
    // Thunderforest maps without an API key only return "API Key Required" tiles.
    key = 'emap';
    S.baseNotice = `${tf} 需要 Thunderforest API key（設定 → 底圖），目前先以臺灣通用電子地圖顯示。`;
  } else if (tf && tfOverQuota(key)) {
    key = 'emap';
    S.baseNotice = `Thunderforest 圖磚額度已用完或暫時無法載入，已改用臺灣通用電子地圖（約 6 小時後再試）。`;
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
      let loads = 0;
      let tripped = false;
      baseLayer.on('tileload', () => { loads += 1; });
      baseLayer.on('tileerror', () => {
        errors += 1;
        // Several failures and (almost) no successes: the quota is used up, the key is wrong or the service is down.
        if (!tripped && errors >= 4 && loads <= errors / 3) {
          tripped = true;
          markTfOverQuota(key);
          setBasemap();
        }
      });
    }
    baseLayer.addTo(S.map);
  }
  setHistOverlays();
  if (S.manifest) updateStatus();
}

/** Historical maps stacked above the base map (settings.histOverlays: {id: opacity}). */
function setHistOverlays() {
  histLayers.forEach((l) => S.map.removeLayer(l));
  histLayers = [];
  const on = S.settings.histOverlays || {};
  HIST_OVER.forEach((h, i) => {
    if (on[h.id] === undefined) return;
    const l = L.tileLayer(histUrl(h), { maxZoom: 22, maxNativeZoom: h.max, opacity: Number(on[h.id]) || 0.8, zIndex: 2 + i, attribution: HIST_ATTR, crossOrigin: true });
    l.addTo(S.map);
    histLayers.push(l);
  });
}

// ---------------------------------------------------------------- overlays
// Map icons for the CWA recreation-forecast categories (F-B0053): white line glyphs (24 px grid)
// on a rounded square in the category group's colour; mountains use the triangle pins below.
const SPOT_GLYPHS = {
  beach: 'M3 12a9 9 0 0 1 18 0z M12 12v7a2 2 0 0 0 4 0',
  park: 'M6 19a3.2 3.2 0 1 0 .01 0z M18 19a3.2 3.2 0 1 0 .01 0z M6 19l3.5-8h6.5l2 8 M9.5 11l3 8 M8 7.5h3 M14.5 11 13 7h3',   // bicycle (CWA "公園綠地" = cycling routes)
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
// Mountains with a CWA hiking forecast: solid triangle; other (OSM) peaks: outlined triangle.
const MTN_SVG = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 2 17 16H1z"/></svg>';
// Icons of the marker toggles that had none (same drawing language as the map markers).
const STN_SVG = '<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="4.6"/></svg>';
const EQ_SVG = '<svg viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="2"/><circle cx="7" cy="7" r="5.2"/></svg>';
const TY_SVG = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.8a5.2 5.2 0 1 1-4.9 3.5M7 4.6a2.4 2.4 0 1 1-2.4 2.4"/></svg>';
const SPOT_SVG = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 1.4a4.2 4.2 0 0 0-4.2 4.2c0 3.1 4.2 7 4.2 7s4.2-3.9 4.2-7A4.2 4.2 0 0 0 7 1.4z"/><circle cx="7" cy="5.6" r="1.5"/></svg>';
const PEAK_SVG = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M7 2.2 12.6 12H1.4z"/></svg>';
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
    const icon = mountain ? L.divIcon({ className: 'pin-mtn', html: MTN_SVG, iconSize: [18, 18] })
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
  // Strong quakes of the last 3 days get the separate warning icon instead (buildStrongQuakes).
  S.quakes.filter((q) => Date.now() - new Date(q.time).getTime() < 7 * 864e5)
    .filter((q) => !(isStrongQuake(q) && Date.now() - new Date(q.time).getTime() < STRONG_QUAKE_MS)).forEach((q) => {
    // Badge with the magnitude; size grows with magnitude, last 24 h drawn darker.
    const size = Math.round(20 + Math.max(0, q.mag - 3) * 6);
    const recent = Date.now() - new Date(q.time).getTime() < 864e5;
    const icon = L.divIcon({ className: `eq-mk${recent ? ' recent' : ''}`, iconSize: [size, size], html: `<span>${esc(Number(q.mag).toFixed(1))}</span>` });
    const m = L.marker([q.lat, q.lon], { icon, pane: 'spots', title: `地震 規模${q.mag}`, alt: `地震 規模${q.mag}`, keyboard: true });
    m.bindTooltip(`地震 規模 ${q.mag}<br>${esc(fmtTime(q.time))}・最大震度 ${intText(q.maxInt)}`);
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
        L.marker([cur.lat, cur.lon], { icon: L.divIcon({ className: 'ty-icon', html: ico('typhoon'), iconSize: [30, 30] }), title: `${c.cname}颱風` })
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
    const icon = L.divIcon({ className: 'pin-peak', html: PEAK_SVG, iconSize: [14, 14] });
    const m = L.marker([p.lat, p.lon], { icon, title: p.n, alt: p.n, keyboard: false, pane: 'spots' });
    const tags = p.tags.map((t) => S.peakLists[t] || t).join('・');
    m.bindTooltip(`${esc(p.n)}${p.ele ? ` ${eleText(p)}` : ''}${p.area || tags ? `<br><small>${esc([p.area, tags].filter(Boolean).join('・'))}</small>` : ''}`, { direction: 'top', offset: [0, -6] });
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
// Layer groups: the bar shows the chips of one group, the tabs above them switch the group.
const LAYER_GROUPS = [
  ['rain', '降水', ['radar', 'qpe1h', 'rainacc', 'qpf1h', 'qpf', 'pop', 'tyrain']],
  ['wx', '天氣', ['temp', 'wind', 'uv', 'heat', 'visib', 'lightning']],
  ['model', '模式', ['wrf3', 'wrfg', 'mm']],
  ['image', '影像', ['sat', 'nasa']],
  ['hydro', '水文', ['water', 'debris']],
];
const groupOf = (id) => LAYER_GROUPS.find((g) => g[2].includes(id))?.[0];

/** Show the chips of one group (default: the group of the chosen layer). */
function showGroup(key, reset = true) {
  const g = LAYER_GROUPS.find((x) => x[0] === key) || LAYER_GROUPS[0];
  S.layerGroup = g[0];
  document.querySelectorAll('#chips [data-layer]').forEach((b) => b.classList.toggle('grp-off', !g[2].includes(b.dataset.layer)));
  document.querySelectorAll('#chip-groups [data-group]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.group === g[0])));
  if (reset) { const first = document.querySelector('#chips [data-layer]:not(.grp-off)'); if (first) first.parentElement.scrollLeft = 0; }
}

/** Keep the chosen layer's chip in view (a layer beyond the visible edge must not scroll back out of sight). */
function revealChip(id) {
  document.querySelector(`#chips [data-layer="${id}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function buildChips() {
  const box = document.getElementById('chips');
  const tabs = document.getElementById('chip-groups');
  const tyTables = S.typhoon?.tables || {};
  const items = LAYERS.filter((l) => !l.typhoonOnly || (S.typhoon?.active && (tyTables.rain24 || tyTables.rainTotal)));
  box.innerHTML = items.filter((l) => l.id !== 'none').map((l) => `<button class="chip" role="radio" data-layer="${l.id}" data-group="${groupOf(l.id) || ''}" aria-checked="${l.id === S.settings.layer}"${l.id === 'none' ? '' : ` title="${esc(l.label)}（選取中再點一次可關閉圖層）"`}>${esc(l.label)}</button>`).join('');
  tabs.innerHTML = LAYER_GROUPS.filter((g) => g[2].some((id) => box.querySelector(`[data-layer="${id}"]`)))
    .map((g) => `<button type="button" class="seg-btn" role="tab" data-group="${g[0]}" aria-checked="false">${g[1]}</button>`).join('');
  tabs.querySelectorAll('[data-group]').forEach((b) => b.addEventListener('click', () => showGroup(b.dataset.group)));
  showGroup(groupOf(S.settings.layer) || LAYER_GROUPS[0][0]);
  box.querySelectorAll('[data-layer]').forEach((b) => b.addEventListener('click', () => {
    let id = b.dataset.layer;
    // Choosing a weather layer during the earthquake view shows it again.
    if (S.layer.hidden) { setWeatherVisible(true); document.getElementById('legend').classList.remove('quake-hide'); document.getElementById('map-banner').classList.remove('quake-hide'); }
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
    const btns = [...box.querySelectorAll('[data-layer]:not(.grp-off)')];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const n = btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
    n.focus();
    n.click();
    e.preventDefault();
  });
}

function buildOverlayToggles() {
  const MK = (cls, svg) => `<span class="${cls} tog-ic" aria-hidden="true">${svg}</span>`;
  // Rows: observations and hazards / forecast mountains and spots / all peaks ('|' starts a new row).
  const items = [['stations', `${MK('ic-stn', STN_SVG)}觀測站`], ['quakes', `${MK('ic-eq', EQ_SVG)}地震`], ['typhoon', `${MK('ic-ty', TY_SVG)}颱風`], '|', ['mountains', `${MK('pin-mtn', MTN_SVG)}有預報的山`], ['spots', `${MK('ic-spot', SPOT_SVG)}景點`], '|', ['peaks', `${MK('pin-peak', PEAK_SVG)}所有山頭`]];
  const box = document.getElementById('toggles');
  const names = [['stations', `${MK('ic-stn', STN_SVG)}觀測站`], '|', ['mountains', `${MK('pin-mtn', MTN_SVG)}有預報的山`], ['spots', `${MK('ic-spot', SPOT_SVG)}景點`], '|', ['peaks', `${MK('pin-peak', PEAK_SVG)}所有山頭`]];
  const group = (id, title, attr, list, state) => `<div class="tog-group" role="group" aria-labelledby="${id}-t">
<div class="tog-head"><span class="tog-lbl" id="${id}-t">${title}</span><span class="tog-all"><button type="button" class="link" data-all="${attr}" data-on="1">全選</button><button type="button" class="link" data-all="${attr}" data-on="0">全部取消</button></span></div>
${list.map((x) => (x === '|' ? '<span class="tog-row" aria-hidden="true"></span>' : `<label class="tog"><input type="checkbox" data-${attr}="${x[0]}"${state[x[0]] ? ' checked' : ''}> ${x[1]}</label>`)).join('')}</div>`;
  const cats = S.spotCats.filter((c) => c.id !== 'mountain' && S.spots.some((p) => p.c === c.id));
  box.innerHTML = group('tg-ov', '地圖標記', 'ov', items, S.settings.overlays)
    + group('tg-lbl', '顯示名稱', 'lbl', names, S.settings.labels)
    + `<details class="cat-legend"><summary>圖示說明</summary><ul>
<li><span class="lg-dot" style="background:#fff" aria-hidden="true"></span>氣象站（溫度、風、雨量）</li>
<li><span class="lg-dot" style="background:#9ec5ff" aria-hidden="true"></span>雨量站（只有雨量）</li>
<li>${MK('pin-mtn', MTN_SVG)}有氣象署登山預報的山</li>
<li>${MK('pin-peak', PEAK_SVG)}山頭（OSM，無預報）</li>
<li><span class="eq-mk lg-eq" aria-hidden="true"><span>4.5</span></span>地震（數字為規模，7 天內）</li>
<li><span class="lg-strong" aria-hidden="true"><span class="eq-core">震</span></span>強震（震度 5 弱以上或規模 6 以上）</li>
<li><span class="my-loc lg-me" aria-hidden="true"><span></span></span>我的位置</li>
${cats.map((c) => `<li><span class="pin-cat cat-${c.id}" aria-hidden="true">${spotIcon(c.id)}</span>${esc(c.label)}</li>`).join('')}</ul></details>`;
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
  // The legend sits at the map's bottom-right, just above the attribution line.
  const map = document.getElementById('map').getBoundingClientRect();
  const attr = document.querySelector('.leaflet-control-attribution')?.getBoundingClientRect();
  const above = attr && attr.height ? attr.height : 0;
  // Keep the banner clear of the zoom buttons (left) and the options button (right).
  const side = Math.max(document.getElementById('btn-more').getBoundingClientRect().width, 44) + 22;
  document.documentElement.style.setProperty('--banner-side', `${Math.round(side)}px`);
  document.documentElement.style.setProperty('--legend-bottom', `${Math.round(window.innerHeight - map.bottom + above + 6)}px`);
  document.documentElement.style.setProperty('--legend-right', `${Math.round(window.innerWidth - map.right + 6)}px`);
  // The open options panel and the legend must fit inside the map: below the options button, above the attribution line.
  const btn = document.getElementById('btn-more').getBoundingClientRect();
  document.documentElement.style.setProperty('--legend-max-h', `${Math.max(80, Math.round(map.bottom - btn.bottom - above - 14))}px`);
  // Opened, it may grow over the options button (short maps), but never under the top bar.
  const top = document.querySelector('.topbar')?.getBoundingClientRect().bottom || 0;
  document.documentElement.style.setProperty('--legend-open-max-h', `${Math.max(120, Math.round(map.bottom - above - 6 - top - 8))}px`);
  document.documentElement.style.setProperty('--opts-max-h', `${Math.max(120, Math.round(map.bottom - btn.bottom - above - 14))}px`);
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
  S.scale.remove().addTo(S.map); // re-add so the scale stacks above the layer button
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

/** White dot (with the GPS accuracy circle) at the user's position; stays until the page is reloaded. */
let myLoc = null;
function showMyLocation(c) {
  const ll = [c.latitude, c.longitude];
  if (!myLoc) {
    myLoc = {
      acc: L.circle(ll, { radius: c.accuracy || 0, color: '#1a73e8', weight: 1, fillColor: '#1a73e8', fillOpacity: 0.12, interactive: false }),
      dot: L.marker(ll, { icon: L.divIcon({ className: 'my-loc', html: '<span></span>', iconSize: [20, 20] }), title: '我的位置', alt: '我的位置', zIndexOffset: 2000, pane: 'alerts' }),
    };
    myLoc.acc.addTo(S.map);
    myLoc.dot.addTo(S.map).on('click', (e) => { L.DomEvent.stop(e); const p = myLoc.dot.getLatLng(); showPoint(p.lat, p.lng, { label: '我的位置' }); });
  }
  myLoc.acc.setLatLng(ll).setRadius(Math.min(c.accuracy || 0, 5000));
  myLoc.dot.setLatLng(ll).bindTooltip(`我的位置（精度約 ${Math.round(c.accuracy || 0)} m）`);
}

/** The collapsed-bar button names the current weather layer. */
function updateBarLabel() {
  const l = LAYERS.find((x) => x.id === S.settings.layer);
  $('#bar-show-layer').textContent = l && l.id !== 'none' ? `：${l.label}` : '';
  if (l && l.id !== 'none' && S.syncedLayer !== l.id) { S.syncedLayer = l.id; if (groupOf(l.id) && groupOf(l.id) !== S.layerGroup) showGroup(groupOf(l.id)); revealChip(l.id); }
}

/** Text / icon interface switch in the map options panel (other display settings are in 設定). */
function buildUiOptions() {
  const box = $('#opts-ui');
  box.innerHTML = [['text', '文字版'], ['icon', '圖示版']]
    .map(([k, l]) => `<button type="button" class="seg-btn" role="radio" data-ui="${k}" aria-checked="${S.settings.ui === k}">${l}</button>`).join('');
  box.querySelectorAll('[data-ui]').forEach((b) => b.addEventListener('click', () => {
    S.settings.ui = b.dataset.ui;
    saveSettings(S.settings);
    applySettings(S.settings);
    box.querySelectorAll('[data-ui]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    placeLegend();
  }));
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
  const tyBanner = ty ? `<button class="ty-banner" id="ty-banner" title="${esc(tyTitle)}" aria-label="${esc(`${tyNames ? `${tyNames}颱風` : '颱風'}，${tyTitle}，查看詳情`)}"><span aria-hidden="true">${ico('typhoon')}</span><span>${esc(tyNames ? `${tyNames}颱風` : '颱風')}</span><span class="ty-more" aria-hidden="true">›</span></button>` : '';
  // Felt earthquakes in the last 24 hours get their own banner and tab (like a typhoon warning).
  const recentQ = (S.quakes || []).filter((q) => Date.now() - new Date(q.time).getTime() < QUAKE_RECENT_MS);
  const q0 = recentQ.find(isStrongQuake) || recentQ[0];   // a strong quake leads the status strip
  const qPlace = q0 ? (q0.loc.match(/位於([^)）]+)/)?.[1] || q0.loc).trim() : '';
  const eqBanner = q0 ? `<button class="ty-banner eq-banner" id="eq-banner" title="${esc(`${fmtTime(q0.time)} ${qPlace}`)}" aria-label="${esc(`地震 ${fmtTime(q0.time)} ${qPlace} 規模${Number(q0.mag).toFixed(1)} 最大震度${intText(q0.maxInt)}，24 小時內 ${recentQ.length} 起，查看詳情`)}"><span aria-hidden="true">${ico('wave')}</span><span>${isStrongQuake(q0) ? '強震' : '地震'} ${esc(Number(q0.mag).toFixed(1))}・${esc(intText(q0.maxInt))}${recentQ.length > 1 ? `（${recentQ.length} 起）` : ''}</span><span class="ty-more" aria-hidden="true">›</span></button>` : '';
  // Base-map notice: a short warning pill; the full sentence opens under the strip (and stays in the text for screen readers).
  if (S.baseNoteFor !== S.baseNotice) { S.baseNoteFor = S.baseNotice; S.baseNoteDone = false; clearTimeout(S.baseNoteTimer); S.baseNoteTimer = null; }
  const baseNote = S.baseNotice && !S.baseNoteDone ? `<button type="button" class="sp sp-warn base-note" aria-expanded="false" aria-controls="base-detail">底圖已改用臺灣通用 ⓘ<span class="sr-only">：${esc(S.baseNotice)}</span></button>` : '';
  const upd = `<span class="sp sp-plain">資料更新 ${esc(fmtTime(built, { date: false }))}（${esc(ageText(built))}）</span>`;
  el.innerHTML = `<div class="strip-row">${tyBanner}${eqBanner}${baseNote}${off ? '<span class="sp sp-off">離線・顯示快取資料</span>' : ''}${upd}${failed.length ? `<span class="sp sp-warn">部分資料暫缺：${esc(failed.join(', '))}</span>` : ''}</div>${S.baseNotice && !S.baseNoteDone ? `<p class="strip-detail" id="base-detail" hidden>${esc(S.baseNotice)}</p>` : ''}`;
  const bn = el.querySelector('.base-note');
  if (bn && !S.baseNoteTimer) S.baseNoteTimer = setTimeout(() => { S.baseNoteDone = true; updateStatus(); }, 10000);
  if (bn) bn.addEventListener('click', () => { const d = el.querySelector('#base-detail'); d.hidden = !d.hidden; bn.setAttribute('aria-expanded', String(!d.hidden)); });
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

// ---- search history (what was searched for): kept in this browser, newest first, each entry can be deleted
const SEARCH_HISTORY_KEY = 'hikingwx.searchHistory.v1';
const SEARCH_HISTORY_MAX = 10;
function loadSearchHistory() {
  try { const a = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY)); return Array.isArray(a) ? a.filter((x) => typeof x === 'string' && x) : []; } catch { return []; }
}
function saveSearchHistory(a) {
  try { localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(a.slice(0, SEARCH_HISTORY_MAX))); } catch { /* storage blocked: history is simply not kept */ }
}
function rememberSearch(q) {
  const t = q.trim();
  if (t) saveSearchHistory([t, ...loadSearchHistory().filter((x) => x.toLowerCase() !== t.toLowerCase())]);
}

function bindSearch() {
  const input = document.getElementById('q');
  const list = document.getElementById('q-results');
  let results = [];
  const showHistory = () => {
    const hist = loadSearchHistory();
    results = [];
    list.innerHTML = hist.length
      ? hist.map((q, i) => `<li role="option" class="hist" id="qh-${i}" tabindex="-1" data-h="${i}"><span class="tag">最近搜尋</span>${esc(q)}<button type="button" class="hist-del" data-hdel="${i}" aria-label="刪除搜尋紀錄：${esc(q)}" title="刪除">✕</button></li>`).join('')
        + '<li role="option" class="hist-clear" tabindex="-1" data-hclear>清除全部搜尋紀錄</li>'
      : '';
    list.hidden = !hist.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
  };
  const choose = (r) => {
    rememberSearch(input.value);
    list.hidden = true;
    input.value = r.label;
    flyTo(r.lat, r.lon, 12);
    showPoint(r.lat, r.lon, { spotKey: r.spot, stationId: r.station, peak: r.peak, label: r.type === '鄉鎮' ? r.label : undefined });
  };
  input.addEventListener('focus', () => { if (!input.value.trim()) showHistory(); });
  document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#search-form')) { list.hidden = true; input.setAttribute('aria-expanded', 'false'); } });
  input.addEventListener('input', () => {
    if (!input.value.trim()) { showHistory(); return; }
    results = search(input.value);
    list.innerHTML = results.map((r, i) => `<li role="option" id="qr-${i}" tabindex="-1" data-i="${i}"><span class="tag">${esc(r.type)}</span>${esc(r.label)}${r.sub ? `<span class="sub">${esc(r.sub)}</span>` : ''}<button type="button" class="fav-btn" data-fav="${i}" aria-pressed="false" aria-label="加入收藏：${esc(favTitle(r))}" title="加入收藏">${ico('star')}</button></li>`).join('');
    list.hidden = !results.length;
    input.setAttribute('aria-expanded', String(!list.hidden));
    paintFavs();
  });
  // The star in each result adds the place to the favourites without opening it.
  const favTitle = (r) => (r.type === '座標' ? `座標 ${r.label}` : r.label.replace(/（[^）]*）$/, ''));
  const favEntry = (r) => ({ id: pointId(r.lat, r.lon), lat: r.lat, lon: r.lon, title: favTitle(r), spotKey: r.spot, stationId: r.station, peakKey: r.peak?.k });
  const paintFavs = () => listFav().then((favs) => list.querySelectorAll('[data-fav]').forEach((b) => {
    const on = favs.some((f) => f.id === pointId(results[Number(b.dataset.fav)].lat, results[Number(b.dataset.fav)].lon));
    b.innerHTML = ico(on ? 'star-fill' : 'star');
    b.setAttribute('aria-pressed', String(on));
    b.title = on ? '取消收藏' : '加入收藏';
  }));
  list.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-hdel]');
    if (del) {
      e.stopPropagation();
      saveSearchHistory(loadSearchHistory().filter((_, i) => i !== Number(del.dataset.hdel)));
      showHistory();
      input.focus();
      return;
    }
    if (e.target.closest('[data-hclear]')) { saveSearchHistory([]); showHistory(); input.focus(); return; }
    const h = e.target.closest('[data-h]');
    if (h) { input.value = loadSearchHistory()[Number(h.dataset.h)] || ''; input.dispatchEvent(new Event('input')); if (results[0]) choose(results[0]); else input.focus(); return; }
    const star = e.target.closest('[data-fav]');
    if (star) {
      e.stopPropagation();
      await toggleFav(favEntry(results[Number(star.dataset.fav)]));
      paintFavs();
      return;
    }
    const li = e.target.closest('[data-i]');
    if (li) choose(results[Number(li.dataset.i)]);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && results[0]) { e.preventDefault(); choose(results[0]); }
    if (e.key === 'ArrowDown' && !list.hidden) { e.preventDefault(); list.querySelector('li')?.focus(); }
    if (e.key === 'Escape') { list.hidden = true; }
  });
  list.addEventListener('keydown', (e) => {
    const li = document.activeElement.closest('li');
    if (!li) return;
    if (e.key === 'Enter' && !document.activeElement.matches('.fav-btn, .hist-del')) {
      if (li.dataset.i !== undefined) choose(results[Number(li.dataset.i)]); else li.click();
    }
    if (e.key === 'ArrowDown') (li.nextElementSibling || li).focus();
    if (e.key === 'ArrowUp') (li.previousElementSibling || input).focus();
    if (e.key === 'Escape') { list.hidden = true; input.focus(); }
  });
  // The search button (and Enter) opens the best match; with no text it shows the history.
  document.getElementById('search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!input.value.trim()) { showHistory(); input.focus(); return; }
    results = search(input.value);
    if (results[0]) choose(results[0]);
  });
}

// ---------------------------------------------------------------- settings dialog
function openSettings() {
  const s = S.settings;
  const dlg = document.getElementById('dlg-settings');
  const body = dlg.querySelector('.dlg-body');
  const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${esc(typeof v === 'string' ? v : v.label)}</option>`).join('');
  const th = s.thresholds;
  // Cards in the colours of the point panel's groups; the open / closed state is remembered, the one-line summary shows the current choices.
  const pct = (v) => `${Math.round(v * 100)}%`;
  let open = { look: 1 };
  try { open = JSON.parse(localStorage.getItem('hikingwx.settingsCards.v1') || 'null') || open; } catch { /* use the default */ }
  const CARDS = [['look', 'obs', '◐', '外觀與閱讀', '外觀'], ['map', 'fc', '▦', '地圖與底圖', '地圖'], ['layer', 'water', '◫', '圖層顯示', '圖層'],
    ['safe', 'sun', '⚠', '安全評估門檻', '門檻'], ['data', 'info', '⛁', '資料與離線', '資料']];
  const grp = (t) => `<div class="sgrp">${t}</div>`;
  const card = ([id, g, icon, title], inner) => `<details class="pcard scard g-${g}" id="sc-${id}" data-scard="${id}"${open[id] ? ' open' : ''}><summary><span class="pc-ic" aria-hidden="true">${icon}</span><span class="pc-tx"><span class="pc-t">${title}</span><span class="pc-s" id="ss-${id}"></span></span><span class="pc-chev" aria-hidden="true">▾</span></summary><div class="pc-body">${inner}</div></details>`;
  const statusRows = Object.entries(S.manifest?.status || {});
  const nPass = statusRows.filter(([, v]) => v.ok).length;
  const thRow = (label, a, b, unit, le = false) => `<div class="thr"><b>${label}</b><label><span class="sr-only">${label}注意</span><input type="number" class="num" data-th="${a}" value="${th[a]}"></label><label><span class="sr-only">${label}危險</span><input type="number" class="num" data-th="${b}" value="${th[b]}"></label><span class="muted">${unit}</span></div>`;
  body.innerHTML = `
<nav class="pjump sjump" aria-label="設定分區">${CARDS.map(([id, g, icon, , short]) => `<button type="button" class="g-${g}" data-sjump="${id}">${s.ui === 'icon' ? `<span aria-hidden="true">${icon}</span> ` : ''}${short}</button>`).join('')}</nav>
${card(CARDS[0], `
${grp('主題與色盤')}
<label class="field">主題 <select id="set-theme">${opt({ auto: '跟隨系統', light: '淺色', dark: '深色', contrast: '高對比（黑底黃字）' }, s.theme)}</select></label>
<label class="field">色盤 <select id="set-pal">${opt(PALETTE_NAMES, s.palette)}</select></label>
${grp('文字')}
<label class="field">字體大小 <input type="range" id="set-fs" min="0.9" max="2" step="0.05" value="${s.fontScale}" aria-valuetext="${pct(s.fontScale)}"> <output id="set-fs-out">${pct(s.fontScale)}</output></label>
<label class="tog"><input type="checkbox" id="set-bold"${s.boldText ? ' checked' : ''}> 粗體文字</label>
${grp('動畫與版面')}
<label class="field">介面樣式 <select id="set-ui">${opt({ text: '文字版（文字標示，好讀）', icon: '圖示版（圖示選單，簡潔）' }, s.ui)}</select></label>
<label class="tog"><input type="checkbox" id="set-motion"${s.reduceMotion ? ' checked' : ''}> 減少動畫</label>
<label class="range">播放速度 <input id="set-speed" type="range" min="0.2" max="3" step="0.1" value="${s.playSpeed}" aria-describedby="set-speed-out"> <output id="set-speed-out">${Number(s.playSpeed).toFixed(1)} 秒／張</output></label>
`)}
${card(CARDS[1], `
${grp('底圖')}
<label class="field">底圖 <select id="set-base">${opt(BASEMAPS, s.basemap)}</select></label>
<p class="note" id="set-tf-note">「歷史：」底圖來自中央研究院人社中心（CC BY-NC，需標示出處，不可商業使用）。</p>
${grp('歷史地圖疊加')}
${HIST_OVER.map((h) => `<div class="hov"><label class="tog"><input type="checkbox" data-hov="${h.id}"${(s.histOverlays || {})[h.id] !== undefined ? ' checked' : ''}> ${esc(h.label)}</label>
<label class="field">透明度 <input type="range" min="0.2" max="1" step="0.1" data-hova="${h.id}" value="${(s.histOverlays || {})[h.id] ?? 0.8}" aria-label="${esc(h.label)} 不透明度"></label></div>`).join('')}
<details class="sub"><summary>進階：自訂圖磚網址、Thunderforest API key</summary><div class="in">
<label class="field">自訂圖磚網址 <input type="url" id="set-custom" value="${esc(s.customTile)}" placeholder="https://.../{z}/{x}/{y}.png"></label>
<label class="field">Thunderforest API key <input type="text" id="set-tfkey" value="${esc(s.tfKey)}" autocomplete="off" spellcheck="false" placeholder="${S.manifest?.config?.thunderforestKey ? '已使用本站提供的 key' : '選填'}"></label>
</div></details>
<button class="btn" id="set-dl">下載目前範圍底圖供離線使用</button> <output id="set-dl-out"></output>`)}
${card(CARDS[2], `
<label class="tog"><input type="checkbox" id="set-bar"${s.layerBar !== false ? ' checked' : ''}> 顯示底部圖層列</label>
<label class="tog"><input type="checkbox" id="set-smooth"${s.smooth !== false ? ' checked' : ''}> 圖層平滑顯示（關閉則顯示原始格點）</label>`)}
${card(CARDS[3], `
<div class="thr thh"><span></span><span>注意</span><span>危險</span><span></span></div>
${thRow('時雨量', 'rain1h', 'rain1hRed', 'mm ≥')}
${thRow('24 小時雨量', 'rain24', 'rain24Red', 'mm ≥')}
${thRow('陣風', 'gust', 'gustRed', 'm/s ≥')}
${thRow('體感溫度', 'cold', 'coldRed', '°C ≤')}`)}
${card(CARDS[4], `
<p>資料更新：${esc(fmtTime(S.manifest?.built))}</p>
<details class="sub"><summary>各項資料任務狀態<small>${nPass} 項 PASS${statusRows.length - nPass ? `・${statusRows.length - nPass} 項 FAIL` : ''}</small></summary><div class="in"><table class="kv"><tbody>${statusRows.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${v.ok ? '<span class="ok">PASS</span>' : `<span class="bad">FAIL</span> ${esc(v.error || '')}`}</td></tr>`).join('')}</tbody></table></div></details>
<div class="sbtns"><button class="btn" id="set-src">資料來源與授權</button>
<button class="btn" id="set-clear">清除最近查詢與收藏</button></div>`)}`;
  const summaries = () => {
    const themes = { auto: '自動主題', light: '淺色', dark: '深色', contrast: '高對比' };
    const nOver = Object.keys(s.histOverlays || {}).filter((k) => HIST_OVER.some((h) => h.id === k)).length;
    const lines = {
      look: `${themes[s.theme] || s.theme}・色盤「${(PALETTE_NAMES[s.palette] || s.palette).replace(/\s*[（(].*$/, '')}」・字體 ${pct(s.fontScale)}`,
      map: `底圖：${(BASEMAPS[s.basemap]?.label || s.basemap).replace(/\s*[（(].*$/, '')}${nOver ? `・疊加 ${nOver} 項` : ''}`,
      layer: `底部圖層列：${s.layerBar !== false ? '開' : '關'}・平滑顯示：${s.smooth !== false ? '開' : '關'}`,
      safe: `時雨量 ${s.thresholds.rain1h}/${s.thresholds.rain1hRed} mm・陣風 ${s.thresholds.gust}/${s.thresholds.gustRed} m/s`,
      data: `更新 ${fmtTime(S.manifest?.built)}・${nPass} 項 PASS${statusRows.length - nPass ? `・${statusRows.length - nPass} 項 FAIL` : ''}`,
    };
    Object.entries(lines).forEach(([k, v]) => { const el = body.querySelector(`#ss-${k}`); if (el) el.textContent = v; });
  };
  summaries();
  // Section jump bar: open and scroll to a card, highlight the one in view; the open / closed state is remembered.
  const scrollTo = (el) => body.scrollTo({ top: body.scrollTop + el.getBoundingClientRect().top - body.getBoundingClientRect().top - body.querySelector('.sjump').offsetHeight, behavior: s.reduceMotion ? 'auto' : 'smooth' });
  // Accordion: opening a card by hand folds the others (programmatic changes, e.g. the tests, are left alone).
  const closeOthers = (d) => body.querySelectorAll('details.scard').forEach((x) => { if (x !== d) x.open = false; });
  body.querySelectorAll('details.scard > summary').forEach((sm) => sm.addEventListener('click', () => {
    const d = sm.parentElement;
    if (d.open) return;   // it is being closed
    closeOthers(d);
    window.requestAnimationFrame(() => scrollTo(d));
  }));
  body.querySelectorAll('[data-sjump]').forEach((b) => b.addEventListener('click', () => {
    const d = body.querySelector(`#sc-${b.dataset.sjump}`);
    closeOthers(d);
    d.open = true;
    forced = b.dataset.sjump;   // the last cards cannot scroll up to the top: keep the clicked one highlighted until the user scrolls by hand
    markJump();
    scrollTo(d);
  }));
  body.querySelectorAll('details.scard').forEach((d) => d.addEventListener('toggle', () => {
    open[d.dataset.scard] = d.open ? 1 : 0;
    try { localStorage.setItem('hikingwx.settingsCards.v1', JSON.stringify(open)); } catch { /* storage blocked */ }
  }));
  let forced = null;
  const markJump = () => {
    const top = body.getBoundingClientRect().top + 90;
    let cur = 'look';
    body.querySelectorAll('details.scard').forEach((d) => { if (d.getBoundingClientRect().top <= top) cur = d.dataset.scard; });
    if (forced) cur = forced;
    body.querySelectorAll('[data-sjump]').forEach((b) => { b.classList.toggle('on', b.dataset.sjump === cur); if (b.dataset.sjump === cur) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
  };
  body.onscroll = markJump;
  ['wheel', 'touchstart', 'keydown'].forEach((ev) => body.addEventListener(ev, () => { forced = null; }, { passive: true }));
  markJump();
  const save = () => { saveSettings(s); applySettings(s); summaries(); };
  body.querySelector('#set-fs').addEventListener('input', (e) => {
    s.fontScale = Number(e.target.value);
    body.querySelector('#set-fs-out').textContent = pct(s.fontScale);
    e.target.setAttribute('aria-valuetext', pct(s.fontScale));
    save();
    updateLabels();
  });
  body.querySelector('#set-ui').addEventListener('change', (e) => { s.ui = e.target.value; save(); buildUiOptions(); });
  body.querySelector('#set-theme').addEventListener('change', (e) => { s.theme = e.target.value; save(); });
  body.querySelector('#set-pal').addEventListener('change', (e) => { s.palette = e.target.value; save(); showLayer(S.layer.id, { keepFrame: true }); });
  body.querySelector('#set-bar').addEventListener('change', (e) => { setLayerBar(e.target.checked); summaries(); });
  body.querySelector('#set-smooth').addEventListener('change', (e) => { s.smooth = e.target.checked; save(); showLayer(S.layer.id, { keepFrame: true }); });
  body.querySelector('#set-bold').addEventListener('change', (e) => { s.boldText = e.target.checked; save(); });
  body.querySelector('#set-speed').addEventListener('input', (e) => { s.playSpeed = Number(e.target.value); body.querySelector('#set-speed-out').textContent = `${s.playSpeed.toFixed(1)} 秒／張`; save(); restartAnimation(); });
  body.querySelector('#set-motion').addEventListener('change', (e) => { s.reduceMotion = e.target.checked; save(); if (s.reduceMotion) stopAnimation(); });
  body.querySelector('#set-base').addEventListener('change', (e) => { s.basemap = e.target.value; try { localStorage.removeItem(TF_OVER_KEY); } catch { /* ignore */ } save(); setBasemap(); });
  const histChange = () => {
    s.histOverlays = {};
    body.querySelectorAll('[data-hov]').forEach((c) => { if (c.checked) s.histOverlays[c.dataset.hov] = Number(body.querySelector(`[data-hova="${c.dataset.hov}"]`).value); });
    save(); setHistOverlays();
  };
  body.querySelectorAll('[data-hov]').forEach((c) => c.addEventListener('change', histChange));
  body.querySelectorAll('[data-hova]').forEach((c) => c.addEventListener('input', histChange));
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
  const reset = dlg.querySelector('#set-reset');
  reset.onclick = () => {
    Object.assign(s, JSON.parse(JSON.stringify(DEFAULTS)));
    save(); setBasemap(); showLayer(s.layer); dlg.close();
    $('#lbl-size').value = String(s.labelScale);
    $('#lbl-size-out').textContent = `${Math.round(s.labelScale * 100)}%`;
    buildUiOptions();
    setLayerBar(s.layerBar);
    buildOverlayToggles();
    applyOverlayVisibility();
  };
  dlg.showModal();
}

async function downloadTiles(out) {
  if (!baseLayer) return;
  if ((BASEMAPS[S.settings.basemap] || {}).noBulk) {
    out.textContent = 'Thunderforest 與歷史地圖底圖不提供批次下載（避免大量請求）；瀏覽過的圖磚仍會快取供離線使用。';
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
    } else if (!full && !matchMedia('(max-height: 500px) and (orientation: landscape)').matches) {
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
  S.lightning = await getJSON('lightning.json', { optional: true });
  // [name, lat, lon, ele, osm id, area ('新竹縣關西鎮'), list tags, est]; est = 1: elevation estimated from a terrain model.
  S.peakLists = Object.fromEntries((peaks?.lists || []).map((l) => [l.id, l.label]));
  S.peaks = (peaks?.peaks || []).map(([n, lat, lon, ele, osm, area, tags, est]) => ({ k: `osm-${osm}`, n, lat, lon, ele, est: Boolean(est), area: area || '', tags: tags || [] }));
  S.stations = st?.stations || [];
  S.stationsTime = st?.time;
  // Mountain forecast points snapped to their OSM summit by the pipeline (CWA coordinates can be km off).
  S.spots = (spots?.spots || []).map((p) => (p.plat ? { ...p, cwaLat: p.lat, cwaLon: p.lon, lat: p.plat, lon: p.plon } : p));
  // A peak that is a forecast mountain is shown only once, as the forecast mountain.
  const normName = (n) => n.replace(/(主峰|主山)$/, '');
  const mtns = S.spots.filter((p) => p.c === 'mountain');
  S.peaks = S.peaks.filter((pk) => {
    const m = mtns.find((x) => normName(x.n) === normName(pk.n) && Math.abs(x.lat - pk.lat) < 0.05 && Math.abs(x.lon - pk.lon) < 0.05);
    if (m && m.ele == null && pk.ele) { m.ele = pk.ele; m.est = pk.est; }   // the forecast mountain takes the elevation of the OSM peak it replaces
    return !m;
  });
  S.spotCats = spots?.categories || [];
  S.quakes = quakes?.quakes || [];
  S.typhoon = typhoon;
  S.warnings = warnings;
  S.sat = sat || [];
  S.towns = topojson.feature(topo, topo.objects.towns).features.map((f) => ({ ...f, bbox: bbox(f.geometry) }));
  S.counties = topojson.feature(topo, topo.objects.counties).features;
}

async function main() {
  paintIcons();
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
  S.scale = L.control.scale({ imperial: false }).addTo(S.map);
  setBasemap();
  // Layer name and data time, top centre of the map (filled by renderLegend).
  const banner = document.createElement('div');
  banner.id = 'map-banner';
  banner.className = 'map-banner';
  banner.hidden = true;
  banner.setAttribute('role', 'status');
  S.map.getContainer().appendChild(banner);
  initMapOptions();
  // A map tap first closes the options panel instead of opening a point.
  S.map.on('click', (e) => {
    if ($('#more').classList.contains('open')) { setOptsOpen(false); return; }
    showPoint(e.latlng.lat, e.latlng.lng);
  });
  S.map.on('zoomend', applyOverlayVisibility);
  S.map.on('moveend', () => { updatePeaks(); updateLabels(); });
  S.map.on('zoomend', layoutTyLabels);
  S.map.on('moveend', () => { if (S.layer.id === 'wind' && S.layer.windMode === 'aloft') showLayer('wind', { keepFrame: true }); });
  S.map.on('zoomend', () => { if (S.layer.id === 'wind' && (S.layer.windMode || 'fc') === 'fc') showLayer('wind', { keepFrame: true }); if (S.layer.id === 'visib' && S.layer.visMode === 'fc') showLayer('visib', { keepFrame: true }); });
  document.addEventListener('quakemode', (e) => {
    applyOverlayVisibility();
    setWeatherVisible(!e.detail);
    document.getElementById('legend').classList.toggle('quake-hide', e.detail);
    document.getElementById('map-banner').classList.toggle('quake-hide', e.detail);
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
    $('#sheet-toggle').firstElementChild.innerHTML = ico(full ? 'shrink' : 'expand');
    $('#sheet-toggle').setAttribute('aria-label', full ? '還原面板大小' : '放大面板');
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
      showMyLocation(p.coords);
      flyTo(p.coords.latitude, p.coords.longitude, 12);
      showPoint(p.coords.latitude, p.coords.longitude, { label: '我的位置' });
    }, () => alert('無法取得目前位置'), { enableHighAccuracy: true, timeout: 15000 });
  });
  const op = $('#opacity');
  op.value = String(S.settings.opacity);
  op.addEventListener('input', () => { setOpacity(Number(op.value)); op.setAttribute('aria-valuetext', `${Math.round(op.value * 100)}%`); });
  op.addEventListener('change', () => saveSettings(S.settings));
  $('#dlg-settings').addEventListener('close', () => updateStatus());
  // Clicking the backdrop (outside the dialog box) closes the settings.
  $('#dlg-settings').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  window.addEventListener('resize', placeLegend);
  S.map.on('resize', placeLegend);
  // Banners and the layer bar change the map's height without a window resize: keep Leaflet's size in step
  // (invalidateSize keeps the centre, so Taiwan stays in the middle).
  new ResizeObserver(() => { S.map.invalidateSize({ animate: false }); placeLegend(); }).observe($('#map'));
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

/** While a typhoon warning is in force, the typhoon layer is shown on start-up; Taiwan stays centred and the map
 * zooms out by at most one level to bring the typhoon's current position into view. */
function showTyphoonByDefault() {
  const ty = S.typhoon?.active ? S.typhoon : null;
  if (!ty) return;
  S.settings.overlays.typhoon = true;
  const cur = ty.cyclones.map((c) => c.past[c.past.length - 1]).filter(Boolean);
  if (!cur.length) return;
  const centre = S.map.getCenter();
  for (let z = S.map.getZoom(); z >= 7; z -= 1) {
    S.map.setView(centre, z, { animate: false });
    if (cur.every((p) => S.map.getBounds().pad(-0.08).contains([p.lat, p.lon]))) return;
  }
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
