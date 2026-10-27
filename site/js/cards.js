// Collapsible, colour-themed cards for the point panel. Every card has an icon, a title and a one-line summary (so a
// folded card still says something); the open / closed state of each card is remembered between visits.
import { esc } from './util.js';

/** Card groups: label (jump chips) and glyph; the colour comes from the CSS variable --g-<id>. */
export const GROUPS = {
  safe: { label: '安全', icon: '⚠' },
  obs: { label: '觀測', icon: '◎' },
  fc: { label: '預報', icon: '☀' },
  air: { label: '高空', icon: '≋' },
  water: { label: '水情', icon: '≈' },
  sun: { label: '日照', icon: '☼' },
  info: { label: '資訊', icon: '⌂' },
};

const KEY = 'hikingwx.cards.v1';

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}

function save(state) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* storage blocked: the cards simply start in their default state */ }
}

/**
 * One card. `body` is trusted HTML; title / summary are escaped. `alert` cards (warnings, danger) always start open;
 * `open` is the default for the others until the user opens or closes them.
 */
export function card({ id, grp, icon, title, summary = '', body = '', open = false, alert = false, extra = '', titleId = '' }) {
  const g = GROUPS[grp] || GROUPS.info;
  return `<details class="pcard g-${grp}${extra ? ` ${extra}` : ''}" data-card="${esc(id)}" data-grp="${grp}" data-open="${open ? 1 : 0}"${alert ? ' data-alert="1"' : ''}${open || alert ? ' open' : ''}>`
    + `<summary><span class="pc-ic" aria-hidden="true">${icon || g.icon}</span><span class="pc-tx"><span class="pc-t"${titleId ? ` id="${esc(titleId)}"` : ''}>${esc(title)}</span>`
    + `${summary ? `<span class="pc-s">${esc(summary)}</span>` : ''}</span><span class="pc-chev" aria-hidden="true">▾</span></summary><div class="pc-body">${body}</div></details>`;
}

/**
 * Turn a legacy `<section class="card"><h3 id=..>Title</h3>…</section>` into a card (keeps the heading id so links and tests
 * that look for it still work). Several sections can be merged into one card: their headings become sub-headings.
 */
export function cardize(sections, opts) {
  const list = (Array.isArray(sections) ? sections : [sections]).map((s) => (s && s.html !== undefined ? s.html : String(s ?? ''))).filter((s) => s.trim());
  if (!list.length) return '';
  let title = opts.title || '';
  let titleId = opts.titleId || '';
  const bodies = list.map((h, i) => {
    const m = h.match(/^\s*<section[^>]*>([\s\S]*)<\/section>\s*$/);
    let inner = m ? m[1] : h;
    const tm = inner.match(/<h3([^>]*)>([\s\S]*?)<\/h3>/);
    if (!tm) return inner;
    const idm = tm[1].match(/id="([^"]+)"/);
    if (i === 0 && !opts.keepHeads) {
      if (!title) title = tm[2].replace(/<[^>]+>/g, '').trim();
      titleId = titleId || (idm ? idm[1] : '');
      return inner.replace(tm[0], '');
    }
    return inner.replace(tm[0], `<h4${idm ? ` id="${idm[1]}"` : ''}>${tm[2]}</h4>`);
  });
  return card({ ...opts, title, titleId, body: bodies.join('') });
}

/** Restore saved open / closed states, remember changes, and wire the expand-all / collapse-all and jump buttons. */
export function bindCards(root) {
  const state = load();
  const cards = [...root.querySelectorAll('details.pcard')];
  cards.forEach((d) => {
    const s = state[d.dataset.card];
    if (d.dataset.alert) d.open = true;
    else if (s !== undefined) d.open = Boolean(s);
    d.addEventListener('toggle', () => {
      if (d.dataset.alert) return;
      const st = load();
      st[d.dataset.card] = d.open;
      save(st);
    });
  });
  root.querySelectorAll('[data-cards]').forEach((b) => b.addEventListener('click', () => {
    const open = b.dataset.cards === 'open';
    cards.forEach((d) => { if (!d.dataset.alert || open) d.open = open; });
  }));
  root.querySelectorAll('[data-jump]').forEach((b) => b.addEventListener('click', () => {
    const d = root.querySelector(`details.pcard[data-grp="${b.dataset.jump}"]`);
    if (!d) return;
    d.open = true;
    d.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }));
}
