// Lightweight accessible SVG charts (no external library).
import { esc, fmtTime } from './util.js';

const W = 640;
const H = 150;
const PAD = { l: 44, r: 12, t: 22, b: 26 };

function niceRange(min, max, zeroBase) {
  if (zeroBase) min = Math.min(0, min);
  if (min === max) { max += 1; min -= zeroBase ? 0 : 1; }
  const span = max - min;
  const step = 10 ** Math.floor(Math.log10(span / 4));
  const nice = [1, 2, 5, 10].map((m) => m * step).find((s) => span / s <= 5) || step * 10;
  return { min: Math.floor(min / nice) * nice, max: Math.ceil(max / nice) * nice, step: nice };
}

/**
 * series: [{label, values:[number|null], kind:'line'|'bar', cls:'s1'|'s2'|'s3', dash:bool}]
 * times: ISO strings aligned with values.
 */
export function chart({ title, unit, times, series, zeroBase = false }) {
  const all = series.flatMap((s) => s.values).filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (!all.length) return `<p class="muted">${esc(title)}：此期間無資料</p>`;
  const r = niceRange(Math.min(...all), Math.max(...all), zeroBase);
  const n = times.length;
  const x = (i) => PAD.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v) => PAD.t + (1 - (v - r.min) / (r.max - r.min)) * (H - PAD.t - PAD.b);
  let g = '';
  for (let v = r.min; v <= r.max + 1e-9; v += r.step) {
    g += `<line class="grid" x1="${PAD.l}" x2="${W - PAD.r}" y1="${y(v)}" y2="${y(v)}"/>`;
    g += `<text class="ytick" x="${PAD.l - 4}" y="${y(v) + 4}" text-anchor="end">${+v.toFixed(2)}</text>`;
  }
  // x ticks: about 6 labels
  const every = Math.max(1, Math.round(n / 6));
  for (let i = 0; i < n; i += every) {
    g += `<line class="grid" x1="${x(i)}" x2="${x(i)}" y1="${PAD.t}" y2="${H - PAD.b}"/>`;
    g += `<text class="xtick" x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(fmtTime(times[i]))}</text>`;
  }
  const bw = Math.max(1, ((W - PAD.l - PAD.r) / Math.max(1, n)) * 0.8);
  series.forEach((s) => {
    if (s.kind === 'bar') {
      s.values.forEach((v, i) => {
        if (v === null || v === undefined || v <= 0) return;
        g += `<rect class="${s.cls}" x="${x(i) - bw / 2}" y="${y(v)}" width="${bw}" height="${Math.max(0.5, y(r.min) - y(v))}"/>`;
      });
    } else {
      let d = '';
      let pen = false;
      s.values.forEach((v, i) => {
        if (v === null || v === undefined || Number.isNaN(v)) { pen = false; return; }
        d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      });
      g += `<path class="line ${s.cls}${s.dash ? ' dash' : ''}" d="${d}"/>`;
    }
  });
  const legend = series.map((s) => `<span class="lg ${s.cls}${s.dash ? ' dash' : ''}${s.kind === 'bar' ? ' bar' : ''}">${esc(s.label)}</span>`).join('');
  const summary = series.map((s) => {
    const vals = s.values.filter((v) => v !== null && v !== undefined);
    if (!vals.length) return `${s.label} 無資料`;
    const mx = Math.max(...vals);
    const mn = Math.min(...vals);
    return s.kind === 'bar' ? `${s.label} 合計 ${vals.reduce((a, b) => a + b, 0).toFixed(1)}${unit}，最大 ${mx}${unit}`
      : `${s.label} 最高 ${mx}${unit}、最低 ${mn}${unit}`;
  }).join('；');
  return `<figure class="chart"><figcaption><strong>${esc(title)}</strong>（${esc(unit)}） ${legend}</figcaption>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(`${title}：${summary}`)}" preserveAspectRatio="none">${g}</svg>
<p class="chart-sum">${esc(summary)}</p></figure>`;
}

/** Data table fallback for screen readers / exact values. */
export function dataTable(times, cols) {
  const head = `<tr><th scope="col">時間</th>${cols.map((c) => `<th scope="col">${esc(c.label)}</th>`).join('')}</tr>`;
  const rows = times.map((t, i) => {
    if (cols.every((c) => c.values[i] === null || c.values[i] === undefined)) return '';
    return `<tr><th scope="row">${esc(fmtTime(t))}</th>${cols.map((c) => `<td>${c.values[i] ?? '—'}</td>`).join('')}</tr>`;
  }).join('');
  return `<details class="tbl"><summary>顯示數據表</summary><div class="scroll"><table>${head}${rows}</table></div></details>`;
}
