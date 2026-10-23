// Rule-based hiking risk summary. Always lists the triggering reasons so the
// level is never conveyed by colour alone.

export const LEVELS = [
  { id: 0, label: '正常', icon: '●', cls: 'lv0' },
  { id: 1, label: '注意', icon: '▲', cls: 'lv1' },
  { id: 2, label: '危險', icon: '■', cls: 'lv2' },
];

/**
 * ctx: { rain1h, rainToday, qpfMax:[lo,hi]|null, radar, temp, stations:[{G,WS,T,R1h,R24h,d}],
 *        spotMinAT, warnings:[{ph,sig}], typhoon:{active, inForecastCone}, quakes:[{iv, d, time}] }
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
  if (gust >= th.gustRed) add(2, `鄰近測站陣風 ${gust} m/s（≥ ${th.gustRed}）`);
  else if (gust >= th.gust) add(1, `鄰近測站陣風 ${gust} m/s（≥ ${th.gust}）`);
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
  const level = reasons.reduce((m, r) => Math.max(m, r.lv), 0);
  reasons.sort((a, b) => b.lv - a.lv);
  return { level, reasons };
}
