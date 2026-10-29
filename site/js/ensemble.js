// Ensemble forecast at a point (Open-Meteo ensemble API: ECMWF IFS 0.25° 51 members, NCEP GEFS 0.25°), fetched by the browser on request.
import { esc, html } from './util.js';
import { chart, dataTable } from './chart.js';

const API = 'https://ensemble-api.open-meteo.com/v1/ensemble';
export const MODELS = [
  { id: 'ecmwf_ifs025', label: 'ECMWF', cls: 's1' },
  { id: 'gfs025', label: 'GFS', cls: 's3' },
];
const VARS = ['temperature_2m', 'precipitation', 'wind_speed_10m'];
const LAPSE = 0.0065; // °C per metre

/** p-th percentile (0..1) of a list of numbers (linear interpolation); null when empty. */
export function percentile(list, p) {
  const v = list.filter((x) => x !== null && x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const k = (v.length - 1) * p;
  const lo = Math.floor(k);
  return v[lo] + (v[Math.min(lo + 1, v.length - 1)] - v[lo]) * (k - lo);
}

/**
 * Members of one variable in an Open-Meteo ensemble response: the control run and every `<var>_memberNN` array.
 * (Each model is requested on its own, so the keys carry no model suffix; extra suffixes are tolerated.)
 */
export function members(hourly, name) {
  return Object.keys(hourly).filter((k) => (k === name || k.startsWith(`${name}_member`)) && Array.isArray(hourly[k])).map((k) => hourly[k]);
}

/** Spread per time step: { p10, p50, p90, n } from the members. `shift` is added to every value. */
export function spread(hourly, name, shift = 0) {
  const ms = members(hourly, name);
  const n = (hourly.time || []).length;
  const out = { p10: [], p50: [], p90: [], n: ms.length };
  for (let i = 0; i < n; i++) {
    const col = ms.map((m) => (m[i] === null || m[i] === undefined ? null : m[i] + shift));
    out.p10.push(percentile(col, 0.1)); out.p50.push(percentile(col, 0.5)); out.p90.push(percentile(col, 0.9));
  }
  return out;
}

/** Cumulative precipitation of every member, then the spread of the totals per time step. */
export function cumulative(hourly) {
  const ms = members(hourly, 'precipitation').map((m) => { let s = 0; return m.map((v) => { s += v ?? 0; return s; }); });
  const n = (hourly.time || []).length;
  const out = { p10: [], p50: [], p90: [], n: ms.length };
  for (let i = 0; i < n; i++) {
    const col = ms.map((m) => m[i]);
    out.p10.push(percentile(col, 0.1)); out.p50.push(percentile(col, 0.5)); out.p90.push(percentile(col, 0.9));
  }
  return out;
}

const r1 = (a) => a.map((v) => (v === null ? null : Math.round(v * 10) / 10));

export async function fetchModel(lat, lon, model, fetchFn = fetch) {
  const q = new URLSearchParams({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), hourly: VARS.join(','), models: model, timezone: 'Asia/Taipei',
    wind_speed_unit: 'ms', forecast_days: '10' });
  const res = await fetchFn(`${API}?${q}`);
  if (!res.ok) throw new Error(`${model}: HTTP ${res.status}`);
  return res.json();
}

/** Load both models; a model that fails is left out. ele: elevation of the place (m) for the temperature correction. */
export async function loadEnsemble(lat, lon, ele = null, fetchFn = fetch) {
  const res = await Promise.allSettled(MODELS.map((m) => fetchModel(lat, lon, m.id, fetchFn)));
  const out = [];
  res.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value?.hourly?.time) return;
    const d = r.value;
    const shift = ele !== null && typeof d.elevation === 'number' ? (d.elevation - ele) * LAPSE : 0; // model cell is higher -> colder at the place
    out.push({ ...MODELS[i], times: d.hourly.time.map((t) => `${t}:00+08:00`), modelElevation: d.elevation, shift,
      temp: spread(d.hourly, 'temperature_2m', shift), wind: spread(d.hourly, 'wind_speed_10m'), rain: cumulative(d.hourly) });
  });
  return out;
}

/** Charts for the loaded models; the longest time axis is used, shorter models are padded with gaps. */
export function ensembleCharts(models) {
  if (!models.length) return '<p class="muted">系集預報暫時無法取得。</p>';
  const base = models.reduce((a, b) => (b.times.length > a.times.length ? b : a));
  // Plot every 3rd hour: enough for the shape, far fewer points.
  const idx = base.times.map((_, i) => i).filter((i) => i % 3 === 0);
  const times = idx.map((i) => base.times[i]);
  const lines = (key, nd) => models.flatMap((m) => {
    const pick = (a) => idx.map((i) => (m.times[i] === base.times[i] && a[i] !== undefined ? a[i] : null));
    const s = m[key];
    return [
      { label: `${m.label} 中位數（${s.n} 個成員）`, values: pick(r1(s.p50)), kind: 'line', cls: m.cls },
      { label: `${m.label} 10–90%`, values: pick(r1(s.p10)), kind: 'line', cls: m.cls, dash: true },
      { label: '', values: pick(r1(s.p90)), kind: 'line', cls: m.cls, dash: true, noLegend: true },
    ];
  });
  const cols = (key) => models.flatMap((m) => [{ label: `${m.label} 中位`, values: idx.map((i) => m[key].p50[i] === undefined ? null : Math.round(m[key].p50[i] * 10) / 10) },
    { label: `${m.label} 10%`, values: idx.map((i) => m[key].p10[i] === undefined ? null : Math.round(m[key].p10[i] * 10) / 10) },
    { label: `${m.label} 90%`, values: idx.map((i) => m[key].p90[i] === undefined ? null : Math.round(m[key].p90[i] * 10) / 10) }]);
  return chart({ title: '溫度', unit: '°C', times, series: lines('temp') }) + dataTable(times, cols('temp'))
    + chart({ title: '累積降雨', unit: 'mm', times, zeroBase: true, series: lines('rain') }) + dataTable(times, cols('rain'))
    + chart({ title: '10 公尺風速', unit: 'm/s', times, zeroBase: true, series: lines('wind') }) + dataTable(times, cols('wind'));
}

/** Card with a load button; call bindEnsemble(root, lat, lon, ele) after rendering. */
export function ensembleCard() {
  return html`<section class="card" aria-labelledby="h-ens"><h3 id="h-ens">系集預報（10 天）</h3>
<p class="note">同一個預報模式用略有差異的起始條件跑出數十個結果，結果越分散代表不確定性越大。實線為中位數，虛線為 10–90% 範圍。
資料來自 Open-Meteo 的 ECMWF IFS（51 成員）與 GFS（GEFS）系集，由您的瀏覽器直接連線取得（CC BY 4.0），非氣象署發布。</p>
<p class="note note-red">模式解析度約 25 km，山區僅供趨勢參考。</p>
<button class="btn" id="btn-ens">載入系集預報</button><div id="ens-out" aria-live="polite"></div></section>`;
}

export function bindEnsemble(root, lat, lon, ele = null) {
  const b = root.querySelector('#btn-ens');
  if (!b) return;
  // Shortcut at the top of the panel: scroll to the card and load the forecast.
  // (delegated: the chip row is rebuilt when the slower data arrives, which would drop a listener on the button itself)
  root.addEventListener('click', (ev) => {
    if (!ev.target.closest('#btn-ens-jump')) return;
    const c = root.querySelector('#h-ens')?.closest('details.pcard');
    if (c) c.open = true;
    root.querySelector('#h-ens')?.scrollIntoView({ block: 'start' });
    if (!b.disabled && !root.querySelector('#ens-out figure')) b.click();
  });
  b.addEventListener('click', async () => {
    const out = root.querySelector('#ens-out');
    b.disabled = true;
    out.innerHTML = '<p class="loading" role="status">載入系集預報…</p>';
    try {
      const models = await loadEnsemble(lat, lon, ele);
      const note = models.filter((m) => m.shift).map((m) => `${m.label} 模式格點高度 ${Math.round(m.modelElevation)} m`).join('、');
      out.innerHTML = ensembleCharts(models) + (note && ele !== null ? `<p class="note">溫度已依海拔差（${esc(note)}，此處約 ${Math.round(ele)} m）以每 100 m 0.65°C 修正。</p>` : '');
    } catch (e) {
      out.innerHTML = `<p class="warn-txt">系集預報載入失敗（${esc(e.message)}）。</p>`;
    }
    b.disabled = false;
  });
}
