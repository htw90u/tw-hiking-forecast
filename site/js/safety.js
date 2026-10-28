// Rule-based hiking risk summary. Always lists the triggering reasons so the
// level is never conveyed by colour alone.

import { beaufort } from './util.js';

export const LEVELS = [
  { id: 0, label: '正常', icon: '●', cls: 'lv0' },
  { id: 1, label: '注意', icon: '▲', cls: 'lv1' },
  { id: 2, label: '危險', icon: '■', cls: 'lv2' },
];

/**
 * ctx: { rain1h, rainToday, qpfMax:[lo,hi]|null, radar, temp, stations:[{G,WS,T,R1h,R24h,d}],
 *        spotMinAT, warnings:[{ph,sig}], typhoon:{active, inForecastCone}, quakes:[{iv, d, time}],
 *        lightning:{n, nearest km}|null, windBf: max Beaufort in the next 24 h of the hiking forecast,
 *        heat: {max, warnMax}|null (township heat-injury index, next 24 h),
 *        gustFc: max model gust (m/s) in the next 24 h }
 */
export function assess(ctx, th) {
  const reasons = [];
  const add = (lv, text) => reasons.push({ lv, text });
  const r1 = Math.max(ctx.rain1h ?? 0, ...ctx.stations.slice(0, 3).map((s) => s.R1h ?? 0));
  if (r1 >= th.rain1hRed) add(2, `近1小時雨量 ${r1} mm（≥ ${th.rain1hRed}）`);
  else if (r1 >= th.rain1h) add(1, `近1小時雨量 ${r1} mm（≥ ${th.rain1h}）`);
  const r24 = Math.max(ctx.rainToday ?? 0, ...ctx.stations.slice(0, 3).map((s) => s.R24h ?? 0));
  if (r24 >= th.rain24Red) add(2, `24小時累積雨量 ${r24} mm（≥ ${th.rain24Red}，豪雨等級）`);
  else if (r24 >= th.rain24) add(1, `24小時累積雨量 ${r24} mm（≥ ${th.rain24}）`);
  if (ctx.qpfMax) {
    const [lo, hi] = ctx.qpfMax;
    if (lo >= 70) add(2, `未來12小時定量降水預報 ${lo}${hi ? `–${hi}` : '+'} mm`);
    else if (lo >= 30) add(1, `未來12小時定量降水預報 ${lo}${hi ? `–${hi}` : '+'} mm`);
  }
  if (ctx.radar !== null && ctx.radar !== undefined && ctx.radar >= 40) add(ctx.radar >= 50 ? 2 : 1, `雷達回波 ${ctx.radar.toFixed(0)} dBZ（強對流/大雨）`);
  const gust = Math.max(0, ...ctx.stations.slice(0, 3).map((s) => s.G ?? s.WS ?? 0));
  if (gust >= th.gustRed) add(2, `鄰近測站陣風 ${gust} m/s（${beaufort(gust)} 級，≥ ${th.gustRed} m/s）`);
  else if (gust >= th.gust) add(1, `鄰近測站陣風 ${gust} m/s（${beaufort(gust)} 級，≥ ${th.gust} m/s）`);
  const cold = ctx.spotMinAT ?? null;
  if (cold !== null) {
    if (cold <= th.coldRed) add(2, `預報最低體感溫度 ${cold}°C（≤ ${th.coldRed}，失溫風險）`);
    else if (cold <= th.cold) add(1, `預報最低體感溫度 ${cold}°C（≤ ${th.cold}）`);
  }
  (ctx.warnings || []).forEach((w) => {
    const severe = /豪雨|颱風|大豪雨|超大豪雨/.test(w.ph || '');
    add(severe ? 2 : 1, `所在縣市有 ${w.ph}${w.sig || ''}`);
  });
  if (ctx.typhoon && ctx.typhoon.active) add(ctx.typhoon.near ? 2 : 1, `颱風警報發布中${ctx.typhoon.name ? `（${ctx.typhoon.name}）` : ''}`);
  (ctx.quakes || []).forEach((q) => {
    if (q.iv >= 5) add(2, `${q.d.toFixed(0)} km 內地震，最大震度 ${q.int}（落石、坍方風險）`);
    else if (q.iv >= 4) add(1, `${q.d.toFixed(0)} km 內地震，最大震度 ${q.int}（注意落石）`);
  });
  const lt = ctx.lightning;
  if (lt && lt.n) add(lt.nearest <= 10 ? 2 : 1, `過去 1 小時 ${lt.n} 次閃電，最近 ${lt.nearest.toFixed(1)} km（雷擊風險，遠離稜線與空曠處）`);
  if (ctx.gustFc >= th.gustRed) add(2, `未來 24 小時模式預報陣風 ${ctx.gustFc} m/s（${beaufort(ctx.gustFc)} 級，≥ ${th.gustRed} m/s）`);
  else if (ctx.gustFc >= th.gust) add(1, `未來 24 小時模式預報陣風 ${ctx.gustFc} m/s（${beaufort(ctx.gustFc)} 級，≥ ${th.gust} m/s）`);
  if (ctx.windBf >= 8) add(2, `未來 24 小時登山預報風力 ${ctx.windBf} 級（稜線行走危險）`);
  else if (ctx.windBf >= 6) add(1, `未來 24 小時登山預報風力 ${ctx.windBf} 級（強風，注意保暖與失足）`);
  const he = ctx.heat;
  if (he && he.max !== null && he.max !== undefined) {
    const lbl = ['', '注意', '警戒', '危險', '極度危險'][he.warnMax] || '';
    if (he.max >= 36 || he.warnMax >= 3) add(2, `未來 24 小時熱傷害指數最高 ${he.max}${lbl ? `（${lbl}）` : ''}（高溫，避開正午、補足水分）`);
    else if (he.max >= 32 || he.warnMax >= 2) add(1, `未來 24 小時熱傷害指數最高 ${he.max}${lbl ? `（${lbl}）` : ''}（炎熱，注意補水與休息）`);
  }
  const level = reasons.reduce((m, r) => Math.max(m, r.lv), 0);
  reasons.sort((a, b) => b.lv - a.lv);
  return { level, reasons };
}
