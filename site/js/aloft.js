// Winds aloft, visibility, UV and freezing level (Open-Meteo models) and sun times, as cards for the point panel.
import { S } from './state.js';
import { getJSON, fmtTime, esc, beaufort, haversineKm, html, raw } from './util.js';
import { sunTimes, twDate, dayLength } from './sun.js';

const DIRS = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
export const WIND_DIR8 = DIRS;

export async function loadAloft() {
  if (!S.aloft) S.aloft = await getJSON('aloft.json', { optional: true });
  return S.aloft;
}

/** Index of the forecast step that contains now (the first one not yet ended); 3-hour steps. */
export function nowStep(times) {
  const now = Date.now();
  const i = times.findIndex((t) => new Date(t).getTime() + 3 * 3600e3 > now);
  return i < 0 ? times.length - 1 : i;
}

/** Index in `times` of the step equal to (or nearest) the ISO time `t`. */
export function stepOf(times, t) {
  const ms = new Date(t).getTime();
  let best = 0;
  times.forEach((x, i) => { if (Math.abs(new Date(x).getTime() - ms) < Math.abs(new Date(times[best]).getTime() - ms)) best = i; });
  return best;
}

/** Compass name (8 points) of a direction the wind comes from, in degrees. */
export function compass(deg) { return `${DIRS[Math.round((deg % 360) / 45) % 8]}風`; }

const num = (v, nd = 0) => (v === null || v === undefined ? '—' : Number(v).toFixed(nd));
const max = (a) => { const v = a.filter((x) => x !== null && x !== undefined); return v.length ? Math.max(...v) : null; };
const min = (a) => { const v = a.filter((x) => x !== null && x !== undefined); return v.length ? Math.min(...v) : null; };

/** Typical altitude of a pressure level at this point: the median of its forecast geopotential heights. */
export function levelAlt(p, li) {
  const v = (p.z[li] || []).filter((x) => x !== null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
}

/** Round to 100 m for display: "約 1,500 m". */
export function altText(m) { return m === null ? '—' : `約 ${(Math.round(m / 100) * 100).toLocaleString('en-US')} m`; }

/**
 * Card with the wind on pressure levels, visibility, UV and freezing level for a mountain forecast point.
 * `ele` is the elevation of the place the user looked up (to mark the closest level); `note` says whose data it is.
 */
export function aloftCard(a, key, { ele = null, note = '' } = {}) {
  const p = a?.points?.[key];
  if (!p) return '';
  const i0 = nowStep(a.times);
  const n8 = Math.min(i0 + 8, a.times.length); // next 24 hours
  const rows = a.levels.map((lv, li) => {
    const alt = levelAlt(p, li);
    const ws = p.ws[li][i0]; const wd = p.wd[li][i0];
    const mx = max(p.ws[li].slice(i0, n8));
    const near = ele !== null && alt !== null && a.levels.every((_, lj) => Math.abs((levelAlt(p, lj) ?? 1e9) - ele) >= Math.abs(alt - ele));
    const bf = ws === null ? '' : `<br><small>${beaufort(ws)}級</small>`;
    return `<tr${near ? ' class="hl"' : ''}><th scope="row">${esc(altText(alt))}<br><span class="hpa">${lv} hPa</span>${near ? '<span class="sr-only">最接近此處</span>' : ''}</th>
<td>${wd === null ? '—' : esc(compass(wd))}</td><td>${num(ws)} m/s${bf}</td><td>${num(mx)} m/s${mx === null ? '' : `<br><small>${beaufort(mx)}級</small>`}</td></tr>`;
  }).join('');
  const vis = p.vis.slice(i0, n8); const uv = p.uv.slice(i0, n8 + 0);
  const fz = p.fz[i0];
  const visMin = min(vis);
  const fog = visMin !== null && visMin < 1 ? '（濃霧）' : visMin !== null && visMin < 2 ? '（有霧）' : '';
  return html`<section class="card" aria-labelledby="h-aloft"><h3 id="h-aloft">高空風、能見度、紫外線</h3>
${note ? html`<p class="note">${note}</p>` : ''}
<table class="kv aloft"><thead><tr><th scope="col">海拔／氣壓層</th><th scope="col">風向</th><th scope="col">現在風速</th><th scope="col">24 小時內最大</th></tr></thead><tbody>${raw(rows)}</tbody></table>
<table class="kv"><tbody>
<tr><th scope="row">能見度（模式）</th><td>現在 ${num(p.vis[i0], 1)} km</td><td>24 小時內最低 ${num(visMin, 1)} km${fog}</td></tr>
<tr><th scope="row">紫外線指數（模式）</th><td>24 小時內最高 ${num(max(uv), 1)}</td><td></td></tr>
<tr><th scope="row">凍結高度</th><td colspan="2">${fz === null ? '—' : `${Math.round(fz).toLocaleString('en-US')} m`}（0°C 所在高度，高於此處的降雨會變成雪或冰）</td></tr></tbody></table>
<p class="note">高空風、能見度、紫外線與凍結高度為 Open-Meteo 數值模式預報（${fmtTime(a.time)} 取得，CC BY 4.0），非氣象署發布；山區實際能見度受雲霧與地形影響，模式只能參考。高度為氣壓層在此處的概略高度。</p></section>`;
}

/** Sun times table for today and the next two days at a place. */
export function sunCard(lat, lon, ele = null) {
  const [y, m, d] = twDate();
  const rows = [0, 1, 2].map((k) => {
    const dt = new Date(Date.UTC(y, m - 1, d + k));
    const s = sunTimes(lat, lon, dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
    if (!s) return '';
    const label = k === 0 ? '今天' : `${dt.getUTCMonth() + 1}/${dt.getUTCDate()}`;
    return `<tr><th scope="row">${label}</th><td>${s.dawn}</td><td>${s.rise}</td><td>${s.set}</td><td>${s.dusk}</td></tr>`;
  }).join('');
  if (!rows) return '';
  const t = sunTimes(lat, lon, y, m, d);
  // Elevated place with an open horizon: sunrise earlier, sunset later (only shown above 300 m, where it is 2 minutes or more).
  const hi = ele && ele >= 300 ? sunTimes(lat, lon, y, m, d, ele) : null;
  const hiRow = hi ? `<tr><th scope="row">今天<br><small>海拔 ${Math.round(ele).toLocaleString('en-US')} m 視野開闊</small></th><td>${hi.dawn}</td><td>${hi.rise}</td><td>${hi.set}</td><td>${hi.dusk}</td></tr>` : '';
  return html`<section class="card" aria-labelledby="h-sun"><h3 id="h-sun">日出日沒</h3>
<table class="kv sun"><thead><tr><th scope="col"></th><th scope="col">天亮</th><th scope="col">日出</th><th scope="col">日沒</th><th scope="col">天黑</th></tr></thead><tbody>${raw(rows + hiRow)}</tbody></table>
<p class="note">日照 ${dayLength(t.dayMin)}。天亮／天黑為民用曙暮光（太陽在地平線下 6°，不用頭燈大致可行走）；上表為海平面高度；山頂視野開闊時地平線下沉，日出較早、日沒較晚（海拔列，依高度計算）。依經緯度與海拔天文計算，誤差約 1–2 分鐘。</p>
<p class="note note-red">不含地形遮蔽：山谷與山坡被山稜遮住時，實際日照會更短，請預留下撤時間。</p></section>`;
}

export { haversineKm };
