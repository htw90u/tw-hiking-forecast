// User preferences (accessibility, map, thresholds) persisted in localStorage.
const KEY = 'hikingwx.settings.v1';

export const DEFAULTS = {
  fontScale: 1,          // 1 = 100 %, up to 2 = 200 %
  labelScale: 1.25,      // map name labels relative to the map text size
  theme: 'auto',         // auto | light | dark | contrast
  palette: 'cwa',        // cwa | cvd (color-vision-deficiency safe) | contrast
  basemap: 'topo',       // topo | emap | photo | osm | custom
  customTile: '',
  tfKey: '',             // personal Thunderforest API key (OpenCycleMap); overrides the site key
  reduceMotion: false,
  smooth: true,          // interpolate grid layers (false = raw cells)
  boldText: false,
  ui: 'text',            // text (readable labels) | icon (icon tiles and tab bar)
  layer: 'radar',
  opacity: 0.7,
  overlays: { stations: true, mountains: true, peaks: true, spots: false, quakes: true, typhoon: true },
  labels: { mountains: false, peaks: false, spots: false, stations: false }, // names drawn on the map
  thresholds: { rain1h: 10, rain1hRed: 30, rain24: 80, rain24Red: 200, gust: 10, gustRed: 17, cold: 5, coldRed: 0 },
};

function clone(o) { return JSON.parse(JSON.stringify(o)); }

export function loadSettings() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { saved = {}; }
  const s = { ...clone(DEFAULTS), ...saved };
  s.overlays = { ...DEFAULTS.overlays, ...(saved.overlays || {}) };
  s.labels = { ...DEFAULTS.labels, ...(saved.labels || {}) };
  s.thresholds = { ...DEFAULTS.thresholds, ...(saved.thresholds || {}) };
  if (s.layer === 'rainday') s.layer = 'rainacc'; // renamed layer
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
