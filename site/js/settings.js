// User preferences (accessibility, map, thresholds) persisted in localStorage.
const KEY = 'hikingwx.settings.v1';

export const DEFAULTS = {
  fontScale: 1,          // 1 = 100 %, up to 2 = 200 %
  labelScale: 1.25,      // map name labels relative to the map text size
  rainSpacing: 'small',  // accumulated rain colour classes: small (小間距) | big (大間距); chosen by the user only
  layerBar: true,        // bottom layer bar shown (false = collapsed for a larger map)
  theme: 'auto',         // auto | light | dark | contrast
  palette: 'cwa',        // cwa | cvd (color-vision-deficiency safe) | contrast
  basemap: 'outdoors',   // outdoors | landscape | cycle | topo | emap | photo | osm | custom (Thunderforest maps fall back to emap)
  basemapVer: 2,         // bumped when the default basemap changes: everyone gets the new default once
  customTile: '',
  tfKey: '',             // personal Thunderforest API key (OpenCycleMap); overrides the site key
  showRainGauges: true,  // rain-only stations in the nearby-station list
  reduceMotion: false,
  smooth: true,          // interpolate grid layers (false = raw cells)
  boldText: false,
  ui: 'text',            // text (readable labels) | icon (icon tiles and tab bar)
  layer: 'radar',
  opacity: 0.7,
  satOpacity: 1,         // satellite picture opacity (own value: see layers.js layerOpacity)
  overlays: { stations: true, mountains: true, peaks: true, spots: false, quakes: true, typhoon: true },
  labels: { mountains: true, peaks: true, spots: true, stations: false }, // names drawn on the map
  labelsVer: 2,          // bumped when the label defaults change
  thresholds: { rain1h: 10, rain1hRed: 30, rain24: 80, rain24Red: 200, gust: 10, gustRed: 17, cold: 5, coldRed: 0 },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  const s = { ...clone(DEFAULTS), ...saved };
  s.overlays = { ...DEFAULTS.overlays, ...(saved.overlays || {}) };
  // Older saves had every label off by default: take the new defaults once.
  s.labels = saved.labelsVer === DEFAULTS.labelsVer ? { ...DEFAULTS.labels, ...(saved.labels || {}) } : { ...DEFAULTS.labels };
  s.labelsVer = DEFAULTS.labelsVer;
  if (saved.basemapVer !== DEFAULTS.basemapVer) s.basemap = DEFAULTS.basemap;   // new default basemap (taken once)
  s.basemapVer = DEFAULTS.basemapVer;
  s.thresholds = { ...DEFAULTS.thresholds, ...(saved.thresholds || {}) };
  if (s.layer === 'rainday') s.layer = 'rainacc'; // renamed layer
  if (s.rainSpacing !== 'big') s.rainSpacing = 'small'; // the former 'auto' switched scales by itself
  if (s.layer === 'none') s.layer = 'radar'; // the 關閉圖層 chip was removed (tap the active chip instead)
  if (!s.reduceMotion && saved.reduceMotion === undefined) {
    try { s.reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* ignore */ }
  }
  return s;
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}

export function applySettings(s) {
  const root = document.documentElement;
  const scale = Math.min(2, Math.max(0.85, Number(s.fontScale) || 1));
  root.style.setProperty('--fs', String(scale));
  root.style.setProperty('--lbl', String(Math.min(2, Math.max(0.8, Number(s.labelScale) || DEFAULTS.labelScale))));
  let theme = s.theme;
  if (theme === 'auto') {
    let dark = false;
    try { dark = matchMedia('(prefers-color-scheme: dark)').matches; } catch { /* ignore */ }
    theme = dark ? 'dark' : 'light';
  }
  root.dataset.theme = theme;
  root.dataset.motion = s.reduceMotion ? 'reduce' : 'full';
  root.dataset.bold = s.boldText ? 'on' : 'off';
  root.dataset.ui = s.ui === 'icon' ? 'icon' : 'text';
  // Icon UI: the action buttons live in the tab bar instead of the top bar.
  const nav = document.querySelector('.actions-top');
  const dest = s.ui === 'icon' ? document.getElementById('tabbar') : document.querySelector('.topbar');
  if (nav && dest && nav.parentElement !== dest) dest.appendChild(nav);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#1d4e5f' : '#000000';
}
