// River water level, reservoir releases and debris-flow alerts (WRA / ARDSWC open data via the pipeline): data, status and point card.
import { S } from './state.js';
import { getJSON, fmtTime, esc, haversineKm, normCounty, html, raw } from './util.js';

export async function loadHydro() {
  if (!S.hydro) S.hydro = await getJSON('hydro.json', { optional: true });
  return S.hydro;
}

/** 0 = below every alert level, 1 / 2 / 3 = reached the 3rd (lowest) / 2nd / 1st (highest) alert level. */
export function riverStatus(r) {
  if (r.a1 !== null && r.a1 !== undefined && r.wl >= r.a1) return 3;
  if (r.a2 !== null && r.a2 !== undefined && r.wl >= r.a2) return 2;
  if (r.a3 !== null && r.a3 !== undefined && r.wl >= r.a3) return 1;
  return 0;
}
export const RIVER_STATUS = ['未達警戒', '達三級警戒', '達二級警戒', '達一級警戒'];

/** 0 no release, 1 releasing, 2 flood release planned, 3 spilling now. */
export function reservoirStatus(r) {
  if ((r.spill ?? 0) > 0) return 3;
  if ((r.plan ?? 0) > 0) return 2;
  if ((r.outflow ?? 0) > 0) return 1;
  return 0;
}
export const RESERVOIR_STATUS = ['無放流', '放流中', '預定洩洪', '洩洪中'];

/** Alerts in a township: [{level, type, no, village}] (county names compared without 臺/台 differences). */
export function townAlerts(h, county, town) {
  const c = normCounty(county);
  return (h?.debris || []).filter((a) => a.county && a.town && normCounty(a.county) === c && (a.town === town || a.town.startsWith(town) || town.startsWith(a.town)));
}

const fmt = (v, nd = 1) => (v === null || v === undefined ? '—' : Number(v).toFixed(nd));

export function riverTip(r) {
  const alerts = [['一級', r.a1], ['二級', r.a2], ['三級', r.a3]].filter(([, v]) => v !== null && v !== undefined).map(([n, v]) => `${n} ${v} m`).join('、');
  return `${esc(r.n)}${r.river ? `（${esc(r.river)}）` : ''}：水位 ${fmt(r.wl, 2)} m・${RIVER_STATUS[riverStatus(r)]}${alerts ? `・警戒水位 ${alerts}` : ''}${r.t ? `・${esc(fmtTime(r.t))}` : ''}`;
}

export function reservoirTip(r) {
  const parts = [`水位 ${fmt(r.wl, 2)} m`, r.vol !== null && r.vol !== undefined ? `有效蓄水量 ${fmt(r.vol, 2)}${r.cap ? `／容量 ${fmt(r.cap, 2)}` : ''}` : null,
    r.inflow !== null && r.inflow !== undefined ? `入流 ${fmt(r.inflow)} m³/s` : null, r.outflow !== null && r.outflow !== undefined ? `總放流 ${fmt(r.outflow)} m³/s` : null,
    (r.spill ?? 0) > 0 ? `溢洪道放流 ${fmt(r.spill)} m³/s` : null, (r.plan ?? 0) > 0 ? `預定洩洪 ${fmt(r.plan)} m³/s${r.planT ? `（${fmtTime(r.planT)}）` : ''}` : null].filter(Boolean);
  return `${esc(r.n)}：${RESERVOIR_STATUS[reservoirStatus(r)]}・${esc(parts.join('・'))}${r.t ? `・${esc(fmtTime(r.t))}` : ''}`;
}

/** Card for the point panel: debris-flow alerts of the township, river stations and reservoirs nearby (15 km). */
export function hydroCard(h, lat, lon, county, town) {
  if (!h) return '';
  const alerts = county && town ? townAlerts(h, county, town) : [];
  const rivers = (h.rivers || []).map((r) => ({ r, d: haversineKm(lat, lon, r.lat, r.lon) })).filter((x) => x.d <= 15).sort((a, b) => a.d - b.d).slice(0, 4);
  const rsv = (h.reservoirs || []).map((r) => ({ r, d: haversineKm(lat, lon, r.lat, r.lon) })).filter((x) => x.d <= 15).sort((a, b) => a.d - b.d).slice(0, 3);
  if (!alerts.length && !rivers.length && !rsv.length) return '';
  const lv = (a) => (a.level === 'red' ? '紅色警戒' : '黃色警戒');
  return html`<section class="card ${alerts.some((a) => a.level === 'red') ? 'warn' : ''}" aria-labelledby="h-hydro"><h3 id="h-hydro">水情與土石流</h3>
${alerts.length ? html`<p><strong>⚠ ${normCounty(county)}${town} 土石流警戒：</strong>${alerts.map((a) => `${lv(a)}${a.village ? `（${a.village}）` : ''}`).join('、')}。豪雨期間請避開溪谷、林道與崩塌地。</p>` : ''}
${rivers.length ? html`<h4>鄰近河川水位站</h4><ul>${rivers.map(({ r, d }) => html`<li>${raw(riverTip(r))} <span class="meta">距此 ${d.toFixed(1)} km</span></li>`)}</ul>` : ''}
${rsv.length ? html`<h4>鄰近水庫</h4><ul>${rsv.map(({ r, d }) => html`<li>${raw(reservoirTip(r))} <span class="meta">距此 ${d.toFixed(1)} km</span></li>`)}</ul>` : ''}
<p class="note">水位為經濟部水利署即時資料（未經品管，儀器故障時可能異常）；土石流警戒為農業部農村發展及水土保持署發布。溪流水位上漲很快，渡溪前請以現場狀況為準，上游下雨時下游也可能暴漲。</p></section>`;
}
