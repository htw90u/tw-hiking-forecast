// Inline SVG icons (24 x 24 grid, drawn with currentColor): the same shape on every phone, and they follow the theme colours.
// Emoji and symbol characters are drawn by each platform's own font (colour pictures on iOS, different shapes elsewhere).
const P = {
  mountain: '<path d="M2.5 20l6.5-11 4 6.5 2.5-3.5 6 8z"/>',
  target: '<circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  typhoon: '<circle cx="12" cy="12" r="1.6"/><path d="M12 10.4C12 6 9 4 5 5M12 13.6C12 18 15 20 19 19M10.4 12C6 12 4 15 5 19M13.6 12C18 12 20 9 19 5"/>',
  wave: '<path d="M2 12h3.5l2-5 3.5 10 3-12 3 9 1.5-2H22"/>',
  alert: '<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v5M12 17.8v.4"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  'star-fill': '<path fill="currentColor" d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  sliders: '<path d="M3 7h11M18 7h3M3 17h3M10 17h11"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  close: '<path d="M5 5l14 14M19 5L5 19"/>',
  'chev-down': '<path d="M6 9l6 6 6-6"/>',
  'chev-up': '<path d="M6 15l6-6 6 6"/>',
  expand: '<path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/>',
  shrink: '<path d="M20 10h-6V4M4 14h6v6M14 10l7-7M3 21l7-7"/>',
  more: '<circle cx="5" cy="12" r="1.2" fill="currentColor"/><circle cx="12" cy="12" r="1.2" fill="currentColor"/><circle cx="19" cy="12" r="1.2" fill="currentColor"/>',
  play: '<path fill="currentColor" d="M7 4.5l13 7.5-13 7.5z"/>',
  pause: '<path fill="currentColor" d="M6 4.5h4v15H6zM14 4.5h4v15h-4z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1"/>',
  sunrise: '<path d="M3 19h18M7 19a5 5 0 0 1 10 0M12 6v4M5.5 11.5l2 2M18.5 11.5l-2 2"/>',
  umbrella: '<path d="M3 12a9 9 0 0 1 18 0zM12 12v6.5a2 2 0 0 0 4 0"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  heat: '<path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z"/><path d="M12 9v7"/>',
  gauge: '<circle cx="12" cy="12" r="9"/><path d="M12 12l4-4M12 3v2M3 12h2M19 12h2"/>',
  thermo: '<path d="M10 14V5a2 2 0 0 1 4 0v9a4 4 0 1 1-4 0z"/>',
  grid: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M3.5 9.2h17M3.5 14.8h17M9.2 3.5v17M14.8 3.5v17"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5zM3 13l9 5 9-5"/>',
  database: '<ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  wind: '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h16a3 3 0 1 1-3 3M3 16h7"/>',
  drop: '<path d="M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.3v.4"/>',
  contrast: '<circle cx="12" cy="12" r="9"/><path fill="currentColor" d="M12 3a9 9 0 0 0 0 18z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>',
  camera: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M19.8 7.5l-15.6 9"/>',
  dam: '<rect x="3.5" y="4" width="17" height="16" rx="2"/><path d="M8 4v16M12 4v16M16 4v16"/>',
  pin: '<path d="M12 21s7-6 7-11a7 7 0 0 0-14 0c0 5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
};

/** Glyph characters the app used before, mapped to icon names (cards, mode tabs). */
export const GLYPH_ICON = {
  '☀': 'sun', '▦': 'grid', '🌐': 'globe', '♨': 'heat', '☂': 'umbrella', '▲': 'mountain', '∿': 'wave', '◐': 'contrast', '◫': 'layers',
  '⛁': 'database', '⚠': 'alert', '!': 'alert', '◎': 'target', '≋': 'wind', '≈': 'drop', '☼': 'sunrise', '⌂': 'info', '🌀': 'typhoon',
  '🌡': 'thermo', '◷': 'clock', '◉': 'camera', '❄': 'snow', '▥': 'dam',
};

/** `<svg>` for an icon name (or a legacy glyph character); unknown names come back as plain escaped text. */
export function ico(name, cls = '') {
  const n = P[name] ? name : GLYPH_ICON[name];
  if (!n) return String(name ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<svg class="ic${cls ? ` ${cls}` : ''}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${P[n]}</svg>`;
}

/** Fill every `<span data-ic="name">` placeholder of the static page. */
export function paintIcons(root = document) {
  root.querySelectorAll('[data-ic]').forEach((el) => { el.innerHTML = ico(el.dataset.ic); });
}
