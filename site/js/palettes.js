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

// Accumulated rainfall can exceed 1000 mm in typhoons: extend the rain scale.
const ACC_BOUNDS = [...RAIN_BOUNDS, 400, 500, 600, 800, 1000];
const CWA_ACC = [...CWA_RAIN, '#e88ee8', '#c24ac2', '#8f1f8f', '#5c0a5c', '#2e002e'];
const VIRIDIS_ACC = [...VIRIDIS17, '#3b0f50', '#2c0a3d', '#1d062a', '#100318', '#000000'];
const CONTRAST_ACC = [...CONTRAST_RAIN, '#000000', '#000000', '#000000', '#000000', '#000000'];

// CWA seismic intensity scale; the third element is the legend label.
const INT_LABELS = ['1級', '2級', '3級', '4級', '5弱', '5強', '6弱', '6強', '7級'];
const CWA_INT = ['#d9ffd9', '#00ff00', '#ffff00', '#ff6600', '#ff0000', '#b31a1a', '#663333', '#801a80', '#9900cc'];
const CVD_INT = ['#fde725', '#b5de2b', '#6ece58', '#35b779', '#1f9e89', '#26828e', '#31688e', '#3e4989', '#440154'];
const CONTRAST_INT = ['#ffffff', '#ffff00', '#ffaa00', '#ff5500', '#ff0000', '#b00000', '#600060', '#300030', '#000000'];

function zip(bounds, colours, labels) { return bounds.map((b, i) => (labels ? [b, colours[i], labels[i]] : [b, colours[i]])); }
const INT_BOUNDS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export const SCALES = {
  rain: { cwa: zip(RAIN_BOUNDS, CWA_RAIN), cvd: zip(RAIN_BOUNDS, VIRIDIS17), contrast: zip(RAIN_BOUNDS, CONTRAST_RAIN) },
  radar: { cwa: zip(RADAR_BOUNDS, CWA_RADAR), cvd: zip(RADAR_BOUNDS, VIRIDIS13), contrast: zip(RADAR_BOUNDS, CONTRAST_RADAR) },
  rainacc: { cwa: zip(ACC_BOUNDS, CWA_ACC), cvd: zip(ACC_BOUNDS, VIRIDIS_ACC), contrast: zip(ACC_BOUNDS, CONTRAST_ACC) },
  intensity: {
    cwa: zip(INT_BOUNDS, CWA_INT, INT_LABELS), cvd: zip(INT_BOUNDS, CVD_INT, INT_LABELS), contrast: zip(INT_BOUNDS, CONTRAST_INT, INT_LABELS),
  },
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
  const rgb = scale.map((s) => hexToRgb(s[1]));
  const none = [0, 0, 0, 0];
  return (v) => {
    if (v === null || Number.isNaN(v) || v < bounds[0]) return none;
    let lo = 0;
    let hi = bounds.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (bounds[mid] <= v) lo = mid; else hi = mid - 1;
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
