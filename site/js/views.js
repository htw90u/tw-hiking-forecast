// Bottom-sheet / side-panel views.
import { S } from './state.js';
import {
  getJSON, fmtTime, fmtNum, ageText, nearest, haversineKm, windDir, html, raw, esc, polygonContains, normCounty, intText, isStrongQuake,
  beaufort, apparentTemp, eleText,
} from './util.js';
import { getGrid, framesFor, layerDef, showLayer, PERIOD_LAYERS, layerKind, attribution, OGDL_TEXT, OGDL_URL, lightningNear, loadWind, WIND_DIRS } from './layers.js';
import { sample, classRange, renderGrid } from './grid.js';
import { scaleFor, colourFn } from './palettes.js';
import { chart, dataTable } from './chart.js';
import { assess, LEVELS } from './safety.js';
import { loadAloft, aloftCard, sunCard, levelAlt as levelAltOf, compass as compassName } from './aloft.js';
import { sunTimes, twDate } from './sun.js';
import { ensembleCard, bindEnsemble } from './ensemble.js';
import { loadHydro, hydroCard, townAlerts } from './hydro.js';
import { cardize, bindCards, GROUPS } from './cards.js';
import { saveRecent, listRecent, getRecent, toggleFav, listFav, pointId, clearRecent, deleteRecent, deleteFav } from './store.js';

// ------------------------------------------------------------------ sheet
const stack = [];

export function openSheet(title, body, { replace = false, onRender, peek = false, quake = false, fav = null, sub = '' } = {}) {
  const sheet = document.getElementById('sheet');
  const entry = { title, body, onRender, fav, sub };
  if (quake) clearPick();
  // peek: a low sheet so the map above stays visible (earthquake view).
  sheet.classList.toggle('peek', peek);
  setSheetMini(false, { refit: false });
  S.focusBounds = null;
  if (peek) { sheet.classList.remove('full'); document.body.classList.remove('sheet-full'); }
  setQuakeMode(quake);
  if (replace && stack.length) stack[stack.length - 1] = entry; else stack.push(entry);
  renderTop();
  sheet.hidden = false;
  sheet.classList.add('open');
  document.body.classList.add('sheet-open');
  if (!replace) sheet.focus({ preventScroll: true });
}

function renderTop() {
  const e = stack[stack.length - 1];
  if (!e) return;
  document.getElementById('sheet-title').textContent = e.title;
  const sub = document.getElementById('sheet-sub');
  sub.textContent = e.sub || '';
  sub.hidden = !e.sub;
  const body = document.getElementById('sheet-body');
  body.innerHTML = typeof e.body === 'string' ? e.body : e.body.html;
  body.scrollTop = 0;
  document.getElementById('sheet-back').hidden = stack.length < 2;
  document.getElementById('sheet').classList.toggle('pt', Boolean(e.fav));   // a point panel carries its own favourite button
  setSheetFav(e.fav);
  if (e.onRender) e.onRender(body);
}

// ------------------------------------------------------------------ favourite star + selected-point highlight
/** The star in the sheet header: adds / removes the current point from the favourites. */
function setSheetFav(fav) {
  const b = document.getElementById('sheet-fav');
  b.hidden = !fav;
  b.onclick = null;
  if (!fav) return;
  const paint = (on) => {
    b.firstElementChild.textContent = on ? '★' : '☆';
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-label', on ? `取消收藏：${fav.title}` : `加入收藏：${fav.title}`);
    b.title = on ? '取消收藏' : '加入收藏';
    document.querySelectorAll('#btn-fav').forEach((x) => { x.textContent = on ? '★ 已收藏' : '☆ 收藏'; x.setAttribute('aria-pressed', String(on)); });
  };
  paint(false);
  listFav().then((f) => paint(f.some((x) => x.id === fav.id)));
  b.onclick = async () => paint(await toggleFav(fav));
}

/** Highlight the selected point on the map (ring + dot) until the sheet is closed. */
function showPick(lat, lon) {
  clearPick();
  S.pick = L.marker([lat, lon], {
    icon: L.divIcon({ className: 'pick-mk', html: '<span class="ring"></span><span class="dot"></span>', iconSize: [44, 44] }),
    interactive: false, keyboard: false, pane: 'alerts', zIndexOffset: 3000,
  }).addTo(S.map);
  // flyTo (search results) is still moving at this point: check again when it has settled.
  revealPoint(lat, lon);
  setTimeout(() => revealPoint(lat, lon), S.settings.reduceMotion ? 50 : 1000);
}

/** Pan the map so that a point hidden behind the open panel comes into the visible part of the map. */
function revealPoint(lat, lon) {
  const sheet = document.getElementById('sheet');
  if (sheet.hidden || !S.pick) return;
  const r = sheet.getBoundingClientRect();
  const m = S.map.getContainer().getBoundingClientRect();
  const side = r.left > m.left + 10; // side-panel layout
  const w = side ? r.left - m.left : m.width;
  const h = side ? m.height : r.top - m.top;
  const p = S.map.latLngToContainerPoint([lat, lon]);
  if (p.x > 40 && p.x < w - 40 && p.y > 70 && p.y < h - 30) return;
  S.map.panBy([p.x - w / 2, p.y - h / 2 - 20], { animate: !S.settings.reduceMotion });
}

function clearPick() {
  if (S.pick) { S.map.removeLayer(S.pick); S.pick = null; }
}

export function sheetBack() {
  if (stack.length > 1) { stack.pop(); renderTop(); } else closeSheet();
}

function setQuakeMode(on) {
  if (S.quakeMode === on) return;
  S.quakeMode = on;
  document.dispatchEvent(new CustomEvent('quakemode', { detail: on }));
}

/** Fit bounds into the part of the map not covered by the sheet. */
function fitVisible(bounds) {
  const sheet = document.getElementById('sheet');
  const r = sheet.getBoundingClientRect();
  const m = S.map.getContainer().getBoundingClientRect();
  const side = r.left > m.left + 10; // side panel layout
  let tl = [10, 10];
  let br = side ? [Math.max(0, m.right - r.left) + 10, 10] : [10, Math.max(0, m.bottom - r.top) + 10];
  if (sheet.classList.contains('mini') && side && r.top > m.top + 10) {
    // Minimised header parked at the bottom-right (phone landscape): nothing to avoid on the map.
    br = [10, 10];
  } else if (sheet.classList.contains('mini') && side) {
    // Minimised side panel is only a header box in the top-right corner.
    tl = [10, Math.max(10, r.bottom - m.top + 10)];
    br = [10, 10];
  }
  S.map.fitBounds(bounds, { paddingTopLeft: tl, paddingBottomRight: br, animate: !S.settings.reduceMotion });
}

/**
 * Minimise the sheet to its header bar. The map highlights (earthquake rings,
 * intensity markers, shakemap, focus point) stay on the map.
 */
export function setSheetMini(on, { refit = true } = {}) {
  const sheet = document.getElementById('sheet');
  sheet.classList.toggle('mini', on);
  document.body.classList.toggle('sheet-mini', on);
  if (on) { sheet.classList.remove('full'); document.body.classList.remove('sheet-full'); }
  const b = document.getElementById('sheet-min');
  if (b) {
    b.setAttribute('aria-expanded', String(!on));
    b.setAttribute('aria-label', on ? '展開面板' : '縮小面板（保留地圖上的標示）');
    b.firstElementChild.textContent = on ? '▴' : '▾';
  }
  if (refit && S.focusBounds) setTimeout(() => { S.map.invalidateSize(); fitVisible(S.focusBounds); }, 60);
}

export function closeSheet() {
  setSheetMini(false, { refit: false });
  S.focusBounds = null;
  setQuakeMode(false);
  stack.length = 0;
  clearPick();
  setSheetFav(null);
  const sheet = document.getElementById('sheet');
  sheet.classList.remove('open');
  sheet.hidden = true;
  document.body.classList.remove('sheet-open');
  if (S.focus) S.focus.clearLayers();
}

const loading = html`<p class="loading" role="status">載入中…</p>`;

// ------------------------------------------------------------------ helpers
function findTown(lat, lon) {
  for (const f of S.towns) {
    const [w, s, e, n] = f.bbox;
    if (lon < w || lon > e || lat < s || lat > n) continue;
    if (polygonContains(f.geometry, lon, lat)) return f.properties;
  }
  return null;
}

function el(fc, name) { return fc && fc[name]; }

function valueAt(e, key, t) {
  if (!e) return null;
  const i = e.t.indexOf(t);
  return i < 0 ? null : e.v[key]?.[i] ?? null;
}

function lvBadge(level) {
  const L_ = LEVELS[level];
  return html`<span class="lv ${L_.cls}"><span aria-hidden="true">${L_.icon}</span> ${L_.label}</span>`;
}

function stationLine(s, d) {
  const parts = [];
  if (s.T !== undefined) parts.push(`${fmtNum(s.T)}°C`);
  if (s.WS !== undefined) parts.push(`風 ${windDir(s.WD)} ${fmtNum(s.WS)}`);
  if (s.G !== undefined) parts.push(`陣風 ${fmtNum(s.G)}`);
  if (s.R1h !== undefined) parts.push(`時雨量 ${fmtNum(s.R1h)}`);
  if (s.R24h !== undefined) parts.push(`24h ${fmtNum(s.R24h)}`);
  return html`<li><button class="link" data-station="${s.id}">${s.n}</button>
<span class="meta">${d.toFixed(1)} km・${s.alt !== undefined ? `${Math.round(s.alt)} m` : '海拔不明'}${s.k === 'rain' ? '・雨量站' : ''}</span>
<span class="vals">${parts.join('｜') || '—'}</span></li>`;
}

const STATION_KIND = { manned: '氣象站（署屬有人站）', auto: '自動氣象站', rain: '自動雨量站' };

/** Full current observation of one station (station-first point view), as compact value tiles. */
function stationCard(st) {
  const tile = (label, value) => `<div class="tile"><span class="tl">${label}</span><span class="tv">${esc(value)}</span></div>`;
  const num = (label, v, unit, digits = 1) => (v === undefined || v === null ? '' : tile(label, fmtNum(v, digits, unit)));
  const obs = [
    st.Wx ? tile('天氣', st.Wx) : '',
    num('溫度', st.T, '°C'), num('相對濕度', st.RH, '%', 0),
    st.WS === undefined ? '' : tile('風向風速', `${windDir(st.WD)} ${fmtNum(st.WS, 1, 'm/s')}`),
    num('最大陣風', st.G, 'm/s'),
    apparentTemp(st.T, st.RH, st.WS) === null ? '' : tile('體感（估算）', fmtNum(apparentTemp(st.T, st.RH, st.WS), 1, '°C')),
    st.Tmax === undefined ? '' : tile('今日高／低', `${fmtNum(st.Tmax, 1)}／${fmtNum(st.Tmin, 1, '°C')}`),
    num('氣壓', st.P, 'hPa'), num('能見度', st.vis, 'km'), num('紫外線', st.uv, '', 0),
  ].join('');
  const rain = [['10分鐘', 'R10m'], ['1小時', 'R1h'], ['3小時', 'R3h'], ['6小時', 'R6h'], ['12小時', 'R12h'], ['24小時', 'R24h'], ['今日累積', 'Rnow']]
    .map(([l, k]) => num(l, st[k], 'mm')).join('');
  return raw(`<section class="card station" aria-labelledby="h-stn"><h3 id="h-stn">${esc(st.n)}測站・即時觀測</h3>
<p class="meta">${esc(STATION_KIND[st.k] || '測站')}・海拔 ${st.alt !== undefined ? `${Math.round(st.alt)} m` : '不明'}・${esc(st.county || '')}${esc(st.town || '')}・站號 ${esc(st.id)}</p>
${obs ? `<div class="tiles">${obs}</div>` : ''}
${rain ? `<h4>雨量</h4><div class="tiles">${rain}</div>` : ''}
<p class="muted">觀測時間 ${esc(fmtTime(st.t))}（${esc(ageText(st.t))}）</p></section>`);
}

/** Mountains near a point, nearest first: CWA hiking forecast spots and OSM peaks. */
function mountainsCard(lat, lon, maxKm = 20, excludeKey = null) {
  const cwa = S.spots.filter((x) => x.c === 'mountain').map((it) => ({ it, kind: 'cwa' }));
  const osm = S.peaks.map((it) => ({ it, kind: 'osm' }));
  const list = [...cwa, ...osm].map((x) => ({ ...x, d: haversineKm(lat, lon, x.it.lat, x.it.lon) }))
    .filter((x) => x.d <= maxKm && x.it.k !== excludeKey).sort((a, b) => a.d - b.d).slice(0, 12);
  const btn = ({ it, kind, d }) => (kind === 'cwa'
    ? html`<button class="seg-btn mtn" data-spot="${it.k}" title="氣象署登山預報點"><span class="pin-mtn tog-ic" aria-hidden="true"><svg viewBox="0 0 18 18"><path d="M9 2 17 16H1z"/></svg></span>${it.n} <small>${d.toFixed(1)} km・有登山預報</small></button>`
    : html`<button class="seg-btn mtn osm" data-peak="${it.k}"><span class="pin-peak tog-ic" aria-hidden="true"><svg viewBox="0 0 14 14"><path d="M7 2.2 12.6 12H1.4z"/></svg></span>${it.n} <small>${it.ele ? `${eleText(it)}・` : ''}${it.area ? `${it.area}・` : ''}${d.toFixed(1)} km</small></button>`);
  return html`<section class="card" aria-labelledby="h-mtn"><h3 id="h-mtn">鄰近山域（${maxKm} km 內）</h3>
${list.length ? html`<div class="mtns">${list.map(btn)}</div>
<p class="note">點山名可查看預報與安全評估。標示「有登山預報」的是氣象署登山預報點，其他山頭顯示鄰近鄉鎮預報。山頭資料 © OpenStreetMap contributors。</p>` : html`<p>${maxKm} km 內沒有已知山頭。</p>`}</section>`;
}

// ------------------------------------------------------------------ forecast tables
/** {time: gust m/s} for a mountain spot key or township code from wind.json (model gusts), or null. */
function gustSeries(key) {
  const w = S.wind;
  if (!w || !w.gustSource || !key) return null;
  const cols = w.mountains.find((m) => m.k === key)?.w || w.towns[key];
  if (!cols || !cols[3]) return null;
  return Object.fromEntries(w.times.map((t, i) => [t, cols[3][i]]));
}

function forecastD3(d3, gust = null) {
  const pop = el(d3, '3小時降雨機率');
  if (!pop) return '';
  const wx = el(d3, '天氣現象');
  const T = el(d3, '溫度');
  const AT = el(d3, '體感溫度');
  const WS = el(d3, '風速');
  const WD = el(d3, '風向');
  const RH = el(d3, '相對濕度');
  const cols = pop.t.map((t, i) => ({
    t, pop: pop.v.ProbabilityOfPrecipitation[i], wx: valueAt(wx, 'Weather', t),
    T: valueAt(T, 'Temperature', t), AT: valueAt(AT, 'ApparentTemperature', t),
    ws: valueAt(WS, 'WindSpeed', t), bf: valueAt(WS, 'BeaufortScale', t), wd: valueAt(WD, 'WindDirection', t),
    rh: valueAt(RH, 'RelativeHumidity', t),
  }));
  const row = (label, f) => `<tr><th scope="row">${label}</th>${cols.map((c) => `<td>${f(c)}</td>`).join('')}</tr>`;
  return `<div class="scroll"><table class="fc"><thead><tr><th scope="col">時間</th>${cols.map((c) => `<th scope="col">${esc(fmtTime(c.t, { weekday: true }))}</th>`).join('')}</tr></thead><tbody>
${row('天氣', (c) => esc(c.wx ?? '—'))}
${row('降雨機率', (c) => (c.pop === null ? '—' : `<span class="pop" style="--p:${c.pop}">${c.pop}%</span>`))}
${row('溫度', (c) => (c.T === null ? '—' : `${c.T}°`))}
${row('體感', (c) => (c.AT === null ? '—' : `${c.AT}°`))}
${row('風', (c) => (c.ws === null ? '—' : `${esc(c.wd ?? '')} ${c.ws} m/s<br><small>${c.bf ?? ''}級</small>`))}
${gust ? row('陣風<br><small>模式</small>', (c) => (gust[c.t] == null ? '—' : `${gust[c.t]} m/s<br><small>${beaufort(gust[c.t])}級</small>`)) : ''}
${row('濕度', (c) => (c.rh === null ? '—' : `${c.rh}%`))}
</tbody></table></div>`;
}


/** The forecast step that is current now (first one not yet ended): { pop, wx, T, AT, ws, bf, g } or null. */
function fcBrief(d3, gust = null) {
  const pop = el(d3, '3小時降雨機率');
  if (!pop || !pop.t.length) return null;
  let i = pop.t.findIndex((t) => new Date(t).getTime() + 3 * 3600e3 > Date.now());
  if (i < 0) i = pop.t.length - 1;
  const t = pop.t[i];
  return { pop: pop.v.ProbabilityOfPrecipitation[i] ?? null, wx: valueAt(el(d3, '天氣現象'), 'Weather', t), T: valueAt(el(d3, '溫度'), 'Temperature', t),
    AT: valueAt(el(d3, '體感溫度'), 'ApparentTemperature', t), ws: valueAt(el(d3, '風速'), 'WindSpeed', t), bf: valueAt(el(d3, '風速'), 'BeaufortScale', t), g: gust?.[t] ?? null };
}

function briefText(b) {
  if (!b) return '';
  return [b.wx, b.pop !== null ? `降雨 ${b.pop}%` : null, b.T !== null ? `${b.T}°${b.AT !== null && b.AT !== b.T ? `（體感 ${b.AT}°）` : ''}` : null,
    b.bf !== null ? `風 ${b.bf}級${b.g !== null ? `（陣風 ${beaufort(b.g)}級）` : ''}` : null].filter(Boolean).join('・');
}

function forecastWeek(week) {
  const pop = el(week, '12小時降雨機率');
  if (!pop) return '';
  const wx = el(week, '天氣現象');
  const mx = el(week, '最高溫度');
  const mn = el(week, '最低溫度');
  const amx = el(week, '最高體感溫度');
  const amn = el(week, '最低體感溫度');
  const WS = el(week, '風速');
  const WD = el(week, '風向');
  const UV = el(week, '紫外線指數');
  const rows = pop.t.map((t, i) => {
    const h = new Date(t).getHours();
    return `<tr><th scope="row">${esc(fmtTime(t, { weekday: true }).replace(/ \d\d:\d\d$/, ''))} ${h < 12 ? '白天' : '晚上'}</th>
<td>${esc(valueAt(wx, 'Weather', t) ?? '—')}</td><td>${pop.v.ProbabilityOfPrecipitation[i] ?? '—'}%</td>
<td>${valueAt(mn, 'MinTemperature', t) ?? '—'}–${valueAt(mx, 'MaxTemperature', t) ?? '—'}°</td>
<td>${valueAt(amn, 'MinApparentTemperature', t) ?? '—'}–${valueAt(amx, 'MaxApparentTemperature', t) ?? '—'}°</td>
<td>${esc(valueAt(WD, 'WindDirection', t) ?? '')} ${valueAt(WS, 'BeaufortScale', t) ?? '—'}級</td>
<td>${valueAt(UV, 'UVIndex', t) ?? '—'}</td></tr>`;
  }).join('');
  return `<div class="scroll"><table class="fc week"><thead><tr><th scope="col">時段</th><th scope="col">天氣</th><th scope="col">降雨機率</th><th scope="col">溫度</th><th scope="col">體感</th><th scope="col">風</th><th scope="col">紫外線</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function minApparent(fc) {
  const e = el(fc?.week, '最低體感溫度');
  if (!e) return null;
  const vals = (e.v.MinApparentTemperature || []).slice(0, 4).filter((v) => typeof v === 'number');
  return vals.length ? Math.min(...vals) : null;
}

const GUST_NOTE = '<p class="note">陣風：Open-Meteo 數值模式預報（CC BY 4.0），非氣象署發布；氣象署鄉鎮與登山預報只提供平均風。</p>';

/** One-line summary of a hiking forecast for the next 24 h: weather, temperature, rain chance, wind. */
function mtnBrief(fc, key) {
  const d3 = fc?.d3;
  if (!d3) return '';
  const now = Date.now();
  const within = (e) => (e ? e.t.map((t, i) => [new Date(t).getTime(), i]).filter(([ms]) => ms + 3 * 3600e3 > now && ms < now + 24 * 3600e3).map(([, i]) => i) : []);
  const col = (e, k) => within(e).map((i) => e.v[k]?.[i]).filter((v) => typeof v === 'number');
  const T = col(el(d3, '溫度'), 'Temperature');
  const pop = col(el(d3, '3小時降雨機率'), 'ProbabilityOfPrecipitation');
  const bf = col(el(d3, '風速'), 'BeaufortScale');
  const wxE = el(d3, '天氣現象');
  const wx = wxE && within(wxE).length ? wxE.v.Weather?.[within(wxE)[0]] : null;
  const wdE = el(d3, '風向');
  const wd = wdE && within(wdE).length ? wdE.v.WindDirection?.[within(wdE)[0]] : null;
  const gust = maxGust24(gustSeries(key));
  return [
    wx || null,
    T.length ? `${Math.min(...T)}–${Math.max(...T)}°C` : null,
    pop.length ? `降雨機率 ${Math.max(...pop)}%` : null,
    bf.length ? `${wd || '風'} 最大 ${Math.max(...bf)} 級${gust !== null ? `（陣風 ${gust} m/s）` : ''}` : null,
  ].filter(Boolean).join('・');
}

/** Highest model gust (m/s) in the next 24 h, or null. */
function maxGust24(gust) {
  if (!gust) return null;
  const now = Date.now();
  const vals = Object.entries(gust).filter(([t, g]) => g != null && new Date(t).getTime() + 3 * 3600e3 > now && new Date(t).getTime() < now + 24 * 3600e3).map(([, g]) => g);
  return vals.length ? Math.max(...vals) : null;
}

/** Highest Beaufort number in the next 24 h of a 3-hourly forecast. */
function maxWindBf(fc) {
  const e = el(fc?.d3, '風速');
  if (!e) return null;
  const now = Date.now();
  const vals = e.t.map((t, i) => [new Date(t).getTime(), Number(e.v.BeaufortScale?.[i])])
    .filter(([t, b]) => t + 3 * 3600e3 > now && t < now + 24 * 3600e3 && Number.isFinite(b)).map(([, b]) => b);
  return vals.length ? Math.max(...vals) : null;
}

// ------------------------------------------------------------------ history
function histTimes(h) {
  const t0 = new Date(`${h.start}:00:00+08:00`).getTime();
  return Array.from({ length: h.n }, (_, i) => new Date(t0 + i * 3600e3).toISOString());
}

async function loadArchiveRows(sid, fromMs, toMs) {
  const months = S.manifest?.layers?.history?.months || [];
  const wanted = months.filter((m) => {
    const ms = new Date(`${m}-01T00:00:00+08:00`).getTime();
    const me = new Date(new Date(ms).setMonth(new Date(ms).getMonth() + 1)).getTime();
    return me > fromMs && ms < toMs;
  });
  const rows = [];
  for (const m of wanted) {
    const res = await fetch(`data/archive/${m}.csv.gz`);
    if (!res.ok) continue;
    let text;
    if ('DecompressionStream' in window) {
      text = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text();
    } else {
      continue;
    }
    const lines = text.split('\n');
    const head = lines[0].split(',');
    for (let i = 1; i < lines.length; i += 1) {
      if (!lines[i].includes(`,${sid},`)) continue;
      const c = lines[i].split(',');
      const rec = {};
      head.forEach((k, j) => { rec[k] = c[j]; });
      rows.push(rec);
    }
  }
  return rows;
}

async function renderHistory(container, sid, range) {
  const box = container.querySelector('#hist-out');
  box.innerHTML = '<p class="loading" role="status">載入歷史資料…</p>';
  let h;
  try { h = await getJSON(`hist/${sid}.json`); } catch { h = null; }
  let times = h ? histTimes(h) : [];
  let f = h ? h.fields : {};
  const now = Date.now();
  let from; let to = now;
  if (range === 'custom') {
    const a = container.querySelector('#hist-from').value;
    const b = container.querySelector('#hist-to').value;
    if (!a || !b) { box.innerHTML = '<p>請選擇起訖日期。</p>'; return; }
    from = new Date(`${a}T00:00:00+08:00`).getTime();
    to = new Date(`${b}T23:59:59+08:00`).getTime();
    if (!(from < to)) { box.innerHTML = '<p>起始日期需早於結束日期。</p>'; return; }
    const firstAvail = times.length ? new Date(times[0]).getTime() : now;
    if (from < firstAvail) {
      const rows = await loadArchiveRows(sid, from, to);
      if (rows.length) {
        const map = new Map(times.map((t, i) => [t, i]));
        const extraT = [];
        rows.forEach((r) => {
          const t = new Date(`${r.hour}:00:00+08:00`).toISOString();
          if (!map.has(t)) extraT.push([t, r]);
        });
        extraT.sort((a, b) => a[0].localeCompare(b[0]));
        const keys = ['T', 'RH', 'WS', 'WD', 'G', 'R1h', 'Rnow'];
        const nf = {};
        keys.forEach((k) => {
          nf[k] = extraT.map(([, r]) => (r[k] === '' || r[k] === undefined ? null : Number(r[k]))).concat(f[k] || times.map(() => null));
        });
        times = extraT.map(([t]) => t).concat(times);
        f = nf;
      }
    }
  } else {
    from = now - Number(range) * 3600e3;
  }
  const idx = times.map((t, i) => [new Date(t).getTime(), i]).filter(([ms]) => ms >= from && ms <= to).map(([, i]) => i);
  if (!idx.length) { box.innerHTML = '<p>此期間沒有資料。歷史資料自本服務開始收集後逐時累積，最早約可回溯 15 天。</p>'; return; }
  const pick = (k) => (f[k] ? idx.map((i) => f[k][i]) : null);
  const tt = idx.map((i) => times[i]);
  const T = pick('T'); const R = pick('R1h'); const WS = pick('WS'); const G = pick('G'); const RH = pick('RH');
  let out = '';
  if (T && T.some((v) => v !== null)) out += chart({ title: '溫度', unit: '°C', times: tt, series: [{ label: '氣溫', values: T, kind: 'line', cls: 's1' }] });
  if (R && R.some((v) => v !== null)) out += chart({ title: '時雨量', unit: 'mm', times: tt, zeroBase: true, series: [{ label: '每小時雨量', values: R, kind: 'bar', cls: 's2' }] });
  if ((WS && WS.some((v) => v !== null)) || (G && G.some((v) => v !== null))) {
    out += chart({
      title: '風速', unit: 'm/s', times: tt, zeroBase: true,
      series: [{ label: '平均風', values: WS || [], kind: 'line', cls: 's3' }, { label: '陣風', values: G || [], kind: 'line', cls: 's4', dash: true }],
    });
  }
  if (RH && RH.some((v) => v !== null)) out += chart({ title: '相對濕度', unit: '%', times: tt, series: [{ label: '濕度', values: RH, kind: 'line', cls: 's1' }] });
  const cols = [['氣溫°C', T], ['時雨量mm', R], ['風速m/s', WS], ['陣風m/s', G], ['濕度%', RH]].filter(([, v]) => v).map(([label, values]) => ({ label, values }));
  out += dataTable(tt, cols);
  box.innerHTML = out || '<p>此期間沒有資料。</p>';
}

function historyBlock(stations, selected) {
  const opts = stations.map(({ it, d }) => `<option value="${esc(it.id)}"${it.id === selected ? ' selected' : ''}>${esc(it.n)}（${d.toFixed(1)} km${it.k === 'rain' ? '・雨量站' : ''}）</option>`).join('');
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  const weekAgo = new Date(Date.now() - 7 * 864e5).toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
  return raw(`<details class="sub" data-sub="hist"><summary><span aria-hidden="true">▤</span> 觀測資料 <small>逐時數值、圖表與數據表</small></summary><div class="in">
<label class="field">測站（距離） <select id="hist-sid">${opts}</select></label>
<div class="seg" role="radiogroup" aria-label="期間">
<button class="seg-btn" role="radio" aria-checked="true" data-range="24">24 小時</button>
<button class="seg-btn" role="radio" aria-checked="false" data-range="72">3 天</button>
<button class="seg-btn" role="radio" aria-checked="false" data-range="168">7 天</button>
<button class="seg-btn" role="radio" aria-checked="false" data-range="744">31 天</button>
<button class="seg-btn" role="radio" aria-checked="false" data-range="custom">自訂</button></div>
<div id="hist-custom" class="custom" hidden><label>起 <input type="date" id="hist-from" value="${weekAgo}"></label>
<label>迄 <input type="date" id="hist-to" value="${today}"></label><button class="btn" id="hist-go">查詢</button></div>
<div id="hist-out"></div></div></details>`);
}

function bindHistory(root) {
  const sel = root.querySelector('#hist-sid');
  if (!sel) return;
  let range = '24';
  const run = () => renderHistory(root, sel.value, range);
  root.querySelectorAll('[data-range]').forEach((b) => b.addEventListener('click', () => {
    range = b.dataset.range;
    root.querySelectorAll('[data-range]').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
    root.querySelector('#hist-custom').hidden = range !== 'custom';
    if (range !== 'custom') run();
  }));
  root.querySelector('#hist-go').addEventListener('click', run);
  sel.addEventListener('change', run);
  // The charts load when the section is first opened (or when another station is chosen), not for every panel.
  const sub = sel.closest('details.sub');
  let loaded = false;
  const first = () => { if (!loaded) { loaded = true; run(); } };
  sel.addEventListener('change', () => { loaded = true; });
  if (sub?.open) first(); else sub?.addEventListener('toggle', () => { if (sub.open) first(); });
}

// ------------------------------------------------------------------ point view
/** Rain rate estimate from reflectivity, Marshall-Palmer Z = 200 R^1.6. */
export function dbzToRate(dbz) {
  return (10 ** (dbz / 10) / 200) ** (1 / 1.6);
}

function qpf12Metas() { return (S.manifest?.layers?.qpf?.periods || []).map((p) => p.meta); }

async function sampleLayers(lat, lon) {
  const out = {};
  const jobs = [
    ['radar', framesFor('radar').slice(-1)[0]], ['qpe1h', 'grids/qpe1h.json'], ['rainday', 'grids/rainday.json'],
    ['qpf1h', 'grids/qpf1h.json'], ['temp', 'grids/temp.json'],
    ...qpf12Metas().map((p, i) => [`qpf${i}`, p]),
    ...(S.manifest?.layers?.qpf6?.periods || []).map((p, i) => [`qpf6_${i}`, p.meta]),
    ...(S.manifest?.layers?.qpfacc?.periods || []).flatMap((p) => [[`qacc${p.hours}`, p.meta],
      [`qacc${p.hours}_lo`, p.meta.replace('.json', '_lo.json')], [`qacc${p.hours}_hi`, p.meta.replace('.json', '_hi.json')]]),
    ...(S.manifest?.layers?.rainacc?.periods || []).filter((p) => p.id !== 'day').map((p) => [`acc_${p.id}`, p.meta]),
    ['satir', S.manifest?.layers?.satellite?.grids?.ir?.meta],
  ].filter(([, p]) => p);
  await Promise.all(jobs.map(async ([k, p]) => {
    try {
      const g = await getGrid(p);
      out[k] = { v: sample(g, lat, lon), range: classRange(g, lat, lon), meta: g.meta };
    } catch { /* layer unavailable offline */ }
  }));
  return out;
}

export async function showPoint(lat, lon, opts = {}) {
  if (!S.focus) S.focus = L.layerGroup().addTo(S.map);
  S.focus.clearLayers();
  L.circleMarker([lat, lon], { radius: 9, weight: 3, color: '#000', fillColor: '#fff', fillOpacity: 0.9, className: 'focus-pt' }).addTo(S.focus);
  openSheet('查詢中…', loading);

  const town = findTown(lat, lon);
  const spotsNear = nearest(S.spots, lat, lon, { limit: 8, maxKm: 6 });
  // An OSM peak or a plain map tap has no CWA forecast of its own: the township forecast and the forecasts of
  // the nearest CWA mountains are shown instead. A spot's own forecast only opens when that spot was chosen
  // (its marker, search result or favourite), never by guessing from a nearby tap.
  const peak = opts.peak || null;
  const spotPick = opts.spotKey ? S.spots.find((s) => s.k === opts.spotKey) : null;
  const nearMtns = spotPick || opts.stationId ? [] : nearest(S.spots, lat, lon, { limit: 60, maxKm: 15 }).filter((x) => x.it.c === 'mountain').slice(0, 3);
  const stationsNear = nearest(S.stations, lat, lon, { limit: 8, maxKm: 35 });
  const weatherSt = stationsNear.filter((x) => x.it.k !== 'rain');
  const histDefault = opts.stationId || weatherSt[0]?.it.id || stationsNear[0]?.it.id;

  const [vals, spotFc, townFc, , ...mtnFcs] = await Promise.all([
    sampleLayers(lat, lon),
    spotPick ? getJSON(`spots/f/${spotPick.k}.json`).catch(() => null) : null,
    town ? getJSON(`towns/${town.TOWNCODE}.json`).catch(() => null) : null,
    Promise.all([loadWind(), loadAloft(), loadHydro()]).catch(() => null), // model gusts for the forecast tables; winds aloft; water level and debris-flow alerts
    ...nearMtns.map(({ it }) => getJSON(`spots/f/${it.k}.json`).catch(() => null)),
  ]);
  // Winds aloft, visibility and UV come from the chosen mountain forecast point, else the nearest one within 12 km.
  const aloftSpot = spotPick?.c === 'mountain' ? { it: spotPick, d: 0 } : nearest(S.spots, lat, lon, { limit: 60, maxKm: 12 }).find((x) => x.it.c === 'mountain');
  const aloftHtml = aloftSpot && S.aloft
    ? aloftCard(S.aloft, aloftSpot.it.k, { ele: spotPick?.ele ?? peak?.ele ?? null,
      note: aloftSpot.d > 0.5 ? `此處沒有登山預報，以下為最近的預報山頭「${aloftSpot.it.n}」（距此 ${aloftSpot.d.toFixed(1)} km${aloftSpot.it.ele ? `，海拔 ${aloftSpot.it.ele} m` : ''}）的數值。` : '' })
    : '';
  const nearFc = nearMtns[0] && nearMtns[0].d <= 10 ? mtnFcs[0] : null; // wind of the nearest mountain, for the risk list

  const county = normCounty(town?.COUNTYNAME);
  const countyWarn = (S.warnings?.counties || []).find((c) => normCounty(c.county) === county);
  const quakesNear = (S.quakes || []).filter((q) => Date.now() - new Date(q.time).getTime() < 3 * 864e5)
    .map((q) => ({ ...q, d: haversineKm(lat, lon, q.lat, q.lon) })).filter((q) => q.d <= 50);
  const qpfFirst = vals.qpf0?.range || null;
  const ty = S.typhoon?.active ? { active: true, name: S.typhoon.cyclones.map((c) => c.cname).join('、'), near: true } : null;
  const fcForCold = spotFc || townFc;
  const risk = assess({
    rain1h: vals.qpe1h?.v ?? null, rainToday: Math.max(vals.rainday?.v ?? 0, vals.acc_24h?.v ?? 0) || null, qpfMax: qpfFirst, radar: vals.radar?.v ?? null,
    stations: stationsNear.map((x) => x.it), spotMinAT: minApparent(fcForCold),
    warnings: countyWarn?.hazards || [], typhoon: ty,
    quakes: quakesNear.map((q) => ({ iv: q.maxInt, d: q.d, int: intText(q.maxInt) })),
    lightning: lightningNear(lat, lon, 15), windBf: maxWindBf(spotFc || nearFc),
    gustFc: maxGust24(gustSeries(spotFc?.k || nearFc?.k) || gustSeries(town?.TOWNCODE)),
  }, S.settings.thresholds);

  const title = opts.label || peak?.n || spotPick?.n || (town ? `${normCounty(town.COUNTYNAME)}${town.TOWNNAME}` : `${lat.toFixed(4)}, ${lon.toFixed(4)}`);
  // Header hint: this place has no CWA forecast of its own (only a chosen forecast spot or a station has).
  const noForecast = opts.stationId ? '' : peak ? '無氣象署預報・顯示鄰近鄉鎮與鄰近山頭預報' : !spotPick ? '非預報點・顯示鄉鎮與鄰近山頭預報' : '';
  const placeLine = [peak?.tags?.length ? peak.tags.map((t) => S.peakLists[t] || t).join('・') : null, peak?.ele ? `海拔 ${eleText(peak)}${peak.est ? '（地形模型估計）' : ''}` : null, town ? `${normCounty(town.COUNTYNAME)} ${town.TOWNNAME}` : null, `${lat.toFixed(5)}, ${lon.toFixed(5)}`].filter(Boolean).join('・');
  const near = spotsNear.slice(0, 5).map(({ it, d }) => html`<li><button class="link" data-spot="${it.k}">${it.n}</button> <span class="meta">${S.spotCats.find((c) => c.id === it.c)?.label || ''}・${d.toFixed(1)} km</span></li>`);

  const vrow = (label, k, unit, digits = 1, empty = '無資料') => {
    const x = vals[k];
    if (!x) return '';
    let txt = x.v === null ? empty : fmtNum(x.v, digits, unit);
    if (k === 'radar' && x.v !== null && x.v >= 10) txt += `（約 ${fmtNum(dbzToRate(x.v), 1)} mm/h）`;
    return `<tr><th scope="row">${label}</th><td>${txt}</td><td class="muted">${esc(fmtTime(x.meta.time))}</td></tr>`;
  };
  const accRows = (S.manifest?.layers?.rainacc?.periods || []).map((p) => {
    const x = p.id === 'day' ? vals.rainday : vals[`acc_${p.id}`];
    if (!x) return '';
    return `<tr><th scope="row">${esc(p.label)}</th><td>${x.v === null ? '無資料' : fmtNum(x.v, 1, 'mm')}</td></tr>`;
  }).join('');
  const qpfRows = qpf12Metas().map((_, i) => {
    const x = vals[`qpf${i}`];
    if (!x) return '';
    const r = x.range;
    const txt = !r ? '無資料' : r[0] === 0 ? '< 0.5 mm' : `${r[0]}${r[1] ? `–${r[1]}` : ' 以上'} mm`;
    return `<tr><th scope="row">${esc(fmtTime(x.meta.start))}–${esc(fmtTime(x.meta.end, { date: false }))}</th><td colspan="2">${txt}</td></tr>`;
  }).join('');

  const qpf6Rows = (S.manifest?.layers?.qpf6?.periods || []).map((_, i) => {
    const x = vals[`qpf6_${i}`];
    if (!x) return '';
    return `<tr><th scope="row">${esc(fmtTime(x.meta.start))}–${esc(fmtTime(x.meta.end, { date: false }))}</th><td colspan="2">${x.v === null ? '無資料' : fmtNum(x.v, 1, 'mm')}</td></tr>`;
  }).join('');
  let accMeta = null;
  const qaccRows = (S.manifest?.layers?.qpfacc?.periods || []).map((p) => {
    const x = vals[`qacc${p.hours}`];
    if (!x) return '';
    accMeta = x.meta;
    const lo = vals[`qacc${p.hours}_lo`]?.v;
    const hi = vals[`qacc${p.hours}_hi`]?.v;
    const range = lo === null || lo === undefined ? '' : `（範圍 ${fmtNum(lo, 1)}–${hi === null || hi === undefined ? '300 以上' : fmtNum(hi, 1)} mm）`;
    return `<tr><th scope="row">未來 ${p.hours} 小時</th><td colspan="2">${x.v === null ? '無資料' : `約 ${fmtNum(x.v, 0, 'mm')}${range}`}</td></tr>`;
  }).join('');
  const fcHtml = spotPick && spotFc
    ? `<p class="muted">${esc(spotFc.n)}（${esc(S.spotCats.find((c) => c.id === spotFc.c)?.label || '')}）・發布 ${esc(fmtTime(spotFc.issue))}</p>
<div class="tabs" role="tablist"><button role="tab" class="tab" aria-selected="true" data-tab="d3">未來3天(逐3小時)</button><button role="tab" class="tab" aria-selected="false" data-tab="week">一週(逐12小時)</button></div>
<div data-panel="d3">${forecastD3(spotFc.d3, gustSeries(spotFc.k))}</div>${gustSeries(spotFc.k) ? GUST_NOTE : ''}<div data-panel="week" hidden>${forecastWeek(spotFc.week)}</div>`
    : '';
  // Forecasts of the nearest CWA hiking-forecast mountains (the tapped point is not one of them).
  const mtnFcHtml = nearMtns.length ? html`<section class="card" aria-labelledby="h-nmf"><h3 id="h-nmf">鄰近山頭預報</h3>
<p class="note">此處不是氣象署登山預報點，以下為 15 km 內最近的預報山頭（未來 24 小時概況）；距離越遠、海拔差越大，參考性越低。</p>
<ul class="list">${nearMtns.map(({ it, d }, i) => {
    const b = mtnBrief(mtnFcs[i], it.k);
    return html`<li><button class="link" data-spot="${it.k}">${it.n}</button> <span class="meta">距此 ${d.toFixed(1)} km${it.ele ? `・海拔 ${it.ele} m` : ''}${it.a ? `・${it.a}` : ''}</span>
${b ? html`<br><small>${b}</small>` : html`<br><small class="muted">暫無預報資料</small>`}</li>`;
  })}</ul></section>` : '';
  const townHtml = townFc
    ? `<p class="muted">${esc(normCounty(town.COUNTYNAME))}${esc(townFc.n)} 鄉鎮預報・發布 ${esc(fmtTime(townFc.issue3d || townFc.issue))}</p>
<div class="tabs" role="tablist"><button role="tab" class="tab" aria-selected="true" data-tab="td3">未來3天</button><button role="tab" class="tab" aria-selected="false" data-tab="tweek">一週</button></div>
<div data-panel="td3">${forecastD3(townFc.d3, gustSeries(town.TOWNCODE))}</div>${gustSeries(town.TOWNCODE) ? GUST_NOTE : ''}<div data-panel="tweek" hidden>${forecastWeek(townFc.week)}</div>`
    : '';

  const hydroHtml = hydroCard(S.hydro, lat, lon, town?.COUNTYNAME, town?.TOWNNAME);
  const warnHtml = countyWarn?.hazards?.length
    ? html`<section class="card warn" aria-labelledby="h-warn"><h3 id="h-warn">${county} 警特報</h3><ul>${countyWarn.hazards.map((h) => html`<li>${h.ph}${h.sig}（至 ${fmtTime(h.end)}）</li>`)}</ul></section>`
    : '';
  const tyHtml = S.typhoon?.active ? html`<section class="card warn"><h3>颱風警報中</h3><button class="btn" data-open="typhoon">查看颱風路徑、風力與雨量預測</button></section>` : '';
  const qHtml = quakesNear.length ? html`<section class="card"><h3>近 3 天 50 km 內地震</h3><ul>${quakesNear.map((q) => html`<li><button class="link" data-quake="${q.time}">${fmtTime(q.time)} 規模 ${q.mag}</button> <span class="meta">距此 ${q.d.toFixed(0)} km・最大震度 ${intText(q.maxInt)}</span></li>`)}</ul></section>` : '';

  const station = opts.stationId ? S.stations.find((x) => x.id === opts.stationId) : null;
  const riskHtml = html`<section class="card risk ${LEVELS[risk.level].cls}" aria-labelledby="h-risk"><h3 id="h-risk">登山安全評估</h3>
${risk.reasons.length ? html`<ul>${risk.reasons.map((r) => html`<li>${lvBadge(r.lv)} ${r.text}</li>`)}</ul>` : html`<p>目前未觸發警示條件。</p>`}
<p class="note">依門檻自動判斷，僅供參考；請以現場狀況與官方資訊為準。門檻可在「設定」調整。</p></section>`;
  const nowHtml = html`<section class="card" aria-labelledby="h-now"><h3 id="h-now">此處即時格點值</h3><table class="kv"><tbody>
${raw(vrow('雷達回波', 'radar', 'dBZ', 0, '無回波'))}${raw(vrow('過去1小時雨量', 'qpe1h', 'mm'))}${raw(vrow('未來1小時雨量', 'qpf1h', 'mm'))}${raw(vrow('溫度分析', 'temp', '°C'))}${raw(vrow('雲頂溫度（紅外線）', 'satir', '°C', 0))}
</tbody></table></section>`;
  const accHtml = accRows ? html`<section class="card" aria-labelledby="h-acc"><h3 id="h-acc">累積雨量（雨量站內插估計）</h3><table class="kv"><tbody>${raw(accRows)}</tbody></table></section>` : '';
  const qpfHtml = qpfRows ? html`<section class="card" aria-labelledby="h-qpf"><h3 id="h-qpf">定量降水預報（每12小時）</h3><table class="kv"><tbody>${raw(qpfRows)}</tbody></table></section>` : '';
  const qpf6Html = qpf6Rows ? html`<section class="card" aria-labelledby="h-qpf6"><h3 id="h-qpf6">定量降水預報（每6小時・颱風警報期間）</h3><table class="kv"><tbody>${raw(qpf6Rows)}</tbody></table></section>` : '';
  const qaccHtml = qaccRows ? html`<section class="card" aria-labelledby="h-qacc"><h3 id="h-qacc">未來累積降水（由12小時預報加總）</h3><table class="kv"><tbody>${raw(qaccRows)}</tbody></table>${raw(accMeta ? attribution(accMeta) : '')}</section>` : '';
  const spotFcCard = fcHtml ? html`<section class="card" aria-labelledby="h-fc"><h3 id="h-fc">地點預報</h3>${raw(fcHtml)}</section>` : '';
  const townCard = townHtml && peak ? html`<section class="card" aria-labelledby="h-tfc"><h3 id="h-tfc">鄰近鄉鎮預報</h3>
<p class="note">此山不是氣象署登山預報點，以下為所在鄉鎮（${normCounty(town.COUNTYNAME)}${town.TOWNNAME}）的預報；山區氣溫通常較低、風較強，請一併參考鄰近測站。</p>${raw(townHtml)}</section>`
    : townHtml ? html`<section class="card" aria-labelledby="h-tfc"><h3 id="h-tfc">鄉鎮預報</h3>${raw(townHtml)}</section>` : '';
  const otherStations = station ? stationsNear.filter((x) => x.it.id !== station.id) : stationsNear;
  const stationsHtml = html`<section class="card" aria-labelledby="h-st"><h3 id="h-st">${station ? '其他鄰近測站' : '鄰近測站'}</h3>
${otherStations.length ? html`<ul class="stations">${otherStations.slice(0, 6).map(({ it, d }) => stationLine(it, d))}</ul><p class="muted">觀測時間 ${fmtTime(S.stationsTime)}（${ageText(S.stationsTime)}）</p>` : html`<p>35 km 內沒有其他測站。</p>`}
${stationsNear.length ? historyBlock(stationsNear, histDefault) : ''}</section>`;
  const nearHtml = near.length ? html`<section class="card"><h3>附近景點／山岳</h3><ul>${near}</ul></section>` : '';

  // ---- one-line summaries of the folded cards
  const [briefD3, briefGust] = spotFc ? [spotFc.d3, gustSeries(spotFc.k)] : townFc ? [townFc.d3, gustSeries(town.TOWNCODE)] : nearFc ? [nearFc.d3, gustSeries(nearFc.k)] : [null, null];
  const brief = fcBrief(briefD3, briefGust);
  const ws0 = weatherSt[0]?.it;
  const eleHere = spotPick?.ele ?? peak?.ele ?? station?.alt ?? null;
  const rainSum = [vals.acc_24h?.v != null ? `過去 24 小時 ${fmtNum(vals.acc_24h.v, 1)} mm` : null, vals.qacc24?.v != null ? `未來 24 小時約 ${fmtNum(vals.qacc24.v, 0)} mm` : null].filter(Boolean).join('・');
  const nowSum = [vals.radar ? (vals.radar.v === null ? '雷達無回波' : `雷達 ${fmtNum(vals.radar.v, 0)} dBZ`) : null, vals.qpe1h?.v != null ? `1 小時雨量 ${fmtNum(vals.qpe1h.v, 1)} mm` : null,
    vals.satir?.v != null ? `雲頂 ${fmtNum(vals.satir.v, 0)}°C` : null].filter(Boolean).join('・');
  const stSum = ws0 ? [ws0.n, `${weatherSt[0].d.toFixed(1)} km`, ws0.T !== undefined ? `${fmtNum(ws0.T)}°C` : null, ws0.RH !== undefined ? `濕度 ${fmtNum(ws0.RH, 0)}%` : null,
    ws0.WS !== undefined ? `風 ${fmtNum(ws0.WS)} m/s` : null].filter(Boolean).join('・') : (otherStations.length ? `${otherStations[0].it.n}・${otherStations[0].d.toFixed(1)} km` : '35 km 內沒有測站');
  const mtnSum = nearMtns.map(({ it, d }) => `${it.n} ${d.toFixed(1)} km`).join('・');
  const aloftPt = aloftSpot && S.aloft?.points?.[aloftSpot.it.k];
  const aloftSum = aloftPt ? (() => {
    const a = S.aloft; const k = a.times.findIndex((t) => new Date(t).getTime() + 3 * 3600e3 > Date.now());
    const i0 = k < 0 ? a.times.length - 1 : k;
    const li = eleHere === null ? 1 : a.levels.reduce((best, _, lj) => (Math.abs((levelAltOf(aloftPt, lj) ?? 1e9) - eleHere) < Math.abs((levelAltOf(aloftPt, best) ?? 1e9) - eleHere) ? lj : best), 0);
    const ws = aloftPt.ws[li][i0]; const wd = aloftPt.wd[li][i0]; const v = aloftPt.vis[i0];
    return [`${a.levels[li]} hPa${wd !== null && ws !== null ? ` ${compassName(wd)} ${ws} m/s` : ''}`, v !== null ? `能見度 ${v} km${v < 1 ? '（濃霧）' : ''}` : null].filter(Boolean).join('・');
  })() : '';
  const [sy, sm, sd] = twDate();
  const sun0 = sunTimes(lat, lon, sy, sm, sd, eleHere && eleHere >= 300 ? eleHere : 0);
  const hydroAlerts = town ? townAlerts(S.hydro, town.COUNTYNAME, town.TOWNNAME) : [];
  const hydroSum = hydroAlerts.length ? `土石流${hydroAlerts.some((a) => a.level === 'red') ? '紅色' : '黃色'}警戒` : '鄰近水位站與水庫';
  const near2 = spotsNear.slice(0, 2).map(({ it }) => it.n).join('・');

  const cardsOut = {
    risk: cardize(riskHtml, { id: 'risk', grp: 'safe', title: '登山安全評估', titleId: 'h-risk', open: true, alert: risk.level > 0, extra: `risk ${LEVELS[risk.level].cls}`,
      summary: risk.reasons.length ? `${LEVELS[risk.level].label}・${risk.reasons.length} 項觸發：${risk.reasons.slice(0, 2).map((r) => r.text.replace(/（.*?）/g, '')).join('、')}` : '正常・目前未觸發警示條件' }),
    warn: cardize(warnHtml, { id: 'warn', grp: 'safe', icon: '!', alert: true, summary: countyWarn?.hazards?.map((h) => `${h.ph}${h.sig}`).join('、') }),
    ty: cardize(tyHtml, { id: 'ty', grp: 'safe', icon: '🌀', alert: true, summary: S.typhoon?.cyclones?.map((c) => c.cname).join('、') }),
    quake: cardize(qHtml, { id: 'quake', grp: 'safe', icon: '≈', summary: `${quakesNear.length} 起・最近規模 ${quakesNear[0]?.mag}` }),
    station: station ? cardize(stationCard(station), { id: 'station', grp: 'obs', open: true, summary: `${fmtTime(station.t)}・${station.T !== undefined ? `${fmtNum(station.T)}°C` : ''}` }) : '',
    now: cardize(nowHtml, { id: 'now', grp: 'obs', summary: nowSum }),
    stations: cardize(stationsHtml, { id: 'stations', grp: 'obs', open: true, summary: stSum }),
    fc: cardize(spotFcCard, { id: 'fc', grp: 'fc', icon: '☀', open: true, summary: briefText(brief) }),
    town: cardize(townCard, { id: 'town', grp: 'fc', icon: '☀', open: !spotFcCard, summary: briefText(brief) }),
    rain: cardize([accHtml, qpfHtml, qpf6Html, qaccHtml], { id: 'rain', grp: 'fc', icon: '☂', title: '降雨預報', titleId: 'h-rain', keepHeads: true, summary: rainSum }),
    mtnFc: cardize(mtnFcHtml, { id: 'mtnfc', grp: 'fc', icon: '▲', summary: mtnSum }),
    aloft: cardize(aloftHtml, { id: 'aloft', grp: 'air', summary: aloftSum }),
    hydro: cardize(hydroHtml, { id: 'hydro', grp: 'water', alert: hydroAlerts.length > 0, summary: hydroSum }),
    ens: cardize(ensembleCard(), { id: 'ens', grp: 'fc', icon: '∿', summary: '按下載入 ECMWF／GFS 10 天範圍' }),
    sun: cardize(sunCard(lat, lon, eleHere), { id: 'sun', grp: 'sun', summary: sun0 ? `日出 ${sun0.rise}・日沒 ${sun0.set}${eleHere && eleHere >= 300 ? '（海拔視野開闊）' : ''}` : '' }),
    near: cardize(nearHtml, { id: 'near', grp: 'info', summary: near2 }),
    mtns: cardize(station ? mountainsCard(station.lat, station.lon) : peak ? mountainsCard(lat, lon, 10, peak.k) : '', { id: 'mtns', grp: 'info', icon: '▲', summary: '' }),
  };
  const order = ['risk', 'warn', 'ty', 'quake', 'station', 'now', 'stations', 'fc', 'town', 'rain', 'mtnFc', 'aloft', 'hydro', 'ens', 'sun', 'mtns', 'near'];
  const present = order.filter((k) => cardsOut[k]);
  const groupsPresent = Object.keys(GROUPS).filter((g) => present.some((k) => cardsOut[k].includes(`data-grp="${g}"`)));
  const bf = (n) => (n === null || n === undefined ? '—' : `${n} 級`);
  const sT = brief?.T ?? ws0?.T ?? null;
  const strip = html`<div class="pstrip">
<div class="pill ${LEVELS[risk.level].cls === 'lv0' ? '' : LEVELS[risk.level].cls}"><b>${LEVELS[risk.level].label}</b>安全評估</div>
<div class="pill"><b>${brief?.pop != null ? `${brief.pop}%` : '—'}</b>降雨機率</div>
<div class="pill"><b>${sT !== null ? `${fmtNum(sT, 0)}°C` : '—'}</b>${brief?.AT != null ? `體感 ${brief.AT}°` : '氣溫'}</div>
<div class="pill ${(brief?.bf ?? 0) >= 6 ? 'lv1' : ''}"><b>${bf(brief?.bf ?? (ws0?.WS !== undefined ? beaufort(ws0.WS) : null))}</b>${brief?.g != null ? `陣風 ${beaufort(brief.g)} 級` : '風力'}</div></div>`;
  const jump = html`<div class="pjump" role="group" aria-label="跳到區段">${raw(groupsPresent.map((g) => `<button type="button" class="g-${g}" data-jump="${g}">${GROUPS[g].label}</button>`).join(''))}</div>
<div class="ptools"><button type="button" id="btn-ens-jump">系集預報</button><button type="button" data-cards="open">全部展開</button><button type="button" data-cards="close">全部收合</button></div>`;
  const windy = `https://www.windy.com/${lat.toFixed(3)}/${lon.toFixed(3)}?${lat.toFixed(3)},${lon.toFixed(3)},11`;

  const body = html`
<div class="ptbar"><p class="place">${placeLine}</p>
<div class="acts"><a class="ab" target="_blank" rel="noopener" href="${windy}">🌀 Windy</a><button type="button" class="ab" id="btn-copy">⌖ 座標</button><button type="button" class="ab fav" id="btn-fav" aria-pressed="false">☆ 收藏</button></div></div>
${strip}${jump}
${raw(present.map((k) => cardsOut[k]).join(''))}
<p class="src">資料來源：中央氣象署開放資料。資料更新 ${fmtTime(S.manifest?.built)}</p>`;

  const id = pointId(lat, lon);
  // What is needed to reopen exactly this selection from the favourites list.
  const fav = { id, lat, lon, title, spotKey: spotPick?.k, peakKey: peak?.k, stationId: opts.stationId };
  openSheet(title, body, {
    replace: true,
    fav,
    sub: noForecast,
    onRender: (root) => {
      bindCommon(root);
      bindHistory(root);
      bindCards(root);
      bindEnsemble(root, lat, lon, eleHere);
      root.querySelector('#btn-fav')?.addEventListener('click', () => document.getElementById('sheet-fav').click());
      root.querySelector('#btn-copy')?.addEventListener('click', async (ev) => {
        try { await navigator.clipboard.writeText(`${lat.toFixed(5)}, ${lon.toFixed(5)}`); ev.target.textContent = '已複製'; } catch { ev.target.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`; }
      });
    },
  });
  showPick(lat, lon);
  // Snapshot for offline viewing (history charts render after; store the static part).
  saveRecent({ id, lat, lon, title, html: body.html, dataTime: S.manifest?.built });
}

function bindTabs(root) {
  root.querySelectorAll('.tabs').forEach((tabs) => {
    const btns = [...tabs.querySelectorAll('[data-tab]')];
    btns.forEach((b) => b.addEventListener('click', () => {
      btns.forEach((x) => {
        x.setAttribute('aria-selected', String(x === b));
        const p = tabs.parentElement.querySelector(`[data-panel="${x.dataset.tab}"]`);
        if (p) p.hidden = x !== b;
      });
    }));
  });
}

/** Delegated links shared by all views. */
function bindCommon(root) {
  bindTabs(root);
  root.querySelectorAll('[data-station]').forEach((b) => b.addEventListener('click', () => {
    const st = S.stations.find((s) => s.id === b.dataset.station);
    const sel = root.querySelector('#hist-sid');
    if (sel && [...sel.options].some((o) => o.value === b.dataset.station)) {
      sel.value = b.dataset.station;
      const sub = sel.closest('details.sub');
      if (sub) { sub.open = true; sub.closest('details.pcard')?.setAttribute('open', ''); }
      sel.dispatchEvent(new Event('change'));
      sel.scrollIntoView({ behavior: S.settings.reduceMotion ? 'auto' : 'smooth', block: 'center' });
    } else if (st) {
      flyTo(st.lat, st.lon);
      showPoint(st.lat, st.lon, { stationId: st.id, label: `${st.n}測站` });
    }
  }));
  root.querySelectorAll('[data-spot]').forEach((b) => b.addEventListener('click', () => {
    const sp = S.spots.find((s) => s.k === b.dataset.spot);
    if (sp) { flyTo(sp.lat, sp.lon); showPoint(sp.lat, sp.lon, { spotKey: sp.k }); }
  }));
  root.querySelectorAll('[data-peak]').forEach((b) => b.addEventListener('click', () => {
    const pk = S.peaks.find((p) => p.k === b.dataset.peak);
    if (pk) { flyTo(pk.lat, pk.lon); showPoint(pk.lat, pk.lon, { peak: pk }); }
  }));
  root.querySelectorAll('[data-quake]').forEach((b) => b.addEventListener('click', () => {
    const q = S.quakes.find((x) => x.time === b.dataset.quake);
    if (q) showQuake(q);
  }));
  root.querySelectorAll('[data-open="typhoon"]').forEach((b) => b.addEventListener('click', () => showTyphoon()));
  root.querySelectorAll('[data-point]').forEach((b) => b.addEventListener('click', () => {
    const [la, lo] = b.dataset.point.split(',').map(Number);
    flyTo(la, lo);
    showPoint(la, lo);
  }));
}

export function flyTo(lat, lon, zoom) {
  const z = Math.max(S.map.getZoom(), zoom || 11);
  if (S.settings.reduceMotion) S.map.setView([lat, lon], z); else S.map.flyTo([lat, lon], z, { duration: 0.8 });
}

// ------------------------------------------------------------------ earthquakes
export function showQuakes({ recentMs = 0 } = {}) {
  const list = S.quakes.slice(0, 40);
  const isRecent = (q) => recentMs && Date.now() - new Date(q.time).getTime() < recentMs;
  const item = (q) => html`<li><button class="link" data-quake="${q.time}"><strong>M${q.mag}</strong> ${q.loc}</button>
<span class="meta">${fmtTime(q.time)}・深度 ${q.depth} km・最大震度 ${intText(q.maxInt)}${isStrongQuake(q) ? '・強震' : ''}${q.kind === 'local' ? '・小區域' : ''}</span></li>`;
  const recent = list.filter(isRecent);
  const body = html`${recent.length ? html`<section class="card warn"><h3>24 小時內地震（${recent.length} 起）</h3><ul class="list">${recent.map(item)}</ul></section>` : ''}
<p class="muted">最近的有感地震報告（顯著與小區域）。點選查看震度分布與震央附近的山區。</p>
<ul class="list">${list.filter((q) => !isRecent(q)).map(item)}</ul>`;
  openSheet('地震報告', body, { onRender: bindCommon });
}

function intensityIcon(iv, label) {
  const scale = scaleFor('intensity', S.settings.palette);
  // iv: 1..4, 5 (5弱), 5.5 (5強), 6 (6弱), 6.5 (6強), 7 -> legend index 0..8
  const v = iv ?? 0;
  const i = Math.max(0, Math.min(scale.length - 1, v < 5 ? Math.floor(v) - 1 : 4 + Math.round((v - 5) * 2)));
  const colour = iv >= 1 ? scale[i][1] : '#ffffff';
  const dark = ['#663333', '#801a80', '#9900cc', '#b31a1a', '#440154', '#3e4989', '#31688e', '#000000', '#300030', '#600060', '#b00000'].includes(colour);
  return L.divIcon({ className: 'int-mk', html: `<span style="background:${colour};color:${dark ? '#fff' : '#000'}">${esc(label)}</span>`, iconSize: [26, 22] });
}

export async function showQuake(q) {
  if (!S.focus) S.focus = L.layerGroup().addTo(S.map);
  S.focus.clearLayers();
  // Distance rings (labelled) and epicentre.
  [10, 30, 50].forEach((km) => {
    L.circle([q.lat, q.lon], { radius: km * 1000, color: '#c00', weight: 2, dashArray: '6 6', fill: false, interactive: false }).addTo(S.focus);
    L.marker([q.lat + km / 111.2, q.lon], { icon: L.divIcon({ className: 'ring-lbl', html: `${km} km`, iconSize: [48, 18] }), interactive: false, keyboard: false }).addTo(S.focus);
  });
  L.marker([q.lat, q.lon], { icon: L.divIcon({ className: 'epi', html: '✕', iconSize: [28, 28] }), title: `震央 M${q.mag}`, zIndexOffset: 1000 }).addTo(S.focus);
  // Station intensities: coloured squares with the intensity number.
  (q.stations || []).forEach((s) => {
    const lbl = (s.int || '').replace('級', '').replace('弱', '-').replace('強', '+');
    L.marker([s.lat, s.lon], { icon: intensityIcon(s.iv, lbl), title: `${s.n} 震度 ${s.int}`, zIndexOffset: 500 })
      .bindTooltip(`${esc(s.n)}：${esc(s.int)}（距震央 ${s.d ?? '?'} km）`).addTo(S.focus);
  });
  const near = nearest(S.spots, q.lat, q.lon, { limit: 60, maxKm: 50 });
  const mountains = near.filter((x) => x.it.c === 'mountain');
  const others = near.filter((x) => x.it.c !== 'mountain').slice(0, 15);
  const towns = (() => {
    const t = []; const seen = new Set();
    nearest(S.stations, q.lat, q.lon, { limit: 200, maxKm: 30 }).forEach(({ it }) => {
      const k = `${it.county}${it.town}`;
      if (it.town && !seen.has(k)) { seen.add(k); t.push(k); }
    });
    return t.slice(0, 12);
  })();
  const scale = scaleFor('intensity', S.settings.palette);
  const legend = html`<ol class="swatches inline">${scale.map((x) => html`<li><span class="sw" style="background:${x[1]}"></span>${x[2]}</li>`)}</ol>`;
  const li = ({ it, d }) => html`<li><button class="link" data-spot="${it.k}">${it.n}</button> <span class="meta">${d.toFixed(1)} km</span></li>`;
  const strong = isStrongQuake(q);
  const hard = (q.areas || []).filter((a) => (a.iv ?? 0) >= 4);
  const body = html`<p><strong>規模 ${q.mag}</strong>・深度 ${q.depth} km・${fmtTime(q.time)}・最大震度 ${intText(q.maxInt)}</p>
<p>${q.loc}</p>
${strong ? html`<section class="card warn"><h3>強震注意</h3>
<p>最大震度 ${intText(q.maxInt)}${hard.length ? html`，震度 4 級以上：${hard.map((a) => `${a.area} ${a.int}`).join('、')}` : ''}。</p>
<ul><li>山區可能有落石、坍方、步道或林道中斷，接下來數天仍可能有規模較大的餘震。</li>
<li>出發前請向林業及自然保育署、國家公園管理處或當地公所確認步道與道路開放狀態。</li>
<li>已在山上：遠離邊坡、溪谷與崩塌地，盡量不要在落石區停留，必要時考慮撤退。</li></ul></section>` : ''}
<section class="card"><h3>地圖說明</h3>
<p>${q.shake ? '彩色區塊：氣象署等震度圖（自動對位疊合）。' : '此筆地震沒有等震度圖（氣象署僅提供最新一筆顯著有感地震）。'}方塊數字：各測站實測震度。紅色虛線：距震央 10／30／50 km。</p>
${legend}<p class="note">按標題列的 ▾ 或往下滑可縮小面板，地圖上的距離圈與震度仍會保留；按 ✕ 才會清除。</p></section>
<section class="card"><h3>震央 50 km 內的山（${mountains.length}）</h3>${mountains.length ? html`<ul class="cols">${mountains.map(li)}</ul>` : html`<p>無登山預報點位。</p>`}</section>
${others.length ? html`<section class="card"><h3>其他景點</h3><ul class="cols">${others.map(li)}</ul></section>` : ''}
${towns.length ? html`<section class="card"><h3>震央附近鄉鎮（30 km 內）</h3><p>${towns.join('、')}</p></section>` : ''}
<section class="card"><h3>各地震度</h3><table class="kv"><tbody>${q.areas.map((a) => html`<tr><th scope="row">${a.area}</th><td>${a.int}</td></tr>`)}</tbody></table></section>
<p class="muted">${q.text || ''}</p>
${strong && q.img ? html`<section class="card"><h3>氣象署地震報告圖</h3><img class="eq-report" src="${q.img}" alt="地震報告圖（震央與各地震度）" loading="lazy"></section>` : ''}
<p><a href="${q.web}" target="_blank" rel="noopener">氣象署地震報告頁</a>${q.img ? html`・<a href="${q.img}" target="_blank" rel="noopener">報告圖</a>` : ''}</p>
<p class="note">震度 4 級以上的山區請留意落石、坍方與步道受損。</p>`;
  openSheet(`地震 M${q.mag}${strong ? '（強震）' : ''}`, body, { onRender: bindCommon, peek: true, quake: true });
  // Zoom to the felt area (stations with intensity >= 1, at least the 50 km ring) above the sheet.
  const pts = (q.stations || []).filter((s) => (s.iv ?? 0) >= 1).map((s) => [s.lat, s.lon]);
  const bounds = L.latLngBounds([[q.lat, q.lon], ...pts]).extend(L.latLng(q.lat, q.lon).toBounds(110000));
  S.focusBounds = bounds;
  fitVisible(bounds);
  if (q.shake) {
    try {
      const g = await getGrid(q.shake);
      if (!S.quakeMode) return;
      const [w, s, e, n] = g.bounds;
      const img = renderGrid(g, colourFn(scale), { smooth: S.settings.smooth !== false, fill: 0 });
      L.imageOverlay(img.toDataURL('image/png'), [[s, w], [n, e]], { opacity: Math.min(0.85, S.settings.opacity + 0.1), interactive: false, className: 'wx-grid shake', pane: 'shake' }).addTo(S.focus);
    } catch (e) {
      console.warn('shakemap', e);
    }
  }
}

// ------------------------------------------------------------------ typhoon
export function showTyphoon() {
  const ty = S.typhoon;
  if (!ty || !ty.active) { openSheet('颱風', html`<p>目前沒有颱風警報。</p>`); return; }
  const t = ty.tables || {};
  const rainTable = (tbl) => {
    if (!tbl) return '';
    const by = {};
    tbl.areas.forEach((a) => { by[a.area] = by[a.area] || {}; by[a.area][a.region] = a.value; });
    return html`<p class="muted">${tbl.period || ''}・發布 ${fmtTime(tbl.issue)}</p><div class="scroll"><table class="kv"><thead><tr><th scope="col">縣市</th><th scope="col">平地</th><th scope="col">山區</th></tr></thead><tbody>
${Object.entries(by).map(([k, v]) => html`<tr><th scope="row">${k}</th><td>${v.flat || '—'}</td><td>${v.mountain || '—'}</td></tr>`)}</tbody></table></div>${tbl.note ? html`<p class="note">${tbl.note}</p>` : ''}`;
  };
  const windTable = (tbl) => {
    if (!tbl) return '';
    const periods = tbl.areas[0]?.periods || [];
    return html`<p class="muted">蒲福風級（平均風／陣風）・發布 ${fmtTime(tbl.issue)}</p><div class="scroll"><table class="fc"><thead><tr><th scope="col">地區</th>${periods.map((p) => html`<th scope="col">${fmtTime(p.start)}–${fmtTime(p.end, { date: false })}</th>`)}</tr></thead><tbody>
${tbl.areas.map((a) => html`<tr><th scope="row">${a.area}</th>${a.periods.map((p) => html`<td>${p.average?.level || '—'}<br><small>陣風 ${p.gust?.level || '—'}</small></td>`)}</tr>`)}</tbody></table></div>`;
  };
  const tcs = ty.cyclones.map((c) => {
    const cur = c.past[c.past.length - 1];
    return html`<section class="card"><h3>第 ${c.no || '?'} 號颱風 ${c.cname}（${c.name}）</h3>
${cur ? html`<p>${fmtTime(cur.t)} 位置 ${cur.lat}°N ${cur.lon}°E・中心氣壓 ${cur.p} hPa・最大風速 ${cur.ws} m/s（陣風 ${cur.gs}）・${cur.mv || ''} ${cur.ms ?? ''} km/h</p>` : ''}
<div class="scroll"><table class="kv"><thead><tr><th scope="col">預報時間</th><th scope="col">位置</th><th scope="col">風速/陣風</th><th scope="col">7級風半徑</th><th scope="col">70%機率半徑</th></tr></thead><tbody>
${c.fcst.map((f) => html`<tr><th scope="row">+${f.h}h</th><td>${f.lat}, ${f.lon}</td><td>${f.ws}/${f.gs} m/s</td><td>${f.r15 ?? '—'} km</td><td>${f.r70 ?? '—'} km</td></tr>`)}</tbody></table></div></section>`;
  });
  const body = html`${tcs}
${ty.warnings.map((w) => html`<section class="card warn"><h3>${w.title}</h3><p class="muted">發布 ${fmtTime(w.issue)}</p><details><summary>警報全文</summary><pre class="text">${w.text}</pre></details></section>`)}
${t.rain24 ? html`<section class="card"><h3>各地區 24 小時雨量預測</h3>${rainTable(t.rain24)}<button class="btn" data-tylayer="0">在地圖上顯示</button></section>` : ''}
${t.rainTotal ? html`<section class="card"><h3>各地區總雨量預測</h3>${rainTable(t.rainTotal)}<button class="btn" data-tylayer="1">在地圖上顯示</button></section>` : ''}
${t.wind ? html`<section class="card"><h3>各地區風力預測</h3>${windTable(t.wind)}</section>` : ''}
${ty.tablesRestricted ? html`<section class="card"><h3>各地區風力、24 小時雨量與總雨量預測</h3>
<p>這些預測表附有中央氣象署著作權聲明（未經書面授權不得轉載），本網站不直接顯示。</p>
<p><a class="btn" href="${ty.tablesLink}" target="_blank" rel="noopener">到中央氣象署颱風消息查看</a></p></section>` : ''}
<p class="src">資料來源：中央氣象署颱風消息與警報、颱風各地區風雨預測。</p>`;
  openSheet('颱風資訊', body, {
    onRender: (root) => {
      bindCommon(root);
      root.querySelectorAll('[data-tylayer]').forEach((b) => b.addEventListener('click', () => {
        S.layer.period = Number(b.dataset.tylayer);
        S.settings.layer = 'tyrain';
        showLayer('tyrain', { keepFrame: true });
      }));
    },
  });
}

// ------------------------------------------------------------------ alerts overview
export function showAlerts() {
  const w = S.warnings || { counties: [], bulletins: [] };
  const withHz = w.counties.filter((c) => c.hazards.length);
  const body = html`
${S.typhoon?.active ? html`<section class="card warn"><h3>🌀 颱風警報</h3><p>${S.typhoon.cyclones.map((c) => `${c.cname}（${c.name}）`).join('、')}</p><button class="btn" data-open="typhoon">颱風路徑與風雨預測</button></section>` : ''}
<section class="card"><h3>各縣市警特報</h3>${withHz.length ? html`<table class="kv"><tbody>${withHz.map((c) => html`<tr><th scope="row">${c.county}</th><td>${c.hazards.map((h) => `${h.ph}${h.sig}`).join('、')}</td></tr>`)}</tbody></table>` : html`<p>目前沒有生效中的警特報。</p>`}</section>
${w.bulletins.map((b) => html`<section class="card"><h3>${b.title}</h3><p class="muted">發布 ${fmtTime(b.issue)}・至 ${fmtTime(b.end)}</p><details><summary>全文</summary><pre class="text">${b.text || ''}</pre></details></section>`)}
<p class="note">地震另有獨立的「地震」提示（24 小時內有地震時顯示）。<button class="link inline" id="btn-allq">查看所有地震報告</button></p>`;
  openSheet('警特報與災害', body, {
    onRender: (root) => { bindCommon(root); root.querySelector('#btn-allq').addEventListener('click', () => showQuakes()); },
  });
}

// ------------------------------------------------------------------ recent & favourites
export async function showRecent({ replace = false } = {}) {
  const [rec, fav] = await Promise.all([listRecent(), listFav()]);
  const item = (x, kind) => html`<li class="row-del"><span class="grow"><button class="link" data-rid="${x.id}" data-kind="${kind}">${x.title}</button>
<span class="meta">${kind === 'recent' ? `查詢於 ${fmtTime(x.savedAt)}` : `${x.lat.toFixed(3)}, ${x.lon.toFixed(3)}`}</span></span>
<button class="icon-btn del" data-del="${x.id}" data-kind="${kind}" aria-label="${kind === 'recent' ? '刪除這筆查詢紀錄' : '取消收藏'}：${x.title}" title="${kind === 'recent' ? '刪除' : '取消收藏'}"><span aria-hidden="true">✕</span></button></li>`;
  const body = html`<section class="card"><h3>收藏地點</h3>${fav.length ? html`<ul class="list">${fav.map((x) => item(x, 'fav'))}</ul>` : html`<p>尚無收藏。查詢地點後按面板右上角的 ☆，或在搜尋結果旁按 ☆。</p>`}</section>
<section class="card"><h3>最近查詢（可離線瀏覽）</h3>${rec.length ? html`<ul class="list">${rec.map((x) => item(x, 'recent'))}</ul>
<button class="btn" id="btn-clear-recent">清空最近查詢（${rec.length} 筆）</button>` : html`<p>尚無紀錄。</p>`}</section>
<p class="note">最近 40 筆查詢會保存在此裝置，沒有網路時仍可開啟當時的資料快照。清空最近查詢不會影響收藏。</p>`;
  openSheet('收藏與最近查詢', body, {
    replace,
    onRender: (root) => {
      root.querySelectorAll('[data-rid]').forEach((b) => b.addEventListener('click', async () => {
        const entry = b.dataset.kind === 'recent' ? await getRecent(b.dataset.rid) : fav.find((f) => f.id === b.dataset.rid);
        if (!entry) return;
        if (navigator.onLine || !entry.html) {
          flyTo(entry.lat, entry.lon);
          showPoint(entry.lat, entry.lon, { label: entry.title, spotKey: entry.spotKey, stationId: entry.stationId, peak: S.peaks.find((p) => p.k === entry.peakKey) });
          return;
        }
        showSnapshot(entry);
      }));
      root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        if (b.dataset.kind === 'recent') await deleteRecent(b.dataset.del); else await deleteFav(b.dataset.del);
        showRecent({ replace: true });
      }));
      root.querySelector('#btn-clear-recent')?.addEventListener('click', async () => {
        if (!window.confirm(`確定要清空 ${rec.length} 筆最近查詢紀錄嗎？收藏地點會保留。`)) return;
        await clearRecent();
        showRecent({ replace: true });
      });
    },
  });
}

export function showSnapshot(entry) {
  const body = html`<p class="offline-note" role="note">離線快照：${fmtTime(entry.savedAt)} 查詢（資料版本 ${fmtTime(entry.dataTime)}）。內容不會更新。</p>${raw(entry.html)}`;
  openSheet(`${entry.title}（離線）`, body, { onRender: (root) => { bindTabs(root); bindCards(root); } });
  if (S.map) S.map.setView([entry.lat, entry.lon], Math.max(S.map.getZoom(), 11));
}

// ------------------------------------------------------------------ affected mountains
export async function showAffected() {
  const id = S.layer.id;
  const def = layerDef(id);
  if (id === 'wind' || id === 'lightning') { await showAffectedPoints(id); return; }
  const frames = framesFor(id);
  const path = PERIOD_LAYERS.includes(id) ? frames[S.layer.period] : frames[S.layer.frame] || frames[frames.length - 1];
  if (!path) { openSheet('受影響山區', html`<p>請先選擇雷達、雨量、降水預報或溫度圖層。</p>`); return; }
  openSheet('受影響山區', loading);
  const grid = await getGrid(path);
  const kind = layerKind(id);
  if (kind === 'vis') { openSheet('受影響山區', html`<p>可見光反照率不適合用來篩選，請改用紅外線雲圖或雨量圖層。</p>`, { replace: true }); return; }
  const lower = kind === 'temp' || kind.startsWith('ir'); // colder = more severe
  const defaults = { radar: 30, rain: 10, rainacc: 50, temp: 5, irgray: -40, irenh: -40 };
  const render = (cat, thr) => {
    const items = S.spots.filter((s) => cat === 'all' || s.c === cat)
      .map((s) => ({ s, v: sample(grid, s.lat, s.lon) }))
      .filter((x) => x.v !== null && (lower ? x.v <= thr : x.v >= thr))
      .sort((a, b) => (lower ? a.v - b.v : b.v - a.v));
    const cats = [{ id: 'mountain', label: '登山' }, { id: 'all', label: '全部景點' }];
    return html`<p>${def.label}（${fmtTime(grid.meta.start || grid.meta.time)}）${lower ? '≤' : '≥'}
<input id="aff-thr" type="number" inputmode="decimal" value="${thr}" aria-label="門檻值" class="num"> ${grid.meta.unit || def.unit}</p>
<div class="seg" role="radiogroup" aria-label="類別">${cats.map((c) => html`<button class="seg-btn" role="radio" aria-checked="${c.id === cat}" data-cat="${c.id}">${c.label}</button>`)}</div>
<p class="muted">共 ${items.length} 處</p>
<ul class="list">${items.slice(0, 200).map((x) => html`<li><button class="link" data-spot="${x.s.k}">${x.s.n}</button> <span class="meta">${grid.meta.kind === 'class' ? `${x.v}+` : fmtNum(x.v)} ${grid.meta.unit || def.unit}</span></li>`)}</ul>`;
  };
  let cat = 'mountain';
  let thr = defaults[kind] ?? 10;
  const draw = () => openSheet('受影響山區', render(cat, thr), {
    replace: true,
    onRender: (root) => {
      bindCommon(root);
      root.querySelectorAll('[data-cat]').forEach((b) => b.addEventListener('click', () => { cat = b.dataset.cat; draw(); }));
      root.querySelector('#aff-thr').addEventListener('change', (e) => { thr = Number(e.target.value); draw(); });
    },
  });
  draw();
}

/** Affected mountains for the point layers: hiking-forecast wind (Beaufort ≥ threshold) or lightning within 10 km. */
async function showAffectedPoints(id) {
  let items = [];
  let head = '';
  if (id === 'wind') {
    const w = await loadWind();
    const i = Math.min(S.layer.frame, (w?.times.length || 1) - 1);
    const thr = 6;
    items = (w?.mountains || []).filter((m) => (m.w[1][i] ?? 0) >= thr).sort((a, b) => b.w[1][i] - a.w[1][i])
      .map((m) => ({ k: m.k, n: m.n, meta: `${WIND_DIRS[m.w[2][i]] || ''} ${m.w[0][i]} m/s・${m.w[1][i]}級` }));
    head = `登山預報風力 ≥ ${thr} 級（${w ? fmtTime(w.times[i]) : ''} 起 3 小時）`;
  } else {
    items = S.spots.filter((p) => p.c === 'mountain').map((p) => ({ p, lt: lightningNear(p.lat, p.lon, 10) }))
      .filter((x) => x.lt.n).sort((a, b) => a.lt.nearest - b.lt.nearest)
      .map(({ p, lt }) => ({ k: p.k, n: p.n, meta: `${lt.n} 次・最近 ${lt.nearest.toFixed(1)} km` }));
    head = '過去 1 小時 10 km 內有閃電的山';
  }
  openSheet('受影響山區', html`<p>${head}</p><p class="muted">共 ${items.length} 處</p>
<ul class="list">${items.map((x) => html`<li><button class="link" data-spot="${x.k}">${x.n}</button> <span class="meta">${x.meta}</span></li>`)}</ul>`, { onRender: bindCommon });
}

// ------------------------------------------------------------------ search
/** Peak subtitle in search results: township (same-name peaks are common) and list tags. */
function peakSub(p) {
  return [p.area, ...(p.tags || []).map((t) => S.peakLists[t] || t)].filter(Boolean).join('・');
}

export function search(q) {
  const s = q.trim();
  if (!s) return [];
  const res = [];
  S.spots.forEach((x) => { if (x.n.includes(s)) res.push({ type: x.c === 'mountain' ? '山' : '景點', label: `${x.n}${x.ele ? `（${x.ele} m）` : ''}`, sub: [x.a, x.c === 'mountain' ? '有登山預報' : S.spotCats.find((c) => c.id === x.c)?.label].filter(Boolean).join('・'), lat: x.lat, lon: x.lon, spot: x.k }); });
  S.peaks.forEach((x) => { if (x.n.includes(s)) res.push({ type: '山', label: `${x.n}${x.ele ? `（${eleText(x)}）` : ''}`, sub: peakSub(x), lat: x.lat, lon: x.lon, peak: x }); });
  S.stations.forEach((x) => { if (x.n && x.n.includes(s)) res.push({ type: '測站', label: `${x.n}（${x.county || ''}${x.town || ''}）`, lat: x.lat, lon: x.lon, station: x.id }); });
  S.towns.forEach((f) => {
    const p = f.properties;
    const name = `${normCounty(p.COUNTYNAME)}${p.TOWNNAME}`;
    if (name.includes(s)) {
      const [w, so, e, n] = f.bbox;
      res.push({ type: '鄉鎮', label: name, lat: (so + n) / 2, lon: (w + e) / 2 });
    }
  });
  // Exact name first, then prefix matches, then substring matches; mountains before other types.
  const rank = (r) => {
    const name = r.label.replace(/（.*$/, '');
    const m = name === s ? 0 : name.startsWith(s) ? 1 : 2;
    return m * 10 + (r.type === '山' ? 0 : r.type === '鄉鎮' ? 1 : r.type === '景點' ? 2 : 3);
  };
  res.sort((a, b) => rank(a) - rank(b));
  const coord = s.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (coord) res.unshift({ type: '座標', label: s, lat: Number(coord[1]), lon: Number(coord[2]) });
  return res.slice(0, 30);
}

// ------------------------------------------------------------------ sources & licence
const DATASETS = [
  ['O-A0001-001', '自動氣象站－氣象觀測資料'], ['O-A0002-001', '自動雨量站－雨量觀測資料'], ['O-A0003-001', '現在天氣觀測報告'],
  ['O-A0059-001', '雷達整合回波格點資料'], ['O-A0039-001', '閃電即時觀測'], ['O-B0045-001', '雷達定量降水估計（QPESUMS）'], ['F-B0046-001', '雷達定量降水預報（未來1小時）'],
  ['O-A0040-004', '日累積雨量格點資料'], ['O-A0038-003', '溫度分析格點資料'],
  ['F-C0035-015／017／023／024', '定量降水預報圖（I～IV，逐12小時）'], ['F-C0041-001～008', '定量降水格點預報（颱風警報期間，逐6小時）'],
  ['F-B0053-xxx', '育樂天氣預報（登山、國家公園、森林遊樂區、農場、水庫等14類）'], ['F-D0047-xxx', '鄉鎮天氣預報'],
  ['E-A0015-001／E-A0016-001', '顯著有感／小區域有感地震報告'], ['E-A0015-003', '等震度圖'],
  ['W-C0034-005', '颱風消息與警報－熱帶氣旋路徑'], ['W-C0033-001／002', '天氣特報'],
  ['O-B0055-001／O-B0056-001', '東亞可見光反照率／紅外線亮度溫度資料'], ['O-C0042-xxx', '台灣衛星雲圖'],
  ['C-B0024-001', '過去氣象觀測'], ['history/Observation', '逐時觀測歷史快照（開放資料 S3）'],
];

export function showSources() {
  const year = (S.manifest?.built || '').slice(0, 4);
  const body = html`<section class="card"><h3>顯名聲明</h3>
<p><strong>中央氣象署 ${year} 開放資料</strong>（各資料集與版本如下，版本以發布時間為準）</p>
<p>${OGDL_TEXT}</p>
<p>政府資料開放授權條款：<a href="${OGDL_URL}" target="_blank" rel="noopener">${OGDL_URL}</a></p></section>
<section class="card"><h3>使用的資料集</h3><table class="kv"><tbody>${DATASETS.map(([id, name]) => html`<tr><th scope="row">${id}</th><td>${name}</td></tr>`)}</tbody></table>
<p class="muted">資料取自中央氣象署開放資料（https://opendata.cwa.gov.tw，及其官方 S3 鏡像）。本網站資料更新：${fmtTime(S.manifest?.built)}</p></section>
<section class="card"><h3>本網站的加工與衍生資料</h3><ul>
<li>定量降水預報圖、等震度圖：由圖片自動對位並依圖例顏色換算回數值級距。</li>
<li>逐 6 小時定量降水預報：取自中央氣象署全球資訊網（https://www.cwa.gov.tw/V8/C/P/QPF.html），依<a href="https://www.cwa.gov.tw/V8/C/information.html" target="_blank" rel="noopener">政府網站資料開放宣告</a>註明出處引用；颱風警報期間若網站圖無法取得，改用開放資料 F-C0041。</li>
<li>未來 24／48 小時累積降水：將各 12 小時預報加總計算，<strong>非中央氣象署發布之預報</strong>，未經中央氣象署審閱。</li>
<li>多時段累積雨量：由雨量站觀測值以距離權重內插估計。</li>
<li>衛星雲圖：由亮度溫度／反照率數值重新著色並平滑顯示。</li>
<li>登山安全評估：本網站依門檻自動判斷，僅供參考，並非氣象預報或警報。</li></ul>
<p class="note">颱風各地區風力、24小時雨量與總雨量預測表附有中央氣象署著作權聲明，未取得授權前本網站不顯示。</p></section>
<section class="card"><h3>其他來源</h3><ul>
<li>行政區界：taiwan-atlas（MIT），資料來源內政部。</li>
<li>底圖：OpenTopoMap（CC-BY-SA）、© OpenStreetMap contributors（ODbL）、內政部國土測繪中心、OpenCycleMap／Landscape／Outdoors（Maps © Thunderforest）。</li>
<li>陣風預報：<a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a> 數值模式（CC BY 4.0），非中央氣象署發布；體感溫度：氣象署預報值，測站體感為依溫度、濕度、風速以氣象署公式估算（含山頭海拔估算：Copernicus DEM 90 m 地形模型）。</li>
<li>山頭（非氣象署登山預報點）：© OpenStreetMap contributors，依開放資料庫授權（ODbL 1.0）使用，每週更新；點選時顯示鄰近鄉鎮預報。</li>
<li>地圖程式庫：Leaflet（BSD-2）、topojson-client（ISC）。</li></ul></section>`;
  openSheet('資料來源與授權', body);
}
