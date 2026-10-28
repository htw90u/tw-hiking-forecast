// Colour scales for the map layers. Every scale is a list of [lowerBound, colour];
// values below the first bound are drawn transparent.
// "cvd" scales use perceptually ordered colours that stay distinguishable for
// protanopia / deuteranopia / tritanopia (viridis / blue-orange families).

const RAIN_BOUNDS = [0.5, 1, 2, 5, 10, 15, 20, 30, 40, 50, 70, 90, 110, 130, 150, 200, 300];
const CWA_RAIN = ['#c2c2c2', '#9cfcff', '#03c8ff', '#059bff', '#0363ff', '#059902', '#39ff03', '#fffb03',
  '#ffc800', '#ff9500', '#ff0000', '#cc0000', '#990000', '#960099', '#c900cc', '#fb00ff', '#fdc9ff'];
const VIRIDIS17 = ['#fde725', '#d8e219', '#b0dd2f', '#89d548', '#65cb5e', '#46c06f', '#2eb37c', '#21a585',
  '#1f978b', '#23898e', '#297b8e', '#2e6d8e', '#355e8d', '#3d4e8a', '#433d84', '#472a7a', '#440154'];
const CONTRAST_RAIN = ['#ffffff', '#ffffff', '#ffff00', '#ffff00', '#ffaa00', '#ffaa00', '#ff5500', '#ff5500',
  '#ff0000', '#ff0000', '#b00000', '#b00000', '#600060', '#600060', '#000000', '#000000', '#000000'];

const RADAR_BOUNDS = [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65];
const CWA_RADAR = ['#00a3ff', '#005bff', '#0000ff', '#00ff00', '#00d300', '#00a800', '#ffff00', '#ffd300',
  '#ffa800', '#ff0000', '#d30000', '#ff00ff', '#9900ff'];
const VIRIDIS13 = ['#fde725', '#c2df23', '#86d549', '#52c569', '#2ab07f', '#1e9b8a', '#25858e', '#2d708e',
  '#38588c', '#433e85', '#482173', '#440154', '#000000'];
const CONTRAST_RADAR = ['#ffffff', '#ffffff', '#ffff00', '#ffff00', '#ffaa00', '#ffaa00', '#ff0000', '#ff0000',
  '#a00000', '#a00000', '#000000', '#000000', '#000000'];

const TEMP_BOUNDS = [-10, -4, 0, 4, 8, 12, 16, 20, 24, 28, 32, 36];
const CWA_TEMP = ['#7b2cbf', '#3a0ca3', '#4361ee', '#4895ef', '#4cc9f0', '#80ed99', '#c7f9cc', '#ffe66d',
  '#ffb703', '#fb8500', '#e63946', '#9d0208'];
// Blue-orange diverging scale (safe for red-green colour blindness).
const CVD_TEMP = ['#08306b', '#08519c', '#2171b5', '#4292c6', '#6baed6', '#9ecae1', '#deebf7', '#fee6ce',
  '#fdae6b', '#f16913', '#d94801', '#7f2704'];
const CONTRAST_TEMP = ['#0000ff', '#0000ff', '#00a0ff', '#00a0ff', '#ffffff', '#ffffff', '#ffffff', '#ffff00',
  '#ffff00', '#ff8000', '#ff0000', '#ff0000'];


// Beaufort scale (wind forecast by township / mountain): value = Beaufort number.
const BF_BOUNDS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const BF_LABELS = BF_BOUNDS.map((b) => `${b}級`);
const CWA_BF = ['#eef7fb', '#c6e6f2', '#9fd8a0', '#5cb85c', '#ffe066', '#ffb347', '#ff7043', '#e53935', '#b71c1c', '#8e24aa', '#5e35b1', '#311b92'];
const CVD_BF = ['#fde725', '#c2df23', '#86d549', '#52c569', '#2ab07f', '#1e9b8a', '#25858e', '#2d708e', '#38588c', '#433e85', '#482173', '#440154'];
const CONTRAST_BF = ['#ffffff', '#ffffff', '#ffffff', '#ffff00', '#ffff00', '#ffaa00', '#ff5500', '#ff0000', '#ff0000', '#b00000', '#600060', '#000000'];
// Lightning: value = minutes since the strike (newest first).
const LT_BOUNDS = [0, 10, 20, 40];
const LT_LABELS = ['10 分鐘內', '10–20 分鐘前', '20–40 分鐘前', '40–60 分鐘前'];
const CWA_LT = ['#ff1744', '#ff9100', '#ffd600', '#9e9e9e'];
const CVD_LT = ['#440154', '#31688e', '#35b779', '#bdbdbd'];

// Rain probability (%): value = 3-hour probability; below 10 % stays transparent.
const POP_BOUNDS = [10, 20, 30, 40, 50, 60, 70, 80, 90];
const CWA_POP = ['#e8f4fb', '#cfe8f7', '#aad4f0', '#82bde8', '#5aa3de', '#3b86d0', '#2468bd', '#164aa0', '#0b2f7a'];
const POP_LABELS = POP_BOUNDS.map((b) => `${b}%`);
const CONTRAST_POP = ['#ffffff', '#ffffff', '#ffff00', '#ffff00', '#ffaa00', '#ffaa00', '#ff0000', '#b00000', '#000000'];
// UV index classes (WHO / CWA): 低量級 0-2, 中量級 3-5, 高量級 6-7, 過量級 8-10, 危險級 11+.
const UV_BOUNDS = [0, 3, 6, 8, 11];
const UV_LABELS = ['0–2', '3–5', '6–7', '8–10', '11+'];
const CWA_UV = ['#4caf50', '#ffd600', '#ff9100', '#e53935', '#8e24aa'];
const CVD_UV = ['#fde725', '#5ec962', '#21918c', '#3b528b', '#440154'];
const CONTRAST_UV = ['#ffffff', '#ffff00', '#ffaa00', '#ff0000', '#000000'];
// Heat-injury index (CWA M-A0085): 27-31 注意, 32-35 警戒, 36-39 危險, 40+ 極度危險; below 27 is drawn in a pale colour.
const HEAT_BOUNDS = [0, 27, 32, 36, 40];
const HEAT_LABELS = ['< 27', '27–31', '32–35', '36–39', '40+'];
const CWA_HEAT = ['#d6ecf7', '#ffd600', '#ff9100', '#e53935', '#8e24aa'];
const CVD_HEAT = ['#f1f1f1', '#fde725', '#21918c', '#3b528b', '#440154'];
const CONTRAST_HEAT = ['#ffffff', '#ffff00', '#ffaa00', '#ff0000', '#000000'];
// Visibility (km): fog below 1 km (CWA definition of 濃霧), mist 1-2 km.
const VISIB_BOUNDS = [0, 1, 2, 5, 10, 20];
const VISIB_LABELS = ['< 1', '1–2', '2–5', '5–10', '10–20', '≥ 20'];
const CWA_VISIB = ['#7b1fa2', '#e53935', '#ff9800', '#ffd54f', '#81c784', '#4fc3f7'];
const CVD_VISIB = ['#440154', '#3b528b', '#21918c', '#5ec962', '#b5de2b', '#fde725'];
const CONTRAST_VISIB = ['#000000', '#b00000', '#ff0000', '#ffaa00', '#ffff00', '#ffffff'];

// River water level vs alert levels, reservoir release state, debris-flow alert level.
const CWA_WATER = ['#1e88e5', '#ffd600', '#ff9100', '#e53935'];
const CVD_WATER = ['#3b528b', '#5ec962', '#fde725', '#440154'];
const CONTRAST_WATER = ['#ffffff', '#ffff00', '#ff8000', '#ff0000'];
const WATER_LABELS = ['正常', '三級', '二級', '一級'];
const RSV_LABELS = ['無放流', '放流中', '預洩洪', '洩洪中'];
const CWA_RSV = ['#9e9e9e', '#1e88e5', '#ff9100', '#e53935'];
const DEBRIS_LABELS = ['黃色', '紅色'];
const CWA_DEBRIS = ['#ffd600', '#e53935'];

// "大間距" (wide-interval) rainfall classes for large totals, up to 2000 mm. Chosen by the user only; the default
// is CWA's original small-interval scale above. This ramp changes hue family every few classes (blue -> green ->
// yellow/orange -> red -> purple -> magenta -> lilac -> blue-grey -> near black) so that classes above 300 mm
// are not confused with the 150-300 mm magenta of the original scale.
const BIG_BOUNDS = [1, 10, 20, 60, 100, 150, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1200, 1400, 1600, 1800, 2000];
const BIG_RAIN = ['#9cfcff', '#03c8ff', '#059bff', '#0363ff', '#1b7f1b', '#2fd02f', '#d4d400', '#f0a000', '#ff5a00', '#d00000',
  '#7a0000', '#8b1a8b', '#e020e0', '#f0b4f0', '#9a63c0', '#5b2d8e', '#8e9bb0', '#5d6a82', '#3d4a5f', '#1c2430'];
// Colour-blind safe: viridis resampled to the same number of classes (lightness falls steadily with the amount).
const BIG_CVD = resample(VIRIDIS17, BIG_BOUNDS.length);
const BIG_CONTRAST = ['#ffffff', '#ffffff', '#ffff00', '#ffff00', '#ffaa00', '#ffaa00', '#ff5500', '#ff5500', '#ff0000', '#ff0000',
  '#b00000', '#b00000', '#600060', '#600060', '#300030', '#300030', '#000000', '#000000', '#000000', '#000000'];

/** n colours sampled evenly along a list of hex colours (linear in RGB). */
function resample(colours, n) {
  const rgb = colours.map((c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)));
  return Array.from({ length: n }, (_, k) => {
    const x = (k / (n - 1)) * (rgb.length - 1);
    const i = Math.min(Math.floor(x), rgb.length - 2);
    const t = x - i;
    return `#${rgb[i].map((v, j) => Math.round(v + (rgb[i + 1][j] - v) * t).toString(16).padStart(2, '0')).join('')}`;
  });
}

// CWA seismic intensity scale; the third element is the legend label.
const INT_LABELS = ['1級', '2級', '3級', '4級', '5弱', '5強', '6弱', '6強', '7級'];
const CWA_INT = ['#d9ffd9', '#00ff00', '#ffff00', '#ff6600', '#ff0000', '#b31a1a', '#663333', '#801a80', '#9900cc'];
const CVD_INT = ['#fde725', '#b5de2b', '#6ece58', '#35b779', '#1f9e89', '#26828e', '#31688e', '#3e4989', '#440154'];
const CONTRAST_INT = ['#ffffff', '#ffff00', '#ffaa00', '#ff5500', '#ff0000', '#b00000', '#600060', '#300030', '#000000'];

function zip(bounds, colours, labels) { return bounds.map((b, i) => (labels ? [b, colours[i], labels[i]] : [b, colours[i]])); }
const INT_BOUNDS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

// ---- satellite: continuous scales built from colour stops (many small steps)
function hex(c) { return `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`; }
function ramp(stops, from, to, step) {
  // stops: [[value, [r,g,b]], ...] ascending by value
  const out = [];
  for (let v = from; v <= to + 1e-9; v += step) {
    let i = 0;
    while (i < stops.length - 2 && v > stops[i + 1][0]) i += 1;
    const [v0, c0] = stops[i];
    const [v1, c1] = stops[i + 1];
    const t = Math.max(0, Math.min(1, (v - v0) / (v1 - v0)));
    out.push([+v.toFixed(3), hex(c0.map((x, k) => x + (c1[k] - x) * t))]);
  }
  return out;
}
// Infrared: cold cloud tops bright, warm surface dark (like CWA's B/W IR image).
// Stretched like a weather-service IR image: warm sea / land (20-35 °C) is dark, low cloud mid grey, high cloud white.
const IR_GRAY = ramp([[-90, [255, 255, 255]], [-60, [246, 246, 246]], [-30, [208, 208, 208]], [0, [140, 140, 140]], [20, [70, 70, 70]], [40, [12, 12, 12]]], -90, 40, 2);
// Enhanced IR in CWA's colours: the whole range is coloured, dark blue for the warm sea and land, lighter blue and
// cyan for low cloud, green around 0 to -30 °C, yellow, orange and red for cold convective tops. Down to about
// -5 °C the stops were read off CWA's own colour image (O-C0042-006) matched pixel by pixel with the numeric
// brightness temperature of the same time; the colder end follows the usual convention (red, magenta, white).
const IR_ENH = ramp([[-90, [255, 255, 255]], [-65, [255, 255, 255]], [-55, [255, 0, 255]], [-46, [190, 0, 0]], [-40, [255, 0, 0]],
  [-37, [255, 140, 0]], [-34, [255, 255, 0]], [-30, [120, 230, 0]], [-20, [7, 225, 7]], [-8, [1, 171, 6]], [-2, [0, 160, 0]],
  [0, [0, 155, 130]], [1.5, [0, 150, 250]], [4, [0, 146, 255]], [6, [0, 137, 255]], [8, [0, 128, 255]], [10, [0, 117, 255]],
  [12, [0, 106, 255]], [14, [0, 93, 255]], [16, [0, 78, 255]], [18, [0, 69, 255]], [20, [0, 59, 255]], [22, [0, 49, 255]],
  [24, [0, 44, 253]], [25, [0, 1, 239]], [27, [0, 1, 221]], [40, [0, 0, 150]]], -90, 40, 1);
const IR_CVD = ramp([[-90, [253, 231, 37]], [-60, [94, 201, 98]], [-40, [33, 145, 140]], [-20, [59, 82, 139]],
  [-19.9, [200, 200, 200]], [40, [20, 20, 20]]], -90, 40, 2);
const IR_CONTRAST = ramp([[-90, [255, 255, 0]], [-40, [255, 255, 255]], [-20, [160, 160, 160]], [40, [0, 0, 0]]], -90, 40, 2);
// Visible albedo (fraction): dark sea -> bright cloud, with a gamma to lift thin cloud.
// Grey levels follow CWA's visible image (measured against O-C0042-008 for albedo 0 to 0.55): dark sea about 30, a steep
// rise through thin cloud, flattening for thick cloud; thicker cloud is extended to white.
const VIS_STOPS = [[0, 30], [0.05, 49], [0.1, 61], [0.15, 76], [0.2, 89], [0.25, 99], [0.3, 108], [0.35, 116], [0.4, 123],
  [0.45, 129], [0.5, 134], [0.6, 150], [0.7, 178], [0.8, 215], [1, 255]];
const VIS_GRAY = ramp(VIS_STOPS.map(([v, g]) => [v, [g, g, g]]), 0, 1, 0.02);

export const SCALES = {
  rain: { cwa: zip(RAIN_BOUNDS, CWA_RAIN), cvd: zip(RAIN_BOUNDS, VIRIDIS17), contrast: zip(RAIN_BOUNDS, CONTRAST_RAIN) },
  radar: { cwa: zip(RADAR_BOUNDS, CWA_RADAR), cvd: zip(RADAR_BOUNDS, VIRIDIS13), contrast: zip(RADAR_BOUNDS, CONTRAST_RADAR) },
  // Accumulated rain uses CWA's small-interval scale by default (top class: 300 mm and above).
  rainacc: { cwa: zip(RAIN_BOUNDS, CWA_RAIN), cvd: zip(RAIN_BOUNDS, VIRIDIS17), contrast: zip(RAIN_BOUNDS, CONTRAST_RAIN) },
  wind: { cwa: zip(BF_BOUNDS, CWA_BF, BF_LABELS), cvd: zip(BF_BOUNDS, CVD_BF, BF_LABELS), contrast: zip(BF_BOUNDS, CONTRAST_BF, BF_LABELS) },
  ltage: { cwa: zip(LT_BOUNDS, CWA_LT, LT_LABELS), cvd: zip(LT_BOUNDS, CVD_LT, LT_LABELS), contrast: zip(LT_BOUNDS, CWA_LT, LT_LABELS) },
  pop: { cwa: zip(POP_BOUNDS, CWA_POP, POP_LABELS), cvd: zip(POP_BOUNDS, resample(VIRIDIS17, 9), POP_LABELS), contrast: zip(POP_BOUNDS, CONTRAST_POP, POP_LABELS) },
  uv: { cwa: zip(UV_BOUNDS, CWA_UV, UV_LABELS), cvd: zip(UV_BOUNDS, CVD_UV, UV_LABELS), contrast: zip(UV_BOUNDS, CONTRAST_UV, UV_LABELS) },
  heat: { cwa: zip(HEAT_BOUNDS, CWA_HEAT, HEAT_LABELS), cvd: zip(HEAT_BOUNDS, CVD_HEAT, HEAT_LABELS), contrast: zip(HEAT_BOUNDS, CONTRAST_HEAT, HEAT_LABELS) },
  visib: { cwa: zip(VISIB_BOUNDS, CWA_VISIB, VISIB_LABELS), cvd: zip(VISIB_BOUNDS, CVD_VISIB, VISIB_LABELS), contrast: zip(VISIB_BOUNDS, CONTRAST_VISIB, VISIB_LABELS) },
  water: { cwa: zip([0, 1, 2, 3], CWA_WATER, WATER_LABELS), cvd: zip([0, 1, 2, 3], CVD_WATER, WATER_LABELS), contrast: zip([0, 1, 2, 3], CONTRAST_WATER, WATER_LABELS) },
  rsv: { cwa: zip([0, 1, 2, 3], CWA_RSV, RSV_LABELS), cvd: zip([0, 1, 2, 3], CVD_WATER, RSV_LABELS), contrast: zip([0, 1, 2, 3], ['#808080', '#ffffff', '#ff8000', '#ff0000'], RSV_LABELS) },
  debris: { cwa: zip([1, 2], CWA_DEBRIS, DEBRIS_LABELS), cvd: zip([1, 2], ['#fde725', '#440154'], DEBRIS_LABELS), contrast: zip([1, 2], ['#ffff00', '#ff0000'], DEBRIS_LABELS) },
  rainbig: { cwa: zip(BIG_BOUNDS, BIG_RAIN), cvd: zip(BIG_BOUNDS, BIG_CVD), contrast: zip(BIG_BOUNDS, BIG_CONTRAST) },
  intensity: {
    cwa: zip(INT_BOUNDS, CWA_INT, INT_LABELS), cvd: zip(INT_BOUNDS, CVD_INT, INT_LABELS), contrast: zip(INT_BOUNDS, CONTRAST_INT, INT_LABELS),
  },
  irgray: { cwa: IR_GRAY, cvd: IR_GRAY, contrast: IR_CONTRAST },
  irenh: { cwa: IR_ENH, cvd: IR_CVD, contrast: IR_CONTRAST },
  vis: { cwa: VIS_GRAY, cvd: VIS_GRAY, contrast: VIS_GRAY },
  temp: { cwa: zip(TEMP_BOUNDS, CWA_TEMP), cvd: zip(TEMP_BOUNDS, CVD_TEMP), contrast: zip(TEMP_BOUNDS, CONTRAST_TEMP) },
};

export const PALETTE_NAMES = { cwa: '氣象署原色', cvd: '色弱友善', contrast: '高對比' };

export function scaleFor(kind, palette) {
  const s = SCALES[kind] || SCALES.rain;
  return s[palette] || s.cwa;
}

function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Returns f(value) -> [r,g,b,a] (a = 0 for transparent). */
export function colourFn(scale) {
  const bounds = scale.map((s) => s[0]);
  const continuous = scale.length > 30; // satellite ramps cover the whole value range
  const rgb = scale.map((s) => hexToRgb(s[1]));
  const none = [0, 0, 0, 0];
  return (v) => {
    if (v === null || Number.isNaN(v)) return none;
    if (v < bounds[0]) return continuous ? [...rgb[0], 255] : none;
    let lo = 0;
    let hi = bounds.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bounds[mid] <= v) lo = mid; else hi = mid - 1;
    }
    if (continuous && lo < bounds.length - 1) {
      // Satellite ramps: blend between neighbouring stops so the picture has no visible steps.
      const t = (v - bounds[lo]) / (bounds[lo + 1] - bounds[lo]);
      const a = rgb[lo]; const b = rgb[lo + 1];
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 255].map((x, i) => (i < 3 ? Math.round(x) : x));
    }
    const c = rgb[lo];
    return [c[0], c[1], c[2], 255];
  };
}

export function classLabel(scale, i, unit) {
  if (scale[i][2]) return scale[i][2];
  const lo = scale[i][0];
  const hi = i + 1 < scale.length ? scale[i + 1][0] : null;
  return hi === null ? `≥ ${lo} ${unit}` : `${lo}–${hi} ${unit}`;
}
