// Entry point: map setup, data loading, overlays, controls and settings.
import { S } from './state.js';
import { loadSettings, saveSettings, applySettings, DEFAULTS } from './settings.js';
import { getJSON, setDataVersion, fmtTime, ageText, esc, bbox, $ } from './util.js';
import { LAYERS, showLayer, setOpacity, stopAnimation } from './layers.js';
import { PALETTE_NAMES } from './palettes.js';
import {
  showPoint, closeSheet, sheetBack, showAlerts, showRecent, showAffected, showQuake, showTyphoon, search, flyTo,
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
  custom: { label: '自訂圖磚網址', url: '', max: 19, attr: '自訂底圖' },
};

let baseLayer = null;

function setBasemap() {
  const s = S.settings;
  const def = BASEMAPS[s.basemap] || BASEMAPS.topo;
  const url = s.basemap === 'custom' ? s.customTile : def.url;
  if (baseLayer) S.map.removeLayer(baseLayer);
  if (!url) return;
  baseLayer = L.tileLayer(url, { maxZoom: def.max, maxNativeZoom: def.max, subdomains: def.sub || 'abc', attribution: def.attr, crossOrigin: true });
  baseLayer.addTo(S.map);
}

// ---------------------------------------------------------------- overlays
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
    const icon = L.divIcon({ className: mountain ? 'pin-mtn' : 'pin-spot', html: mountain ? '▲' : '◆', iconSize: [18, 18] });
    const m = L.marker([p.lat, p.lon], { icon, title: p.n, keyboard: true, alt: p.n, pane: 'spots' });
    m.bindTooltip(esc(p.n), { direction: 'top', offset: [0, -8] });
    m.on('click', () => showPoint(p.lat, p.lon, { spotKey: p.k }));
    (mountain ? o.mountains : o.spots).addLayer(m);
  });

  o.quakes = L.layerGroup();
  S.quakes.filter((q) => Date.now() - new Date(q.time).getTime() < 7 * 864e5).forEach((q) => {
    const m = L.circleMarker([q.lat, q.lon], { radius: 4 + q.mag * 2, color: '#b00020', weight: 2, fillColor: '#ff5a5f', fillOpacity: 0.35, pane: 'spots' });
    m.bindTooltip(`地震 M${q.mag}<br>${esc(fmtTime(q.time))}・最大震度 ${q.maxInt}`);
    m.on('click', (e) => { L.DomEvent.stop(e); showQuake(q); });
    o.quakes.addLayer(m);
  });

  o.typhoon = L.layerGroup();
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
      c.fcst.forEach((f) => {
        if (f.r70) L.circle([f.lat, f.lon], { radius: f.r70 * 1000, color: '#d00', weight: 1, dashArray: '3 4', fill: false, interactive: false }).addTo(o.typhoon);
        L.circleMarker([f.lat, f.lon], { radius: 4, color: '#d00', fillColor: '#fff', fillOpacity: 1 })
          .bindTooltip(`+${f.h}h ${f.ws ?? ''}m/s`).addTo(o.typhoon);
      });
    });
  }
  applyOverlayVisibility();
}

function applyOverlayVisibility() {
  const show = S.settings.overlays;
  Object.entries(S.overlays).forEach(([k, g]) => {
    const on = show[k] && (k !== 'stations' || S.map.getZoom() >= 9) && (k !== 'spots' || S.map.getZoom() >= 9);
    if (on && !S.map.hasLayer(g)) g.addTo(S.map);
    if (!on && S.map.hasLayer(g)) S.map.removeLayer(g);
  });
  document.getElementById('map').dataset.zoom = String(S.map.getZoom());
}

// ---------------------------------------------------------------- controls
function buildChips() {
  const box = document.getElementById('chips');
  const tyTables = S.typhoon?.tables || {};
  const items = LAYERS.filter((l) => !l.typhoonOnly || (S.typhoon?.active && (tyTables.rain24 || tyTables.rainTotal)));
  box.innerHTML = items.map((l) => `<button class="chip" role="radio" data-layer="${l.id}" aria-checked="${l.id === S.settings.layer}">${esc(l.label)}</button>`).join('');
  box.querySelectorAll('[data-layer]').forEach((b) => b.addEventListener('click', () => {
    S.settings.layer = b.dataset.layer;
    saveSettings(S.settings);
    showLayer(b.dataset.layer);
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
  const items = [['stations', '測站'], ['mountains', '山岳'], ['spots', '景點'], ['quakes', '地震'], ['typhoon', '颱風']];
  const box = document.getElementById('toggles');
  box.innerHTML = items.map(([k, label]) => `<label class="tog"><input type="checkbox" data-ov="${k}"${S.settings.overlays[k] ? ' checked' : ''}> ${label}</label>`).join('');
  box.querySelectorAll('[data-ov]').forEach((c) => c.addEventListener('change', () => {
    S.settings.overlays[c.dataset.ov] = c.checked;
    saveSettings(S.settings);
    applyOverlayVisibility();
  }));
}

function updateStatus() {
  const el = document.getElementById('status');
  const built = S.manifest?.built;
  const off = !navigator.onLine;
  const failed = Object.entries(S.manifest?.status || {}).filter(([, v]) => !v.ok).map(([k]) => k);
  el.innerHTML = `${off ? '<span class="offline">離線模式・顯示已快取資料</span> ' : ''}資料更新：${esc(fmtTime(built))}（${esc(ageText(built))}）${failed.length ? `・<span class="warn-txt">部分資料暫缺：${esc(failed.join(', '))}</span>` : ''}`;
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
    showPoint(r.lat, r.lon, { spotKey: r.spot, stationId: r.station, label: r.type === '鄉鎮' ? r.label : undefined });
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
<fieldset><legend>閱讀與顯示</legend>
<label class="field">字體大小 <input type="range" id="set-fs" min="0.9" max="2" step="0.1" value="${s.fontScale}" aria-valuetext="${Math.round(s.fontScale * 100)}%"> <output id="set-fs-out">${Math.round(s.fontScale * 100)}%</output></label>
<label class="field">主題 <select id="set-theme">${opt({ auto: '跟隨系統', light: '淺色', dark: '深色', contrast: '高對比（黑底黃字）' }, s.theme)}</select></label>
<label class="field">色盤 <select id="set-pal">${opt(PALETTE_NAMES, s.palette)}</select></label>
<p class="note">「色弱友善」使用明度遞增的色階，紅綠色弱或藍黃色弱皆可分辨；「高對比」適合強光下或低視力。</p>
<label class="tog"><input type="checkbox" id="set-bold"${s.boldText ? ' checked' : ''}> 粗體文字</label>
<label class="tog"><input type="checkbox" id="set-motion"${s.reduceMotion ? ' checked' : ''}> 減少動畫</label>
</fieldset>
<fieldset><legend>底圖</legend>
<label class="field">底圖 <select id="set-base">${opt(BASEMAPS, s.basemap)}</select></label>
<label class="field">自訂圖磚網址 <input type="url" id="set-custom" value="${esc(s.customTile)}" placeholder="https://.../{z}/{x}/{y}.png"></label>
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
<button class="btn" id="set-clear">清除最近查詢與收藏</button>
<button class="btn" id="set-reset">恢復預設設定</button>
</fieldset>`;
  const save = () => { saveSettings(s); applySettings(s); };
  body.querySelector('#set-fs').addEventListener('input', (e) => {
    s.fontScale = Number(e.target.value);
    body.querySelector('#set-fs-out').textContent = `${Math.round(s.fontScale * 100)}%`;
    e.target.setAttribute('aria-valuetext', `${Math.round(s.fontScale * 100)}%`);
    save();
  });
  body.querySelector('#set-theme').addEventListener('change', (e) => { s.theme = e.target.value; save(); });
  body.querySelector('#set-pal').addEventListener('change', (e) => { s.palette = e.target.value; save(); showLayer(S.layer.id, { keepFrame: true }); });
  body.querySelector('#set-bold').addEventListener('change', (e) => { s.boldText = e.target.checked; save(); });
  body.querySelector('#set-motion').addEventListener('change', (e) => { s.reduceMotion = e.target.checked; save(); if (s.reduceMotion) stopAnimation(); });
  body.querySelector('#set-base').addEventListener('change', (e) => { s.basemap = e.target.value; save(); setBasemap(); });
  body.querySelector('#set-custom').addEventListener('change', (e) => {
    const v = e.target.value.trim();
    if (v && !/^https:\/\/.+\{z\}.+\{x\}.+\{y\}|^https:\/\/.+\{z\}.+\{y\}.+\{x\}/.test(v)) { e.target.setCustomValidity('網址需為 https 並包含 {z} {x} {y}'); e.target.reportValidity(); return; }
    e.target.setCustomValidity('');
    s.customTile = v; save(); if (s.basemap === 'custom') setBasemap();
  });
  body.querySelectorAll('[data-th]').forEach((i) => i.addEventListener('change', () => { s.thresholds[i.dataset.th] = Number(i.value); save(); }));
  body.querySelector('#set-dl').addEventListener('click', () => downloadTiles(body.querySelector('#set-dl-out')));
  body.querySelector('#set-clear').addEventListener('click', async (e) => { await clearAll(); e.target.textContent = '已清除'; });
  body.querySelector('#set-reset').addEventListener('click', () => {
    Object.assign(s, JSON.parse(JSON.stringify(DEFAULTS)));
    save(); setBasemap(); showLayer(s.layer); dlg.close();
  });
  dlg.showModal();
}

async function downloadTiles(out) {
  if (!baseLayer) return;
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
  S.map.createPane('stations').style.zIndex = 610;
  S.map.createPane('spots').style.zIndex = 620;
  S.map.attributionControl.setPrefix('<a href="https://leafletjs.com">Leaflet</a>');
  L.control.scale({ imperial: false }).addTo(S.map);
  setBasemap();
  S.map.on('click', (e) => showPoint(e.latlng.lat, e.latlng.lng));
  S.map.on('zoomend', applyOverlayVisibility);

  $('#sheet-close').addEventListener('click', closeSheet);
  $('#sheet-back').addEventListener('click', sheetBack);
  $('#sheet-toggle').addEventListener('click', () => {
    const sh = $('#sheet');
    const full = sh.classList.toggle('full');
    document.body.classList.toggle('sheet-full', full);
    $('#sheet-toggle').setAttribute('aria-expanded', String(full));
    setTimeout(() => S.map.invalidateSize(), 50);
  });
  $('#btn-more').addEventListener('click', () => {
    const open = $('#more').classList.toggle('open');
    $('#btn-more').setAttribute('aria-expanded', String(open));
  });
  // Keep the map sized correctly when the side panel opens/closes on wide screens.
  new MutationObserver(() => S.map.invalidateSize()).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.querySelector('dialog[open]') && !$('#sheet').hidden) closeSheet();
  });
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-alerts').addEventListener('click', showAlerts);
  $('#btn-recent').addEventListener('click', showRecent);
  $('#btn-affected').addEventListener('click', showAffected);
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
  window.addEventListener('online', updateStatus);
  window.addEventListener('offline', updateStatus);

  try {
    await loadData();
  } catch (e) {
    console.error(e);
    $('#status').innerHTML = '<span class="warn-txt">無法載入資料。若為首次開啟請連上網路；之後即可離線使用已快取的資料。</span>';
    return;
  }
  buildChips();
  buildOverlayToggles();
  bindSearch();
  buildOverlays();
  updateStatus();
  showLayer(S.settings.layer);
  document.body.classList.add('ready');
}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e)));
}

main();
