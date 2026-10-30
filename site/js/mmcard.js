// Point card "模式對照": the models of the multi-model layer side by side at one place (first five days).
import { esc } from './util.js';
import { chart, dataTable } from './chart.js';
import { mmSeriesAt } from './layers.js';

const VARS = [
  { id: 'temp', label: '氣溫', title: '2 m 氣溫', unit: '°C' },
  { id: 'rain', label: '降雨', title: '6 小時雨量', unit: 'mm', zeroBase: true },
  { id: 'wind', label: '風速', title: '10 m 風速', unit: 'm/s', zeroBase: true },
  { id: 'msl', label: '氣壓', title: '海平面氣壓', unit: 'hPa' },
];
const WARN = { temp: '25 km 網格的地形比實際平滑，山區氣溫偏高；WRF 3 km 也與實際海拔不同。', rain: '各模式的降雨位置與強度差異大，只適合看趨勢。', wind: '山區與稜線的實際風速可能更強。', msl: '山區的海平面氣壓是換算值。' };

/** Chart of the models of one variable; the union of their times is the axis. */
export function mmCompareChart(series, v) {
  const def = VARS.find((x) => x.id === v) || VARS[0];
  if (!series.length) return `<p class="muted">${esc(def.title)}：目前沒有模式資料</p>`;
  const times = [...new Set(series.flatMap((s) => s.times))].sort((a, b) => new Date(a) - new Date(b));
  const rows = series.map((s) => ({ ...s, aligned: times.map((t) => { const i = s.times.findIndex((x) => new Date(x).getTime() === new Date(t).getTime()); return i < 0 ? null : s.values[i]; }) }));
  return chart({ title: def.title, unit: def.unit, times, zeroBase: Boolean(def.zeroBase), series: rows.map((s) => ({ label: s.label, values: s.aligned, kind: 'line', cls: s.cls })) })
    + dataTable(times, rows.map((s) => ({ label: s.label, values: s.aligned }))) + `<p class="note note-red">${esc(WARN[v])}</p>`;
}

export function mmCompareCard() {
  return `<section class="card" aria-labelledby="h-mmc"><h3 id="h-mmc">模式對照</h3>
<div class="seg mm-card-tabs" role="radiogroup" aria-label="項目">${VARS.map((x, i) => `<button class="seg-btn" role="radio" data-mmc="${x.id}" aria-checked="${i === 0}">${x.label}</button>`).join('')}</div>
<button class="btn" id="btn-mmc">載入模式對照</button><div id="mmc-out" aria-live="polite"></div></section>`;
}

export function bindMmCompare(root, lat, lon) {
  const b = root.querySelector('#btn-mmc');
  if (!b) return;
  const out = root.querySelector('#mmc-out');
  let cur = 'temp';
  const load = async () => {
    b.disabled = true;
    out.innerHTML = '<p class="loading" role="status">載入模式對照…</p>';
    try {
      out.innerHTML = mmCompareChart(await mmSeriesAt(lat, lon, cur), cur);
    } catch (e) {
      out.innerHTML = `<p class="warn-txt">模式對照載入失敗（${esc(e.message)}）。</p>`;
    }
    b.disabled = false;
  };
  b.addEventListener('click', load);
  root.querySelectorAll('[data-mmc]').forEach((t) => t.addEventListener('click', () => {
    cur = t.dataset.mmc;
    root.querySelectorAll('[data-mmc]').forEach((x) => x.setAttribute('aria-checked', String(x === t)));
    if (out.innerHTML) load();
  }));
}
