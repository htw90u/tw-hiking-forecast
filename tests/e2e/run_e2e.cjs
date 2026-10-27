#!/usr/bin/env node
// End-to-end test of the web app with Playwright (Chromium).
// Usage: node tests/e2e/run_e2e.cjs [--site site] [--shots logs/shots]
// Requires site/data built by `python -m pipeline.build`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { Buffer } = require('buffer');

const ROOT = path.resolve(__dirname, '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SITE = path.resolve(ROOT, opt('--site', 'site'));
const SHOTS = path.resolve(ROOT, opt('--shots', 'logs/shots'));
const LOGDIR = path.resolve(ROOT, 'logs');
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(LOGDIR, { recursive: true });

const TZ = process.env.LOG_TZ || 'Asia/Taipei';
const hms = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, dateStyle: 'short', timeStyle: 'medium' }).format(new Date()).replace(/[: ]/g, '').replace(/-/g, '');
const logFile = path.join(LOGDIR, `e2e-${stamp}.log`);
fs.writeFileSync(logFile, `# Reproduce: cd ${ROOT} && node tests/e2e/run_e2e.cjs ${args.join(' ')}\n# Started: ${new Date().toISOString()} (time zone ${TZ})\n`);
const color = process.stdout.isTTY || process.env.FORCE_COLOR || process.env.GITHUB_ACTIONS;
const C = { PASS: '\x1b[32m', FAIL: '\x1b[31m', INFO: '\x1b[0m', WARN: '\x1b[33m' };
let failures = 0;
function log(level, msg) {
  const line = `[${hms()}] ${level.padEnd(5)} ${msg}`;
  fs.appendFileSync(logFile, line + '\n');
  console.log(color ? line.replace(level, `${C[level] || ''}${level}\x1b[0m`) : line);
}
let currentPage = null; // screenshot target when a check fails
async function check(name, fn) {
  try { await fn(); log('PASS', name); } catch (e) {
    failures += 1;
    const shot = path.join(SHOTS, `FAIL-${failures}.png`);
    if (currentPage) await currentPage.screenshot({ path: shot }).catch(() => {});
    log('FAIL', `${name}: ${e.message.split('\n')[0]} (screenshot ${shot})`);
  }
}
const PNG1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
// Layer chips toggle: tapping the active one turns the layer off, so only tap when not selected.
// The text / icon switch is in the map options panel; other display settings in 設定.
async function openOptions(page) {
  if (!(await page.isVisible('#more'))) await page.click('#btn-more');
  await page.waitForSelector('#opts-ui [data-ui]', { state: 'visible' });
}
async function selectLayerOn(page, sel) {
  if ((await page.getAttribute(sel, 'aria-checked')) !== 'true') await page.click(sel);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json', '.gz': 'application/gzip', '.txt': 'text/plain' };

function serve() {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    let p = path.join(SITE, decodeURIComponent(u.pathname));
    if (!p.startsWith(SITE)) { res.writeHead(403); res.end(); return; }
    // OSM peaks come from Overpass in CI; use the small fixture when a local build could not fetch them.
    if (u.pathname.endsWith('/data/peaks.json') && !fs.existsSync(p)) p = path.join(ROOT, 'tests', 'fixtures', 'peaks_sample.json');
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    fs.readFile(p, (err, buf) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      res.end(buf);
    });
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
}

(async () => {
  if (!fs.existsSync(path.join(SITE, 'data', 'manifest.json'))) {
    log('FAIL', 'site/data/manifest.json missing - run `python -m pipeline.build` first');
    process.exit(1);
  }
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  log('INFO', `serving ${SITE} at ${base}; log ${logFile}`);
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  // External map tiles are not needed for the tests; answer them locally.
  await ctx.route(/opentopomap|nlsc\.gov\.tw|openstreetmap|windy\.com/, (r) => r.fulfill({ status: 204, body: '' }));
  const page = await ctx.newPage();
  currentPage = page;
  const selectLayer = (sel) => selectLayerOn(page, sel);
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`console: ${m.text()}`); });

  await check('app loads and data ready', async () => {
    await page.goto(base);
    await page.waitForSelector('body.ready', { timeout: 30000 });
    const chips = await page.$$eval('.chip', (b) => b.length);
    assert(chips >= 7, `expected >= 7 layer chips, got ${chips}`);
    const status = await page.textContent('#status');
    assert(/資料更新/.test(status), `status text: ${status}`);
  });

  await check('radar overlay rendered with legend', async () => {
    await page.waitForSelector('img.wx-grid', { timeout: 15000 });
    assert(await page.isVisible('#legend'), 'legend hidden');
    const t = await page.textContent('#legend summary');
    assert(t.includes('單位') && t.includes('dBZ') && !t.includes('雷達') && !/\d\d:\d\d/.test(t.replace(/\s/g, '')), `legend should hold only the unit and colours: ${t}`);
    const u = await page.$$eval('#legend .lg-unit > *', (e) => e.map((x) => [x.textContent, x.getBoundingClientRect().top]));
    assert(u.length === 2 && u[0][0] === '單位' && u[1][0] === 'dBZ' && u[1][1] > u[0][1], `unit must be on two lines: ${JSON.stringify(u)}`);
    const bn = await page.evaluate(() => {
      const b = document.getElementById('map-banner').getBoundingClientRect(); const m = document.getElementById('map').getBoundingClientRect();
      const o = document.getElementById('btn-more').getBoundingClientRect(); const z = document.querySelector('.leaflet-control-zoom').getBoundingClientRect();
      const l = document.getElementById('legend').getBoundingClientRect();
      return { centre: Math.abs((b.left + b.right) / 2 - (m.left + m.right) / 2), top: b.top - m.top, overlap: b.right > o.left || b.left < z.right, legendW: l.width, text: document.getElementById('map-banner').textContent };
    });
    assert(bn.centre < 2 && bn.top < 30 && !bn.overlap, `banner placement ${JSON.stringify(bn)}`);
    assert(bn.text.includes('雷達') && /\d\d:\d\d/.test(bn.text), `banner should hold the layer name and time: ${bn.text}`);
    assert(bn.legendW < 100, `collapsed legend too wide: ${bn.legendW}px`);
  });

  await check('grid PNG decodes exactly (browser vs pipeline encoding)', async () => {
    const r = await page.evaluate(async () => {
      const { loadGrid, sample } = await import('./js/grid.js');
      const meta = await (await fetch('data/grids/temp.json')).json();
      const g = await loadGrid(meta);
      const vals = Array.from(g.values).filter((v) => !Number.isNaN(v));
      return { n: vals.length, min: Math.min(...vals), max: Math.max(...vals), metaMax: meta.max,
        offTaiwan: sample(g, 22.0, 123.0), w: g.w, h: g.h, size: meta.size };
    });
    assert(r.w === r.size[0] && r.h === r.size[1], 'size mismatch');
    assert(r.n > 100, 'no valid temperature cells');
    assert(Math.abs(r.max - r.metaMax) < 0.051, `max ${r.max} vs meta ${r.metaMax}`);
    assert(r.min > -20 && r.max < 45, `implausible temps ${r.min}..${r.max}`);
  });

  await check('smooth rendering by default; raw cells when disabled', async () => {
    const r = await page.evaluate(async () => {
      const { getGrid, framesFor } = await import('./js/layers.js');
      const { renderGrid } = await import('./js/grid.js');
      const { dbzToRate } = await import('./js/views.js');
      const g = await getGrid(framesFor('radar').slice(-1)[0]);
      const col = () => [0, 0, 255, 255];
      const sm = renderGrid(g, col, { smooth: true, fill: -20 });
      const rw = renderGrid(g, col, { smooth: false });
      const img = document.querySelector('img.wx-grid');
      return { gw: g.w, sm: sm.width, rw: rw.width, shown: img && img.naturalWidth, rate40: dbzToRate(40) };
    });
    assert(r.rw === r.gw && r.sm >= r.gw * 2, `widths raw ${r.rw} smooth ${r.sm} grid ${r.gw}`);
    assert(r.shown === r.sm, `default overlay is not smooth (${r.shown} vs ${r.sm})`);
    assert(Math.abs(r.rate40 - 11.53) < 0.05, `dBZ->mm/h ${r.rate40}`);
  });

  await check('every layer chip switches without errors', async () => {
    const ids = await page.$$eval('.chip', (b) => b.map((x) => x.dataset.layer));
    for (const id of ids) {
      await selectLayer(`.chip[data-layer="${id}"]`);
      await page.waitForTimeout(id === 'none' ? 200 : 1200);
      const checked = await page.getAttribute(`.chip[data-layer="${id}"]`, 'aria-checked');
      assert(checked === 'true', `chip ${id} not checked`);
    }
    assert(!errors.length, errors.join(' | '));
  });

  await check('accumulated rainfall: selectable periods up to 7 days', async () => {
    await selectLayer('.chip[data-layer="rainacc"]');
    await page.waitForSelector('[data-period]');
    const labels = await page.$$eval('[data-period]', (b) => b.map((x) => x.textContent.trim()));
    for (const want of ['今日', '過去3小時', '過去24小時', '過去3天', '過去7天']) assert(labels.includes(want), `missing ${want} in ${labels}`);
    const checked = await page.$eval('[data-period][aria-checked="true"]', (b) => b.textContent.trim());
    assert(checked === '過去24小時', `default period ${checked}`);
    await page.click(`[data-period="${labels.indexOf('過去7天')}"]`);
    await page.waitForFunction(() => document.querySelector('#map-banner')?.textContent.includes('7天'));
    const top = await page.$eval('#legend .swatches li:first-child', (e) => e.textContent);
    assert(top.includes('300'), `small-interval top class should be CWA's 300 mm+: ${top}`);
  });

  await check('QPF periods (4) and georeferenced overlay', async () => {
    await selectLayer('.chip[data-layer="qpf"]');
    await page.waitForSelector('[data-period]');
    const n = await page.$$eval('[data-period]', (b) => b.length);
    assert(n === 4, `periods ${n}`);
    await page.click('[data-period="1"]');
    await page.waitForTimeout(800);
    assert(await page.$('img.qpf-title'), 'QPF title image missing');
    await page.screenshot({ path: path.join(SHOTS, 'qpf-mobile.png') });
  });

  await check('QPF modes: 12h / 6h / 24-48h totals with derived-product attribution', async () => {
    await selectLayer('.chip[data-layer="qpf"]');
    await page.waitForSelector('[data-qpfmode]');
    const modes = await page.$$eval('[data-qpfmode]', (b) => b.map((x) => x.dataset.qpfmode));
    assert(modes.join() === '12,6,acc', `modes ${modes}`);
    const has6 = await page.evaluate(async () => (await import('./js/state.js')).S.manifest.layers.qpf6?.available);
    if (has6) {
      await page.click('[data-qpfmode="6"]');
      await page.waitForFunction(() => document.querySelectorAll('[data-period]').length >= 4);
      await page.waitForFunction(() => document.querySelector('#map-banner')?.textContent.includes('6小時'));
      const lbl = await page.$$eval('[data-period]', (b) => b.map((x) => x.textContent));
      assert(lbl.every((t) => t.includes('–')), `6h period labels lack an interval: ${lbl.slice(0, 2)}`);
      await page.screenshot({ path: path.join(SHOTS, 'qpf6-mobile.png') });
    } else {
      assert(await page.getAttribute('[data-qpfmode="6"]', 'aria-disabled') === 'true', '6h should be disabled when unavailable');
    }
    await page.click('[data-qpfmode="acc"]');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-period]')].map((b) => b.textContent).join() === '未來24小時,未來48小時');
    await page.click('[data-period="1"]');
    await page.waitForFunction(() => document.querySelector('#map-banner')?.textContent.includes('48'));
    const lg = await page.textContent('#legend');
    for (const want of ['非中央氣象署發布之預報', '政府資料開放授權條款', 'https://data.gov.tw/license', 'F-C0035-015']) assert(lg.includes(want), `legend lacks ${want}`);
    await page.click('[data-qpfmode="12"]');
    await page.waitForTimeout(500);
  });

  await check('satellite: numeric IR / enhanced IR / visible with gradient legend', async () => {
    await selectLayer('.chip[data-layer="sat"]');
    await page.waitForSelector('[data-frame]');
    const labels = await page.$$eval('[data-frame]', (b) => b.map((x) => x.textContent));
    assert(labels.length === 3 && labels[1].includes('色調強化'), `sat modes ${labels}`);
    await page.click('[data-frame="1"]');
    await page.waitForFunction(() => document.querySelector('#legend .grad'));
    const n = await page.$$eval('img.wx-grid', (x) => x.length);
    assert(n === 1, `satellite overlay images ${n}`);
  });

  await check('QPF outlying islands placed at real coordinates (Matsu, Kinmen)', async () => {
    const r = await page.evaluate(async () => {
      const { getGrid, framesFor } = await import('./js/layers.js');
      const { sample } = await import('./js/grid.js');
      const g = await getGrid(framesFor('qpf')[0]);
      return { parts: g.parts.length, beigan: sample(g, 26.222, 120.0), nangan: sample(g, 26.155, 119.94),
        kinmen: sample(g, 24.45, 118.38), sea: sample(g, 26.0, 119.5) };
    });
    assert(r.parts === 4, `parts ${r.parts}`);
    assert(r.beigan !== null && r.nangan !== null && r.kinmen !== null, JSON.stringify(r));
    assert(r.sea === null, `sea should be no-data ${JSON.stringify(r)}`);
    await selectLayer('.chip[data-layer="qpf"]');
    await page.waitForFunction(() => document.querySelectorAll('img.wx-grid').length === 5);
    const n = await page.$$eval('img.wx-grid', (x) => x.length);
    assert(n === 5, `expected 5 overlay images (main + 4 islands), got ${n}`);
    await page.evaluate(async () => { const { S } = await import('./js/state.js'); S.map.setView([26.17, 119.96], 11, { animate: false }); });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(SHOTS, 'qpf-matsu.png') });
    await page.evaluate(async () => { const { S } = await import('./js/state.js'); S.map.setView([23.75, 121.0], 8, { animate: false }); });
  });

  await check('typhoon forecast points have time labels (no overlaps)', async () => {
    const active = await page.evaluate(async () => (await import('./js/state.js')).S.typhoon?.active);
    if (!active) return;
    const boxes = await page.$$eval('.ty-lbl', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height, e.textContent]; }));
    assert(boxes.length >= 2, `only ${boxes.length} typhoon labels`);
    assert(boxes.every((b) => /\d+日\d\d時/.test(b[4])), `label format ${boxes.map((b) => b[4])}`);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const [ax, ay, aw, ah] = boxes[i]; const [bx, by, bw, bh] = boxes[j];
        const overlap = ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah;
        assert(!overlap, `labels overlap: ${boxes[i][4]} / ${boxes[j][4]}`);
      }
    }
  });

  await check('click on map opens point panel with risk, stations and history chart', async () => {
    await selectLayer('.chip[data-layer="radar"]');
    await page.evaluate(() => window.scrollTo(0, 0));
    const box = await page.locator('#map').boundingBox();
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.4);
    await page.waitForSelector('#sheet.open #h-risk', { timeout: 20000 });
    await page.waitForSelector('#hist-out figure.chart, #hist-out p', { timeout: 20000 });
    const title = await page.textContent('#sheet-title');
    assert(title && title !== '查詢中…', `title ${title}`);
    assert(!(await page.textContent('#sheet-body')).includes('鄉鎮不明'), 'unknown-township text should not be shown');
    await page.waitForFunction(() => document.querySelector('#sheet-body')?.textContent.includes('雲頂溫度'), null, { timeout: 20000 });   // the grid values arrive after the panel is shown
    const body = await page.textContent('#sheet-body');
    assert(body.includes('雲頂溫度'), 'point panel lacks cloud-top temperature');
    assert(body.includes('未來累積降水') && body.includes('非中央氣象署發布之預報'), 'point panel lacks derived totals with disclaimer');
    const q6 = await page.evaluate(async () => ({ src: (await import('./js/state.js')).S.manifest?.layers?.qpf6?.source, head: document.querySelector('#h-qpf6')?.textContent || '' }));
    if (q6.src === 'cwa-web' && q6.head) assert(!q6.head.includes('颱風'), `6-hour QPF from the CWA website must not be labelled as typhoon-period data: ${q6.head}`);
    await page.screenshot({ path: path.join(SHOTS, 'point-mobile.png') });
  });

  await check('history range switch 7 days', async () => {
    await page.click('[data-range="168"]');
    await page.waitForTimeout(800);
    const has = await page.$('#hist-out figure.chart');
    assert(has, 'no chart for 7 days');
  });

  await check('search mountain and open spot forecast', async () => {
    await page.click('#sheet-close');
    await page.fill('#q', '玉山');
    await page.waitForSelector('#q-results li');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#sheet.open [data-panel="d3"] table', { timeout: 20000 });
    const title = await page.textContent('#sheet-title');
    assert(title.trim() === '玉山', `title ${title}`);
  });

  await check('affected mountains list for QPF', async () => {
    await page.click('#sheet-close');
    await selectLayer('.chip[data-layer="qpf"]');
    await page.waitForTimeout(800);
    if (!(await page.isVisible('#btn-affected'))) await page.click('#btn-more');
    await page.click('#btn-affected');
    await page.waitForSelector('#aff-thr', { timeout: 15000 });
    const txt = await page.textContent('#sheet-body');
    assert(/共 \d+ 處/.test(txt), 'no count');
  });

  await check('alerts, typhoon and earthquake views', async () => {
    await page.click('#sheet-close');
    await page.click('#btn-alerts');
    await page.waitForSelector('#btn-allq');
    if (await page.$('[data-open="typhoon"]')) {
      await page.click('[data-open="typhoon"]');
      await page.waitForSelector('#sheet-title:has-text("颱風")');
      const restricted = await page.evaluate(async () => (await import('./js/state.js')).S.typhoon.tablesRestricted);
      if (restricted) {
        assert(await page.$('#sheet-body a[href*="cwa.gov.tw/V8/C/P/Typhoon"]'), 'missing CWA typhoon link');
        assert(!(await page.$('.chip[data-layer="tyrain"]')), 'typhoon rain layer shown without permission');
        assert(!(await page.$('#sheet-body [data-tylayer]')), 'typhoon tables shown without permission');
      }
      await page.click('#sheet-back');
    }
    await page.click('#btn-allq');
    await page.waitForSelector('[data-quake]');
    const withShake = await page.evaluate(async () => (await import('./js/state.js')).S.quakes.findIndex((q) => q.shake));
    await page.click(`[data-quake] >> nth=${Math.max(0, withShake)}`);
    await page.waitForSelector('#sheet-title:has-text("地震")');
    const t = await page.textContent('#sheet-body');
    assert(t.includes('50 km'), 'quake detail missing radius list');
    assert(await page.$('#sheet.peek'), 'quake sheet should be low (peek) so the map stays visible');
    const vis = await page.evaluate(() => document.getElementById('sheet').getBoundingClientRect().top / window.innerHeight);
    assert(vis > 0.5, `sheet covers too much: top at ${(vis * 100).toFixed(0)}%`);
    assert((await page.$$('.int-mk')).length > 0, 'no station intensity markers');
    if (withShake >= 0) await page.waitForSelector('img.shake', { timeout: 10000 });
    assert(await page.evaluate(async () => (await import('./js/state.js')).S.quakeMode), 'quake mode not set');
    assert((await page.$$('img.wx-grid:not(.shake)')).length === 0, 'weather layer should be hidden under the shakemap');
    await page.screenshot({ path: path.join(SHOTS, 'quake-mobile.png') });
    // Minimise: header bar only, rings / intensity markers / shakemap stay on the map.
    await page.click('#sheet-min');
    await page.waitForTimeout(900);
    const st = await page.evaluate(async () => {
      const { S } = await import('./js/state.js');
      const sh = document.getElementById('sheet').getBoundingClientRect();
      const map = S.map.getBounds();
      const ring = S.focusBounds;
      return { h: sh.height, focus: S.focus.getLayers().length, quake: S.quakeMode,
        labels: document.querySelectorAll('.ring-lbl').length, ringInView: map.contains(ring) };
    });
    assert(st.h < 90, `minimised sheet still ${st.h}px tall`);
    assert(st.quake && st.focus > 0 && st.labels === 3, `highlights removed on minimise ${JSON.stringify(st)}`);
    assert(st.ringInView, 'felt area / 50 km ring not fully in view after minimising');
    assert(await page.$('img.shake'), 'shakemap removed on minimise');
    await page.screenshot({ path: path.join(SHOTS, 'quake-minimised.png') });
    await page.click('#sheet-min');
    await page.waitForTimeout(300);
    assert((await page.evaluate(() => document.getElementById('sheet').getBoundingClientRect().height)) > 200, 'sheet did not restore');
    await page.screenshot({ path: path.join(SHOTS, 'quake-mobile.png') });
  });

  await check('sources & licence panel with OGDL attribution', async () => {
    await page.click('#sheet-close').catch(() => {});
    await page.click('#btn-sources');
    await page.waitForSelector('#sheet-title:has-text("資料來源")');
    const t = await page.textContent('#sheet-body');
    for (const want of ['顯名聲明', '中央氣象署', '政府資料開放授權條款', 'https://data.gov.tw/license', 'F-C0041']) assert(t.includes(want), `panel lacks ${want}`);
  });

  await check('settings: font 200%, contrast theme, colour-blind palette persist', async () => {
    await page.click('#sheet-close');
    assert(!(await page.evaluate(async () => (await import('./js/state.js')).S.quakeMode)), 'quake mode not cleared on close');
    assert((await page.$$('img.wx-grid')).length > 0, 'weather layer not restored after closing the quake view');
    await page.click('#btn-settings');
    await page.waitForSelector('#set-fs');
    await page.$eval('#set-fs', (el) => { el.value = '2'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await page.selectOption('#set-theme', 'contrast');
    await page.selectOption('#set-pal', 'cvd');
    await page.keyboard.press('Escape');
    const fs_ = await page.evaluate(() => getComputedStyle(document.documentElement).fontSize);
    assert(fs_ === '32px', `font-size ${fs_}`);
    assert((await page.getAttribute('html', 'data-theme')) === 'contrast', 'theme');
    await selectLayer('.chip[data-layer="qpe1h"]');
    await page.waitForTimeout(800);
    const sw = await page.$eval('#legend .swatches li:last-child .sw', (e) => getComputedStyle(e).backgroundColor);
    assert(sw === 'rgb(253, 231, 37)', `lowest swatch ${sw} (expected viridis yellow)`);
    await page.screenshot({ path: path.join(SHOTS, 'contrast-xl-mobile.png') });
    await page.reload();
    await page.waitForSelector('body.ready');
    assert((await page.getAttribute('html', 'data-theme')) === 'contrast', 'theme not persisted');
    const mapH = await page.evaluate(() => document.getElementById('map').getBoundingClientRect().height / window.innerHeight);
    assert(mapH > 0.3, `map only ${(mapH * 100).toFixed(0)}% of screen at 200% font`);
  });

  await check('station click: station data and nearby mountains first, safety after', async () => {
    await page.evaluate(async () => {
      const { S } = await import('./js/state.js'); const v = await import('./js/views.js');
      const st = S.stations.find((x) => x.k === 'manned' && x.alt > 2000) || S.stations.find((x) => x.k === 'manned');
      await v.showPoint(st.lat, st.lon, { stationId: st.id, label: `${st.n}測站` });
    });
    await page.waitForSelector('#sheet-body [data-card="station"]');
    const order = await page.$$eval('#sheet-body details.pcard', (els) => els.map((e) => e.dataset.card));
    assert(order[0] === 'risk' && order.indexOf('station') < order.indexOf('stations') && order.indexOf('station') < order.indexOf('mtns'), `card order ${order}`);
    assert((await page.$$('#sheet-body [data-card="station"] .tile')).length >= 3, 'station value tiles missing');
    assert((await page.$$eval('#sheet-body [data-card="station"][open]', (e) => e.length)) === 1, 'the clicked station card should start open');
    await page.click('#sheet-close');
  });

  await check('typhoon tab and banner only while a typhoon warning is in force', async () => {
    const active = await page.evaluate(async () => Boolean((await import('./js/state.js')).S.typhoon?.active));
    assert((await page.$('#ty-banner')) !== null === active, 'banner presence does not match typhoon state');
    assert((await page.getAttribute('#btn-typhoon', 'hidden')) === null === active, 'typhoon tab visibility does not match');
    if (active) {
      await page.click('#ty-banner');
      await page.waitForFunction(() => document.getElementById('sheet-title')?.textContent.includes('颱風'));
      await page.click('#sheet-close');
    }
  });

  await check('tapping the active layer chip again turns the layer off', async () => {
    await page.click('#sheet-close').catch(() => {});
    await selectLayer('.chip[data-layer="radar"]');
    await page.waitForFunction(() => document.querySelector('.chip[data-layer="radar"]')?.getAttribute('aria-checked') === 'true');
    await page.click('.chip[data-layer="radar"]');
    await page.waitForFunction(() => !document.querySelector('.chip[aria-checked="true"]'));
    assert(!(await page.$('.chip[data-layer="none"]')), 'the 關閉圖層 chip should be gone');
    assert((await page.$$('img.wx-grid')).length === 0, 'weather overlay still shown after toggling off');
    await page.click('.chip[data-layer="radar"]');
    await page.waitForFunction(() => document.querySelector('.chip[data-layer="radar"]')?.getAttribute('aria-checked') === 'true');
  });

  await check('map name labels: optional per kind, decluttered', async () => {
    await page.click('#sheet-close').catch(() => {});
    await page.evaluate(async () => { const { S } = await import('./js/state.js'); S.map.setView([23.47, 120.96], 11, { animate: false }); });
    if (!(await page.isVisible('[data-lbl="mountains"]'))) await page.click('#btn-more');
    await page.check('[data-lbl="mountains"]');
    await page.waitForTimeout(500);
    const n = await page.$$eval('.map-lbl.lbl-mountains', (e) => e.length);
    assert(n > 3, `only ${n} mountain labels`);
    const boxes = await page.$$eval('.map-lbl', (els) => els.map((e) => { const el = e.firstElementChild || e; const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }));
    const hit = boxes.some((a, i) => boxes.some((b, j) => j > i && a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1));
    assert(!hit, 'labels overlap');
    await page.uncheck('[data-lbl="mountains"]');
    await page.waitForTimeout(300);
    assert((await page.$$('.map-lbl.lbl-mountains')).length === 0, 'labels remain after turning off');
    if (await page.isVisible('#btn-more')) await page.click('#btn-more');
  });

  await check('map options panel sits in the map top-right; font sliders resize labels live', async () => {
    await page.click('#sheet-close').catch(() => {});
    const map = await page.locator('#map').boundingBox();
    const btn = await page.locator('#btn-more').boundingBox();
    assert(btn.y >= map.y && btn.y < map.y + 60 && btn.x + btn.width > map.x + map.width - 60, `button not at the map top-right ${JSON.stringify(btn)}`);
    assert(!(await page.locator('#controls #btn-more').count()), 'options button still in the bottom controls');
    const lg = await page.locator('#legend').boundingBox();
    if (lg) {
      assert(lg.y >= btn.y + btn.height, 'legend overlaps the options button');
      assert(lg.y + lg.height <= map.y + map.height && lg.x + lg.width <= map.x + map.width + 1, `legend not at the map's bottom-right ${JSON.stringify(lg)}`);
    }
    await page.evaluate(async () => { const { S } = await import('./js/state.js'); S.map.setView([23.47, 120.96], 11, { animate: false }); });
    await page.click('#btn-more');
    await page.check('[data-lbl="mountains"]');
    await page.waitForSelector('.map-lbl.lbl-mountains');
    const size = () => page.$eval('.map-lbl.lbl-mountains', (e) => parseFloat(getComputedStyle(e).fontSize));
    const s0 = await size();
    assert(s0 >= 14, `default label size too small: ${s0}px`);
    await page.$eval('#lbl-size', (i) => { i.value = '1.8'; i.dispatchEvent(new Event('input', { bubbles: true })); });
    const s1 = await size();
    assert(s1 > s0 * 1.3, `label size did not follow the slider: ${s0} -> ${s1}`);
    assert((await page.textContent('#lbl-size-out')) === '180%', 'slider value not shown');
    const boxes = await page.$$eval('.map-lbl', (els) => els.map((e) => { const el = e.firstElementChild || e; const r = el.getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom]; }));
    const hit = boxes.some((a, i) => boxes.some((b, j) => j > i && a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1));
    assert(!hit, 'large labels overlap');
    await page.screenshot({ path: path.join(SHOTS, 'map-options.png') });
    await page.$eval('#lbl-size', (i) => { i.value = '1.25'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.uncheck('[data-lbl="mountains"]');
    // A map tap closes the panel without opening a point.
    await page.mouse.click(map.x + 40, map.y + map.height - 60);
    assert(!(await page.isVisible('#more')), 'panel still open after a map tap');
    assert(!(await page.isVisible('#sheet')), 'map tap with the panel open should not open a point');
  });

  await check('zoom 10: spot category icons, peak markers and names on by default; 全部取消 / 全選', async () => {
    await page.click('#sheet-close').catch(() => {});
    await page.evaluate(async () => { const { S } = await import('./js/state.js'); S.map.setView([24.85, 121.2], 10, { animate: false }); });
    if (!(await page.isChecked('[data-ov="spots"]').catch(() => false))) {
      if (!(await page.isVisible('[data-ov="spots"]'))) await page.click('#btn-more');
      await page.check('[data-ov="spots"]');
    }
    await page.waitForSelector('.pin-cat');
    const cats = await page.$$eval('.pin-cat', (e) => new Set(e.map((x) => x.className.match(/cat-(\w+)/)?.[1])).size);
    assert(cats >= 2, `only ${cats} spot icon kind(s)`);
    await page.waitForFunction(() => document.querySelectorAll('.map-lbl.lbl-spots').length > 0);
    await page.evaluate(async () => { const { S } = await import('./js/state.js'); S.map.setView([23.47, 120.96], 10, { animate: false }); });
    await page.waitForFunction(() => document.querySelectorAll('.pin-peak').length > 0 && document.querySelectorAll('.map-lbl.lbl-peaks').length > 0);
    if (!(await page.isVisible('#tg-lbl-t'))) await page.click('#btn-more');
    const none = page.locator('[data-all="lbl"][data-on="0"]');
    const all = page.locator('[data-all="lbl"][data-on="1"]');
    await none.click();
    await page.waitForTimeout(200);
    assert((await page.$$('.map-lbl')).length === 0, 'labels remain after 全部取消');
    assert(await none.isDisabled(), '全部取消 should be disabled when nothing is checked');
    await page.screenshot({ path: path.join(SHOTS, 'labels-off.png') });
    await all.click();
    assert((await page.$$eval('input[data-lbl]', (e) => e.every((c) => c.checked))), '全選 did not check every label');
    assert(await all.isDisabled(), '全選 should be disabled when everything is checked');
    await page.waitForFunction(() => document.querySelectorAll('.map-lbl').length > 0);
    await page.uncheck('[data-lbl="stations"]');
    await page.click('#btn-more');
    await page.screenshot({ path: path.join(SHOTS, 'zoom10-labels.png') });
  });

  await check('legend: colour bar visible while collapsed; 大間距 classes for accumulated rain', async () => {
    await page.click('#sheet-close').catch(() => {});
    await selectLayer('.chip[data-layer="radar"]');
    await page.waitForSelector('#legend summary .lg-strip .cells > span');
    if (await page.getAttribute('#legend', 'open') !== null) await page.click('#legend summary');
    assert(await page.isVisible('#legend summary .lg-strip'), 'colour bar hidden when the legend is collapsed');
    const n = await page.$$eval('#legend summary .lg-strip .cells > span', (e) => e.length);
    assert(n === 13, `radar bar has ${n} cells`);
    await selectLayer('.chip[data-layer="rainacc"]');
    await page.waitForSelector('#legend [data-spacing]', { state: 'attached' });
    assert((await page.getAttribute('#legend [data-spacing="small"]', 'aria-checked')) === 'true', 'large totals must not switch to 大間距 by themselves');
    await page.click('#legend summary');
    await page.click('#legend [data-spacing="big"]');
    await page.waitForFunction(() => [...document.querySelectorAll('#legend summary .ticks > span')].some((t) => t.textContent === '2000'));
    assert(await page.evaluate(async () => (await import('./js/state.js')).S.settings.rainSpacing === 'big'), 'spacing not saved');
    assert((await page.$$eval('#legend summary .lg-strip .cells > span', (e) => e.length)) === 20, 'big-interval bar should have 20 classes');
    const q = await page.evaluate(async () => {
      const { scaleFor } = await import('./js/palettes.js');
      const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
      const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
      const out = {};
      for (const pal of ['cwa', 'cvd']) {
        const sc = scaleFor('rainbig', pal).map((x) => rgb(x[1]));
        out[pal] = { distinct: new Set(sc.map(String)).size, minStep: Math.min(...sc.slice(1).map((c, i) => Math.hypot(...c.map((v, k) => v - sc[i][k])))),
          lumMonotone: sc.slice(1).every((c, i) => lum(c) <= lum(sc[i]) + 1) };
      }
      const small = scaleFor('rainacc', 'cwa').map((x) => x[1]).join();
      return { ...out, sameAsCwa: small === scaleFor('rain', 'cwa').map((x) => x[1]).join() };
    });
    assert(q.cwa.distinct === 20 && q.cwa.minStep > 45, `big-interval colours too close: ${JSON.stringify(q.cwa)}`);
    assert(q.cvd.distinct === 20 && q.cvd.lumMonotone, `colour-blind big-interval ramp not ordered by lightness: ${JSON.stringify(q.cvd)}`);
    assert(q.sameAsCwa, 'default accumulated-rain scale must be the CWA original');
    await page.screenshot({ path: path.join(SHOTS, 'legend-big.png') });
    await page.click('#legend [data-spacing="small"]');
    await page.waitForFunction(() => document.querySelector('#legend [data-spacing="small"]')?.getAttribute('aria-checked') === 'true');
    await page.click('#legend summary');
    await selectLayer('.chip[data-layer="radar"]');
  });

  await check('typhoon shown by default: overlay on and track in view at start-up', async () => {
    const st = await page.evaluate(async () => {
      const { S } = await import('./js/state.js');
      if (!S.typhoon?.active) return { active: false };
      return { active: true, on: S.map.hasLayer(S.overlays.typhoon) };
    });
    if (!st.active) return;
    await page.evaluate(async () => { const { S } = await import('./js/state.js'); S.settings.overlays.typhoon = false; localStorage.setItem('hikingwx.settings.v1', JSON.stringify(S.settings)); });
    await page.reload();
    await page.waitForSelector('body.ready');
    const r = await page.evaluate(async () => {
      const { S } = await import('./js/state.js');
      const c = S.typhoon.cyclones[0]; const cur = c.past[c.past.length - 1];
      const c0 = S.map.getCenter();
      return { on: S.map.hasLayer(S.overlays.typhoon), inView: S.map.getBounds().contains([cur.lat, cur.lon]), centre: [c0.lat, c0.lng] };
    });
    assert(r.on, 'typhoon overlay not shown at start-up');
    assert(Math.abs(r.centre[0] - 23.75) < 0.05 && Math.abs(r.centre[1] - 121.0) < 0.05, `Taiwan not centred: ${r.centre}`);
    await page.screenshot({ path: path.join(SHOTS, 'typhoon-default.png') });
  });

  await check('wind layer: township Beaufort colours, mountain arrows, time slider, station observations', async () => {
    await page.click('#sheet-close').catch(() => {});
    await selectLayer('.chip[data-layer="wind"]');
    await page.waitForSelector('.wind-mk');
    const st = await page.evaluate(async () => {
      const { S } = await import('./js/state.js');
      let filled = 0;
      S.layer.overlay.eachLayer((l) => { if (l.eachLayer) l.eachLayer((p) => { if (p.options.fillOpacity > 0) filled += 1; }); });
      return { filled, arrows: document.querySelectorAll('.wind-mk').length, steps: S.wind.times.length };
    });
    assert(st.filled > 200 && st.arrows >= 5, `wind layer ${JSON.stringify(st)}`);
    assert((await page.$$eval('#legend summary .lg-strip .cells > span', (e) => e.length)) === 12, 'Beaufort colour bar');
    const before = await page.textContent('#map-banner');
    await page.$eval('#wind-frame', (i) => { i.value = String(Number(i.max)); i.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.waitForFunction((b) => document.querySelector('#map-banner')?.textContent !== b, before);
    await page.screenshot({ path: path.join(SHOTS, 'wind.png') });
    await page.click('[data-windmode="obs"]');
    await page.waitForFunction(() => document.querySelector('#map-banner')?.textContent.includes('測站'));
    assert((await page.$$('.wind-mk')).length > 50, 'station wind arrows missing');
    await page.click('[data-windmode="fc"]');
    await selectLayer('.chip[data-layer="radar"]');
  });

  await check('sun times: sunrise / sunset formulas match known Taipei values', async () => {
    const r = await page.evaluate(async () => {
      const { sunTimes } = await import('./js/sun.js');
      return { jun: sunTimes(25.033, 121.565, 2026, 6, 21), dec: sunTimes(25.033, 121.565, 2026, 12, 21),
        hi: sunTimes(23.47, 120.957, 2026, 10, 27, 3952), lo: sunTimes(23.47, 120.957, 2026, 10, 27) };
    });
    const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const near = (a, b) => Math.abs(mins(a) - mins(b)) <= 3;
    assert(near(r.jun.rise, '05:04') && near(r.jun.set, '18:46'), `June solstice ${JSON.stringify(r.jun)}`);
    assert(near(r.dec.rise, '06:34') && near(r.dec.set, '17:09'), `December solstice ${JSON.stringify(r.dec)}`);
    const gain = mins(r.lo.rise) - mins(r.hi.rise);
    assert(gain >= 7 && gain <= 11 && mins(r.hi.set) > mins(r.lo.set), `elevation effect ${JSON.stringify(r)}`);   // dip 0.0293 deg x sqrt(3952 m) = 1.84 deg
    assert(mins(r.jun.dawn) < mins(r.jun.rise) && mins(r.jun.dusk) > mins(r.jun.set), 'civil twilight order');
  });

  await check('rain probability, UV and visibility layers; winds aloft; point card with sun times and aloft winds', async () => {
    // Winds aloft come from the pipeline (Open-Meteo, CI only): give the app a synthetic file when the local build has none.
    const real = fs.existsSync(path.join(SITE, 'data', 'aloft.json'));
    if (!real) {
      const a = await page.evaluate(async () => {
        const { S } = await import('./js/state.js');
        const w = S.wind || await (await fetch('data/wind.json')).json();
        const pts = {};
        w.mountains.slice(0, 40).forEach((m, i) => {
          const n = w.times.length; const col = (f) => Array.from({ length: n }, (_, j) => f(j));
          pts[m.k] = { vis: col((j) => [0.5, 4, 12, 30][(i + j) % 4]), uv: col(() => 6), fz: col(() => 4300),
            ws: [800, 1500, 3000, 5600].map((_, li) => col((j) => 3 + ((i + j + li) % 12))), wd: [0, 1, 2, 3].map((li) => col((j) => (j * 20 + li * 40) % 360)),
            z: [800, 1500, 3000, 5600].map((z) => col(() => z)) };
        });
        return { time: new Date().toISOString(), levels: [925, 850, 700, 500], times: w.times, points: pts };
      });
      await ctx.route(/data\/aloft\.json/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(a) }));
    }
    const filled = () => page.evaluate(async () => {
      const { S } = await import('./js/state.js');
      let n = 0; S.layer.overlay.eachLayer((l) => { if (l.eachLayer) l.eachLayer((p) => { if (p.options.fillOpacity > 0) n += 1; }); });
      return n;
    });
    await selectLayer('.chip[data-layer="pop"]');
    await page.waitForFunction(() => document.querySelector('#map-banner')?.textContent.includes('降雨機率'));
    assert((await filled()) > 100, 'rain probability layer has no coloured townships');
    assert((await page.$$eval('#legend summary .lg-strip .cells > span', (e) => e.length)) === 9, 'rain probability colour bar');
    await selectLayer('.chip[data-layer="uv"]');
    await page.waitForFunction(() => document.querySelector('#map-banner')?.textContent.includes('紫外線'));
    assert((await filled()) > 100, 'UV layer has no coloured townships');
    assert((await page.$$('#time-ctl [data-period]')).length >= 3, 'UV date buttons missing');
    await selectLayer('.chip[data-layer="visib"]');
    await page.waitForFunction(() => document.querySelector('#map-banner')?.textContent.includes('能見度'));
    await page.click('[data-vismode="fc"]');
    await page.waitForSelector('.vis-mk');
    assert((await page.$$('.vis-mk')).length >= 3, 'visibility forecast markers missing');
    const panel = await page.evaluate(async () => {
      const v = await import('./js/views.js'); const { S } = await import('./js/state.js');
      const al = await (await import('./js/aloft.js')).loadAloft();
      const key = Object.keys(al.points)[0];
      const sp = S.spots.find((x) => x.k === key);
      await v.showPoint(sp.lat, sp.lon, { spotKey: key });
      return { aloft: Boolean(document.querySelector('#h-aloft')), sun: Boolean(document.querySelector('#h-sun')), rows: document.querySelectorAll('[data-card="aloft"] table.aloft tbody tr').length };
    });
    assert(panel.aloft && panel.sun && panel.rows === 4, `point panel cards ${JSON.stringify(panel)}`);
    await page.click('#sheet-close').catch(() => {});
    await selectLayer('.chip[data-layer="radar"]');
  });

  await check('WRF winds aloft layer: level buttons, time slider, arrows; ensemble forecast card loads on request', async () => {
    if (!fs.existsSync(path.join(SITE, 'data', 'wrf.json'))) { console.log('SKIP wrf.json not built locally'); } else {
      await selectLayer('.chip[data-layer="wind"]');
      assert((await page.$$('.chip[data-layer="wrf"]')).length === 0, 'wind and WRF winds aloft must be one layer');
      await page.click('[data-windmode="aloft"]');
      await page.waitForSelector('#time-ctl [data-wrflevel]');
      assert((await page.$$('#time-ctl [data-wrflevel]')).length === 7, 'WRF level buttons missing');
      const lab = await page.$eval('#time-ctl [data-wrflevel]', (b) => ({ alt: b.querySelector('b')?.textContent, hpa: b.querySelector('.hpa')?.textContent }));
      assert(/m$/.test(lab.alt) && /hPa$/.test(lab.hpa), `altitude and hPa must be separate: ${JSON.stringify(lab)}`);
      await page.waitForSelector('.wind-mk');
      const n0 = (await page.$$('.wind-mk')).length;
      assert(n0 > 20, `WRF arrows: ${n0}`);
      await page.click('[data-wrflevel="3"]');
      await page.waitForFunction(() => document.querySelector('#map-banner')?.textContent.includes('500 hPa'));
      await page.$eval('#wrf-frame', (i) => { i.value = String(Number(i.max)); i.dispatchEvent(new Event('change', { bubbles: true })); });
      await page.waitForFunction(() => document.querySelector('#wrf-time') && document.querySelector('#wrf-frame').value === document.querySelector('#wrf-frame').max);
      await page.screenshot({ path: path.join(SHOTS, 'wrf.png') });
      await page.click('[data-windmode="fc"]');
      await page.waitForSelector('#wind-frame');
      await selectLayer('.chip[data-layer="radar"]');
    }
    // Ensemble API (browser side): synthetic answer in the Open-Meteo format, 6 members per model.
    await ctx.route(/ensemble-api\.open-meteo\.com/, (route) => {
      const model = new URL(route.request().url()).searchParams.get('models');
      const time = Array.from({ length: 240 }, (_, i) => new Date(Date.UTC(2026, 9, 27, 0, 0) + i * 3600e3).toISOString().slice(0, 13) + ':00');
      const hourly = { time };
      for (let m = 0; m < 6; m++) {
        const sfx = m === 0 ? '' : `_member${String(m).padStart(2, '0')}`;
        hourly[`temperature_2m${sfx}`] = time.map((_, i) => 20 + m * 0.5 - i * 0.02);
        hourly[`precipitation${sfx}`] = time.map((_, i) => (i % 24 === 0 ? m : 0));
        hourly[`wind_speed_10m${sfx}`] = time.map((_, i) => 3 + m + (i % 5));
      }
      route.fulfill({ status: model === 'gfs025' ? 200 : 200, contentType: 'application/json', body: JSON.stringify({ elevation: model === 'gfs025' ? 1000 : 800, hourly }) });
    });
    await page.evaluate(async () => { const v = await import('./js/views.js'); await v.showPoint(23.47, 120.957, { spotKey: 'mountain-D001' }); });
    await page.waitForSelector('#btn-ens', { state: 'attached' });       // inside a folded card until the shortcut opens it
    await page.click('#btn-ens-jump');       // shortcut at the top of the panel loads the same forecast
    await page.waitForSelector('#ens-out figure.chart');
    const ens = await page.evaluate(() => ({ charts: document.querySelectorAll('#ens-out figure.chart').length, text: document.querySelector('#ens-out').textContent }));
    assert(ens.charts === 3 && ens.text.includes('ECMWF') && ens.text.includes('GFS') && ens.text.includes('6 個成員'), `ensemble charts ${JSON.stringify(ens)}`);
    await page.click('#sheet-close').catch(() => {});
  });

  await check('water level, reservoir release and debris-flow layers; hydro card in the point panel', async () => {
    const h = await page.evaluate(async () => {
      const { S } = await import('./js/state.js');
      const m = S.spots.filter((x) => x.c === 'mountain').slice(0, 8);
      const f = S.towns[0].properties;
      return { time: new Date().toISOString(),
        debris: [{ no: 'T1', level: 'red', type: 'D', county: f.COUNTYNAME, town: f.TOWNNAME, village: '測試村' }],
        rivers: m.map((x, i) => ({ id: `T${i}`, n: `測試站${i}`, river: '測試溪', lat: x.lat + 0.01, lon: x.lon + 0.01, t: new Date().toISOString(), wl: 1 + i, a1: 7.5, a2: 5.5, a3: 3.5 })),
        reservoirs: S.spots.filter((x) => x.c === 'reservoir').slice(0, 4).map((x, i) => ({ id: `R${i}`, n: x.n, lat: x.lat, lon: x.lon, t: new Date().toISOString(), wl: 200 + i, vol: 5, cap: 10, inflow: 3, outflow: i * 5, spill: i === 3 ? 8 : 0, plan: i === 2 ? 20 : 0, planT: null })) };
    });
    await ctx.route(/data\/hydro\.json/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(h) }));
    await page.evaluate(async () => { const { S } = await import('./js/state.js'); S.hydro = null; });
    await selectLayer('.chip[data-layer="water"]');
    await page.waitForSelector('.vis-mk');
    const rivers = await page.$$eval('.vis-mk', (e) => e.length);
    assert(rivers >= 4, `river markers: ${rivers}`);
    assert((await page.$$eval('#legend summary .lg-strip .cells > span', (e) => e.length)) === 4, 'water colour bar');
    await page.click('[data-watermode="rsv"]');
    await page.waitForFunction(() => document.querySelector('#map-banner')?.textContent.includes('水庫'));
    assert((await page.$$eval('.vis-mk.alert', (e) => e.length)) >= 1, 'reservoir release markers missing');
    await selectLayer('.chip[data-layer="debris"]');
    await page.waitForFunction(() => document.querySelector('#map-banner')?.textContent.includes('土石流'));
    const col = await page.evaluate(async () => {
      const { S } = await import('./js/state.js');
      let n = 0; S.layer.overlay.eachLayer((g) => { if (g.eachLayer) g.eachLayer((p) => { if (p.options.fillOpacity > 0) n += 1; }); });
      return n;
    });
    assert(col >= 1, `debris-flow alert townships coloured: ${col}`);
    const card = await page.evaluate(async () => {
      const v = await import('./js/views.js'); const { S } = await import('./js/state.js');
      const r = S.hydro.rivers[0];
      await v.showPoint(r.lat, r.lon, {});
      return Boolean(document.querySelector('#h-hydro'));
    });
    assert(card, 'hydro card missing in the point panel');
    await page.click('#sheet-close').catch(() => {});
    await selectLayer('.chip[data-layer="radar"]');
  });

  await check('point panel cards: themed groups, folded cards carry a summary, open state is remembered, jump chips, expand / collapse all', async () => {
    await page.evaluate(() => localStorage.removeItem('hikingwx.cards.v1'));
    const show = () => page.evaluate(async () => {
      const v = await import('./js/views.js'); const { S } = await import('./js/state.js');
      const sp = S.spots.find((x) => x.c === 'mountain');
      await v.showPoint(sp.lat, sp.lon, { spotKey: sp.k });
    });
    await show();
    await page.waitForSelector('#sheet.open details.pcard');
    const info = await page.evaluate(() => ({
      cards: [...document.querySelectorAll('#sheet-body details.pcard')].map((d) => ({ id: d.dataset.card, grp: d.dataset.grp, open: d.open, sum: d.querySelector('.pc-s')?.textContent || '' })),
      bar: (() => { const a = document.querySelector('.ptbar .acts').getBoundingClientRect(); const b = document.querySelector('.ptbar').getBoundingClientRect(); return { right: Math.round(b.right - a.right), n: document.querySelectorAll('.ptbar .acts .ab').length }; })(),
    }));
    const groups = new Set(info.cards.map((c) => c.grp));
    assert(info.cards.length >= 8 && ['safe', 'obs', 'fc', 'sun'].every((g) => groups.has(g)), `cards ${JSON.stringify(info.cards.map((c) => c.id))}`);
    const folded = info.cards.filter((c) => !c.open && ['now', 'rain', 'sun', 'ens'].includes(c.id));
    assert(folded.length >= 2 && folded.every((c) => c.sum.length > 3), `folded cards lack a summary: ${JSON.stringify(folded)}`);
    assert(info.bar.n === 3 && info.bar.right <= 4, `Windy / coordinates / favourite buttons not right-aligned: ${JSON.stringify(info.bar)}`);
    assert(info.cards.find((c) => c.id === 'stations')?.open && info.cards.find((c) => c.id === 'fc')?.open && !info.cards.find((c) => c.id === 'sun')?.open, 'default open / folded cards');
    // remembered: open the sun card, reopen the panel
    await page.click('[data-card="sun"] > summary');
    await show();
    await page.waitForSelector('#sheet.open details.pcard');
    assert(await page.$eval('[data-card="sun"]', (d) => d.open), 'the open state of a card was not remembered');
    await page.click('[data-cards="close"]');
    assert((await page.$$eval('details.pcard[open]:not([data-alert])', (e) => e.length)) === 0, 'collapse all');
    await page.click('[data-jump="fc"]');
    assert(await page.$eval('details.pcard[data-grp="fc"]', (d) => d.open), 'jump chip should open the first card of the group');
    await page.click('[data-cards="open"]');
    assert((await page.$$eval('details.pcard:not([open])', (e) => e.length)) === 0, 'expand all');
    await page.screenshot({ path: path.join(SHOTS, 'point-cards.png') });
    await page.evaluate(() => localStorage.removeItem('hikingwx.cards.v1'));
    await page.click('#sheet-close').catch(() => {});
  });

  await check('gust note belongs to the 3-day tab only, not the one-week tab', async () => {
    await page.evaluate(async () => {
      const v = await import('./js/views.js'); const { S } = await import('./js/state.js');
      const sp = S.spots.find((x) => x.c === 'mountain');
      await v.showPoint(sp.lat, sp.lon, { spotKey: sp.k });
    });
    await page.waitForSelector('[data-panel="d3"] table');
    const r = await page.evaluate(() => {
      const inD3 = document.querySelector('[data-panel="d3"] .note')?.textContent.includes('陣風：Open-Meteo') ?? false;
      const outside = [...document.querySelectorAll('#sheet-body .note')].filter((n) => n.textContent.includes('陣風：Open-Meteo') && !n.closest('[data-panel]')).length;
      const inWeek = document.querySelector('[data-panel="week"]')?.textContent.includes('陣風：Open-Meteo') ?? false;
      return { inD3, outside, inWeek, hasGust: Boolean(document.querySelector('[data-panel="d3"]')?.textContent.includes('陣風')) };
    });
    assert(r.outside === 0 && !r.inWeek && (!r.hasGust || r.inD3), `gust note placement ${JSON.stringify(r)}`);
    await page.click('#sheet-close').catch(() => {});
  });

  await check('observation data open by default with temperature, rain, wind and humidity charts', async () => {
    await page.evaluate(() => localStorage.removeItem('hikingwx.cards.v1'));
    const sid = await page.evaluate(async () => {
      const { S } = await import('./js/state.js'); const v = await import('./js/views.js');
      for (const st of S.stations.filter((x) => x.T !== undefined && x.RH !== undefined && x.WS !== undefined && x.k !== 'rain').slice(0, 60)) {
        const h = await fetch(`data/hist/${st.id}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (h && ['T', 'RH', 'WS'].every((f) => h.fields[f]?.some((x) => x !== null))) { await v.showPoint(st.lat, st.lon, { stationId: st.id, label: `${st.n}測站` }); return st.id; }
      }
      return null;
    });
    if (!sid) { console.log('SKIP no station with a history series locally'); return; }
    await page.waitForSelector('#hist-out figure.chart', { timeout: 20000 });
    assert(await page.$eval('details.sub[data-sub="hist"]', (d) => d.open), 'the observation data section should be open by default');
    const titles = await page.$$eval('#hist-out figure.chart figcaption strong', (e) => e.map((x) => x.textContent));
    assert(['溫度', '風速', '相對濕度'].every((t) => titles.includes(t)), `charts ${titles}`);
    assert(/海拔/.test(await page.$eval('#hist-sid', (e) => e.selectedOptions[0].textContent)), 'station elevation missing in the observation selector');
    const head = await page.$$eval('#hist-out details.tbl th[scope="col"]', (e) => e.map((x) => x.textContent));
    assert(['風向', '風速m/s', '風力級', '陣風m/s', '陣風級'].every((c) => head.includes(c)), `data table columns ${head}`);
    const line = await page.$eval('[data-card="stations"] ul.stations, [data-card="station"]', (e) => e.textContent);
    assert(line.includes('%') || line.includes('濕度') || (await page.$('[data-card="station"] .tile')), 'humidity missing from the station values');
    await page.click('#sheet-close').catch(() => {});
  });

  await check('search history: remembered, shown on an empty box, deletable one by one and all', async () => {
    await page.evaluate(() => localStorage.removeItem('hikingwx.searchHistory.v1'));
    await page.fill('#q', '玉山');
    await page.waitForSelector('#q-results li[data-i]');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#sheet.open', { timeout: 20000 });
    await page.click('#sheet-close').catch(() => {});
    await page.fill('#q', '');
    await page.focus('#q');
    await page.waitForSelector('#q-results li.hist');
    assert((await page.textContent('#q-results li.hist')).includes('玉山'), 'the search was not remembered');
    await page.fill('#q', '鹿林');
    await page.waitForSelector('#q-results li[data-i]');
    await page.keyboard.press('Enter');
    await page.click('#sheet-close').catch(() => {});
    await page.fill('#q', '');
    await page.focus('#q');
    await page.waitForFunction(() => document.querySelectorAll('#q-results li.hist').length === 2);
    assert((await page.$eval('#q-results li.hist', (e) => e.textContent)).includes('鹿林'), 'newest search first');
    await page.click('#q-results li.hist [data-hdel="0"]');                    // delete the newest one
    await page.waitForFunction(() => document.querySelectorAll('#q-results li.hist').length === 1);
    assert((await page.$eval('#q-results li.hist', (e) => e.textContent)).includes('玉山'), 'the wrong entry was deleted');
    await page.click('#q-results li.hist .tag, #q-results li.hist');           // choosing an entry searches again
    await page.waitForSelector('#q-results li[data-i]');
    assert((await page.inputValue('#q')) === '玉山', 'history entry should fill the search box');
    await page.fill('#q', '');
    await page.focus('#q');
    await page.click('#q-results .hist-clear');
    assert((await page.evaluate(() => JSON.parse(localStorage.getItem('hikingwx.searchHistory.v1') || '[]').length)) === 0, 'clear all');
    await page.keyboard.press('Escape');
  });

  await check('nearby places do not list the place itself', async () => {
    const r = await page.evaluate(async () => {
      const v = await import('./js/views.js'); const { S } = await import('./js/state.js');
      const sp = S.spots.find((x) => x.c === 'forest' || x.c === 'np') || S.spots.find((x) => x.c === 'mountain');
      await v.showPoint(sp.lat, sp.lon, { spotKey: sp.k });
      const names = [...document.querySelectorAll('[data-card="near"] li button')].map((b) => b.textContent);
      return { name: sp.n, names, keys: [...document.querySelectorAll('[data-card="near"] li button')].map((b) => b.dataset.spot), key: sp.k };
    });
    assert(!r.keys.includes(r.key) && !r.names.includes(r.name), `the place lists itself: ${JSON.stringify(r)}`);
    await page.click('#sheet-close').catch(() => {});
  });

  await check('gusts (model) and apparent temperature in the wind layer, forecast tables and station card', async () => {
    const w = JSON.parse(fs.readFileSync(path.join(SITE, 'data', 'wind.json'), 'utf-8'));
    w.gustSource = { name: 'Open-Meteo', license: 'CC BY 4.0', time: new Date().toISOString() };
    const fill = (cols) => { cols[3] = cols[0].map((v) => (v === null ? null : v * 2 + 1)); };
    Object.values(w.towns).forEach(fill);                 // model gusts exist for townships only (summits get none)
    await ctx.route(/data\/wind\.json/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(w) }));
    await page.reload();
    await page.waitForSelector('body.ready');
    const tip = await page.evaluate(async () => {
      const { S } = await import('./js/state.js'); const l = await import('./js/layers.js');
      await l.loadWind();
      const cols = Object.values(S.wind.towns).find((c) => c[0].some((v) => v !== null));
      const i = cols[0].findIndex((v) => v !== null);
      const m = S.wind.mountains.find((x) => x.w[0].some((v) => v !== null));
      return { town: l.windText(cols, i), mountain: l.windText(m.w, m.w[0].findIndex((v) => v !== null)) };
    });
    assert(tip.town.includes('陣風') && tip.town.includes('體感'), `township wind tooltip text: ${tip.town}`);
    assert(!tip.mountain.includes('陣風'), `a summit must not show model gusts: ${tip.mountain}`);
    // a township point shows the gust row with its source; a summit's own forecast table has none
    const tp = await page.evaluate(async () => {
      const { S } = await import('./js/state.js');
      const code = Object.keys(S.wind.towns).find((c) => S.wind.towns[c][0].some((v) => v !== null));
      const d = await (await fetch(`data/towns/${code}.json`)).json();
      return { lat: Number(d.lat), lon: Number(d.lon) };
    });
    await page.evaluate(async (p) => { const v = await import('./js/views.js'); await v.showPoint(p.lat, p.lon); }, tp);
    await page.waitForSelector('#sheet.open table.fc');
    const t = await page.textContent('#sheet-body');
    assert(t.includes('陣風') && t.includes('Open-Meteo') && t.includes('平地'), 'gust row / source note missing from the township forecast table');
    assert(t.includes('體感'), 'apparent temperature missing');
    await page.click('#sheet-close');
    const spot = await page.evaluate(async () => (await import('./js/state.js')).S.wind.mountains[0]);
    await page.evaluate(async (sp) => { const v = await import('./js/views.js'); await v.showPoint(sp.lat, sp.lon, { spotKey: sp.k }); }, spot);
    await page.waitForSelector('#sheet.open [data-panel="d3"] table.fc');
    assert(!(await page.textContent('[data-card="fc"] [data-panel="d3"] table.fc')).includes('陣風'), 'a mountain forecast table must not carry model gusts');
    await page.click('#sheet-close');
    const st = await page.evaluate(async () => (await import('./js/state.js')).S.stations.find((s) => s.T !== undefined && s.RH !== undefined && s.WS !== undefined));
    if (st) {
      await page.evaluate(async (s) => { const v = await import('./js/views.js'); await v.showPoint(s.lat, s.lon, { stationId: s.id, label: s.n }); }, st);
      await page.waitForSelector('#h-stn');
      assert((await page.textContent('[data-card="station"]')).includes('體感（估算）'), 'station apparent temperature missing');
      await page.click('#sheet-close');
    }
    await ctx.unroute(/data\/wind\.json/);
    await page.reload();
    await page.waitForSelector('body.ready');
  });

  await check('lightning layer: strikes by age; nearby strikes raise the hiking risk', async () => {
    const now = Date.now();
    const iso = (m) => new Date(now - m * 60e3).toISOString();
    const lt = { start: iso(60), end: iso(0), count: 2, strikes: [
      { lat: 23.48, lon: 120.95, t: iso(3), cloud: false, ka: -31.2 }, { lat: 23.6, lon: 121.1, t: iso(45), cloud: true, ka: null }] };
    await ctx.route(/data\/lightning\.json/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(lt) }));
    await page.reload();
    await page.waitForSelector('body.ready');
    await selectLayer('.chip[data-layer="lightning"]');
    await page.waitForSelector('.lt-mk');
    assert((await page.$$('.lt-mk')).length === 2 && (await page.$$('.lt-mk.cloud')).length === 1, 'strike markers');
    assert((await page.textContent('#map-banner')).includes('2 次'), 'legend count');
    await page.evaluate(async () => { const v = await import('./js/views.js'); await v.showPoint(23.47, 120.957); });
    await page.waitForSelector('#sheet.open #h-risk');
    assert((await page.textContent('#sheet-body')).includes('閃電'), 'lightning not in the risk reasons');
    await page.click('#sheet-close');
    await ctx.unroute(/data\/lightning\.json/);
    await page.reload();
    await page.waitForSelector('body.ready');
    await selectLayer('.chip[data-layer="radar"]');
  });

  await check('Taiwan centred after a reload; my position shown as a white dot', async () => {
    await page.reload();
    await page.waitForSelector('body.ready');
    await page.waitForTimeout(800);
    const c = await page.evaluate(async () => {
      const { S } = await import('./js/state.js');
      const m = document.getElementById('map').getBoundingClientRect();
      const p = S.map.latLngToContainerPoint([23.75, 121.0]);
      return { dx: Math.abs(p.x - m.width / 2), dy: Math.abs(p.y - m.height / 2) };
    });
    assert(c.dx < 3 && c.dy < 3, `Taiwan not in the middle of the map: ${JSON.stringify(c)}`);
    await ctx.grantPermissions(['geolocation']);
    await ctx.setGeolocation({ latitude: 24.38, longitude: 121.23, accuracy: 30 });
    await page.click('#btn-locate');
    await page.waitForSelector('.my-loc span');
    await page.waitForSelector('#sheet.open #h-risk');
    const bg = await page.$eval('.my-loc span', (e) => getComputedStyle(e).backgroundColor);
    assert(bg === 'rgb(255, 255, 255)', `dot colour ${bg}`);
    await page.click('#sheet-close').catch(() => {});
  });

  await check('quake badges, mountains snapped/deduplicated, spot township in search, marker toggle order', async () => {
    await page.click('#sheet-close').catch(() => {});
    const st = await page.evaluate(async () => {
      const { S } = await import('./js/state.js');
      const v = await import('./js/views.js');
      const sp = S.spots.find((p) => p.c === 'mountain' && p.a);
      const r = sp ? v.search(sp.n).find((x) => x.spot === sp.k) : null;
      const recentQ = S.quakes.filter((q) => Date.now() - new Date(q.time).getTime() < 7 * 864e5).length;
      return { sub: r?.sub || '', name: sp?.n, recentQ, badges: document.querySelectorAll('.eq-mk').length };
    });
    assert(st.sub.includes('縣') || st.sub.includes('市'), `spot search result without township: ${JSON.stringify(st)}`);
    assert(st.recentQ === 0 || st.badges > 0, 'earthquake badges missing');
    const order = await page.$$eval('[data-ov]', (e) => e.map((x) => x.dataset.ov));
    assert(order.join() === 'stations,quakes,typhoon,mountains,spots,peaks', `toggle order ${order}`);
    if (!(await page.isVisible('#toggles'))) await page.click('#btn-more');
    await page.click('.cat-legend summary');
    await page.screenshot({ path: path.join(SHOTS, 'icon-legend.png') });
    await page.click('.cat-legend summary');
    await page.click('#btn-more');
  });

  await check('favourites: star in search results and in the panel header; selected point highlighted', async () => {
    await page.click('#sheet-close').catch(() => {});
    await page.evaluate(async () => { const st = await import('./js/store.js'); await Promise.all((await st.listFav()).map((f) => st.deleteFav(f.id))); });
    await page.fill('#q', '鹿林');
    await page.waitForSelector('#q-results .fav-btn');
    await page.click('#q-results [data-fav="0"]');
    await page.waitForFunction(() => document.querySelector('#q-results [data-fav="0"]')?.getAttribute('aria-pressed') === 'true');
    assert(!(await page.isVisible('#sheet.open')), 'the star in the results must not open the place');
    assert((await page.evaluate(async () => (await import('./js/store.js')).listFav().then((f) => f.length))) === 1, 'favourite not saved from the search list');
    // choosing the result: highlight + header star already filled
    await page.click('#q-results li[data-i="0"] >> text=鹿林');
    await page.waitForSelector('#sheet.open #btn-fav');
    await page.waitForFunction(() => document.getElementById('btn-fav')?.getAttribute('aria-pressed') === 'true');
    assert((await page.$$('.pick-mk')).length === 1, 'selected point is not highlighted on the map');
    await page.waitForTimeout(1500);
    const vis = await page.evaluate(() => {
      const p = document.querySelector('.pick-mk').getBoundingClientRect(); const sh = document.getElementById('sheet').getBoundingClientRect();
      const m = document.getElementById('map').getBoundingClientRect();
      return { room: sh.top - m.top, ok: p.bottom <= sh.top + 2 && p.top >= 0 };
    });
    // With 200 % text and two banners the map above the panel can be too short to show anything: only check when there is room.
    assert(vis.room < 160 || vis.ok, 'the highlighted point is hidden behind the panel');
    await page.screenshot({ path: path.join(SHOTS, 'pick-highlight.png') });
    await page.click('#btn-fav');
    await page.waitForFunction(() => document.getElementById('btn-fav')?.getAttribute('aria-pressed') === 'false');
    assert((await page.evaluate(async () => (await import('./js/store.js')).listFav().then((f) => f.length))) === 0, 'header star did not remove the favourite');
    await page.click('#btn-fav');
    await page.waitForFunction(() => document.getElementById('btn-fav')?.getAttribute('aria-pressed') === 'true');
    await page.click('#sheet-close');
    assert((await page.$$('.pick-mk')).length === 0, 'highlight should be removed when the panel closes');
    assert(!(await page.isVisible('#sheet-fav')), 'header star should be hidden without a panel');
    // the saved favourite reopens the same place (with its peak panel)
    await page.click('#btn-recent');
    await page.click('[data-kind="fav"][data-rid] >> nth=0');
    await page.waitForSelector('#sheet.open #h-tfc');
    await page.click('#sheet-close');
    await page.evaluate(async () => { const st = await import('./js/store.js'); await Promise.all((await st.listFav()).map((f) => st.deleteFav(f.id))); });
    await page.fill('#q', '');
  });

  await check('a plain tap or a peak without forecast shows its own data; nearest forecast mountains are listed below', async () => {
    await page.click('#sheet-close').catch(() => {});
    const m = await page.evaluate(async () => {
      const { S } = await import('./js/state.js');
      const sp = S.spots.find((p) => p.c === 'mountain');
      return { k: sp.k, n: sp.n, lat: sp.lat + 0.012, lon: sp.lon + 0.012 };   // about 1.7 km from a forecast mountain
    });
    await page.evaluate(async (p) => { const v = await import('./js/views.js'); await v.showPoint(p.lat, p.lon); }, m);
    await page.waitForSelector('#sheet.open #h-nmf');
    assert((await page.textContent('#sheet-title')) !== m.n, 'the tap jumped to the nearby forecast mountain');
    assert((await page.textContent('#sheet-sub')).includes('非預報點'), 'header hint missing for a plain tap');
    assert(!(await page.$('#h-fc')), 'a tap near a mountain must not open that mountain\'s forecast');
    assert(await page.$('[data-card="mtnfc"] ul [data-spot]'), 'nearby mountain list missing');
    assert((await page.$('#h-tfc')) !== null, 'the township forecast should stay');
    const txt = await page.textContent('#sheet-body');
    assert(txt.includes('°C') && txt.includes('降雨機率'), 'nearby mountain forecast summary missing');
    await page.click('[data-card="mtnfc"] > summary');                  // folded by default
    await page.click('[data-card="mtnfc"] button[data-spot]');
    await page.waitForSelector('#h-fc');
    assert(!(await page.isVisible('#sheet-sub')), 'a forecast mountain needs no hint');
    await page.click('#sheet-close');
  });

  await check('temperature layer is cut to the real coastline: land opaque, sea and gaps fixed', async () => {
    const r = await page.evaluate(async () => {
      const { S } = await import('./js/state.js'); const L2 = await import('./js/layers.js'); const G = await import('./js/grid.js'); const P = await import('./js/palettes.js');
      const g = await L2.getGrid('grids/temp.json');
      const cv = G.renderGrid(g, P.colourFn(P.scaleFor('temp', 'cwa')), { smooth: true, landClip: S.counties, extend: 2, maxK: 8 });
      const [w, so, e, n] = g.bounds; const my = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
      const ctx = cv.getContext('2d');
      const alpha = (lat, lon) => ctx.getImageData(Math.round((lon - w) / (e - w) * (cv.width - 1)), Math.round((my(n) - my(lat)) / (my(n) - my(so)) * (cv.height - 1)), 1, 1).data[3];
      const raw = G.renderGrid(g, P.colourFn(P.scaleFor('temp', 'cwa')), { smooth: true });
      return { taipei: alpha(25.04, 121.52), toucheng: alpha(24.86, 121.82), guishan: alpha(24.847, 121.95), sea: alpha(24.7, 122.3), strait: alpha(24.2, 119.5), mid: alpha(23.5, 121.0), size: [cv.width, cv.height], rawSize: [raw.width, raw.height] };
    });
    assert(r.taipei === 255 && r.toucheng === 255 && r.mid === 255, `land must be opaque: ${JSON.stringify(r)}`);
    assert(r.guishan === 255, `Guishan island must be shown: ${JSON.stringify(r)}`);
    assert(r.sea === 0 && r.strait === 0, `sea must be transparent: ${JSON.stringify(r)}`);
  });

  await check('satellite pictures are smooth: visible albedo and IR use many grey levels, not ten bands', async () => {
    const r = await page.evaluate(async () => {
      const L2 = await import('./js/layers.js'); const G = await import('./js/grid.js'); const P = await import('./js/palettes.js');
      const levels = async (path, kind) => {
        const g = await L2.getGrid(path);
        const cv = G.renderGrid(g, P.colourFn(P.scaleFor(kind, 'cwa')), { smooth: true });
        const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
        const set = new Set();
        for (let i = 0; i < d.length; i += 4 * 7) if (d[i + 3]) set.add(d[i]);
        return set.size;
      };
      const night = Boolean((await L2.getGrid('grids/sat_vis.json')).meta?.note);   // at night the visible picture is uniformly black
      return { vis: night ? 99 : await levels('grids/sat_vis.json', 'vis'), ir: await levels('grids/sat_ir.json', 'irgray') };
    });
    assert(r.vis >= 60 && r.ir >= 60, `satellite images look posterised: ${JSON.stringify(r)}`);
  });

  await check('satellite layer draws county / island outlines above the picture', async () => {
    await page.evaluate(async () => { const L2 = await import('./js/layers.js'); await L2.showLayer('sat'); });
    await page.waitForTimeout(800);
    const n = await page.evaluate(async () => {
      const St = await import('./js/state.js');
      let c = 0; St.S.layer.overlay.eachLayer((l) => { if (l.options?.pane === 'outline') c++; });
      return c;
    });
    assert(n === 2, `satellite outline layers missing (${n})`);
    await page.screenshot({ path: path.join(SHOTS, 'sat-outline.png') });
  });

  await check('layer bar collapses for a larger map and comes back from the map button; state persists', async () => {
    const h0 = (await page.locator('#map').boundingBox()).height;
    await page.click('#btn-bar-hide');
    await page.waitForTimeout(200);
    assert(!(await page.isVisible('#controls')), 'layer bar still visible');
    const h1 = (await page.locator('#map').boundingBox()).height;
    assert(h1 > h0 + 40, `map did not grow (${h0} -> ${h1})`);
    assert((await page.textContent('#btn-bar-show')).includes('圖層'), 'restore button missing');
    await page.screenshot({ path: path.join(SHOTS, 'bar-hidden.png') });
    await page.reload();
    await page.waitForSelector('body.ready');
    assert(!(await page.isVisible('#controls')), 'collapsed state not kept after reload');
    await page.click('#btn-bar-show');
    await page.waitForSelector('#controls', { state: 'visible' });
    assert(!(await page.isVisible('#btn-bar-show')), 'restore button still shown');
  });

  await check('OSM peaks: markers from zoom 11, peak panel shows the nearby township forecast', async () => {
    await page.click('#sheet-close').catch(() => {});
    const n = await page.evaluate(async () => (await import('./js/state.js')).S.peaks.length);
    assert(n > 0, 'no peaks loaded');
    await page.evaluate(async () => { const { S } = await import('./js/state.js'); S.map.setView([23.47, 120.9], 12, { animate: false }); });
    await page.waitForFunction(() => document.querySelectorAll('.pin-peak').length > 0);
    await page.evaluate(async () => {
      const { S } = await import('./js/state.js'); const v = await import('./js/views.js');
      const p = S.peaks[0];
      await v.showPoint(p.lat, p.lon, { peak: p });
    });
    await page.waitForSelector('#h-tfc');
    const h = await page.textContent('#h-tfc');
    assert(h.includes('鄰近鄉鎮預報'), `heading ${h}`);
    assert(!(await page.$('#h-fc')), 'a CWA spot forecast should not be shown for an OSM peak');
    assert((await page.textContent('#sheet-sub')).includes('無氣象署預報'), 'header hint missing for a peak without forecast');
    const attr = await page.textContent('.leaflet-control-attribution');
    assert(attr.includes('ODbL'), 'OSM peak attribution missing');
    const res = await page.evaluate(async () => (await import('./js/views.js')).search('鹿林').map((r) => ({ type: r.type, sub: r.sub || '' })));
    assert(res.some((r) => r.type === '山'), 'peak not found by search');
    assert(res.some((r) => r.sub.includes('阿里山鄉') && r.sub.includes('測試清單')), `peak township / list tag missing: ${JSON.stringify(res)}`);
    const est = await page.evaluate(async () => (await import('./js/views.js')).search('麟趾').find((r) => r.peak)?.label || '');
    assert(est.includes('約'), `estimated elevation must be marked: ${est}`);
    await page.fill('#q', '鹿林山');
    await page.waitForSelector('#q-results .sub');
    await page.screenshot({ path: path.join(SHOTS, 'search-peak-area.png') });
    await page.fill('#q', '');
    await page.click('#sheet-close');
  });

  await check('OpenCycleMap without a key falls back to the Taiwan e-map with a notice', async () => {
    await page.click('#btn-settings');
    await page.fill('#set-tfkey', '');
    await page.dispatchEvent('#set-tfkey', 'change');
    await page.selectOption('#set-base', 'cycle');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.base-note');
    const src = await page.$eval('.leaflet-tile-pane img', (i) => i.src).catch(() => '');
    assert(!src.includes('thunderforest'), 'keyless Thunderforest tiles requested');
    await page.click('#btn-settings');
    await page.selectOption('#set-base', 'topo');
    await page.keyboard.press('Escape');
    assert(!(await page.$('.base-note')), 'notice remains after switching back');
  });

  await check('earthquake banner and tab only with a felt quake in the last 24 h; not in the alerts panel', async () => {
    await page.click('#sheet-close').catch(() => {});
    const recent = await page.evaluate(async () => (await import('./js/state.js')).S.quakes.filter((q) => Date.now() - new Date(q.time).getTime() < 864e5).length);
    assert((await page.$('#eq-banner')) !== null === recent > 0, 'banner presence does not match recent quakes');
    assert((await page.getAttribute('#btn-quake', 'hidden')) === null === recent > 0, 'quake tab visibility does not match');
    if (recent) {
      await page.click('#eq-banner');
      await page.waitForFunction(() => /地震/.test(document.getElementById('sheet-title')?.textContent || ''));
      await page.click('#sheet-close');
    }
    await page.click('#btn-alerts');
    await page.waitForSelector('#btn-allq');
    assert(!(await page.textContent('#sheet-body')).includes('近 3 天地震'), 'quakes still listed in the alerts panel');
    await page.click('#btn-allq');
    await page.waitForFunction(() => document.getElementById('sheet-title')?.textContent === '地震報告');
    await page.click('#sheet-close');
  });

  await check('UI style: text <-> icon switch (tab bar, icon tiles) persists', async () => {
    await openOptions(page);
    assert(!(await page.$('#more #set-theme')), 'full display settings should stay in 設定');
    await page.click('#opts-ui [data-ui="icon"]');
    await page.click('#btn-more');
    assert((await page.getAttribute('html', 'data-ui')) === 'icon', 'data-ui not icon');
    assert(await page.$('#tabbar .actions-top #btn-settings'), 'actions not moved to the tab bar');
    assert(await page.isVisible('#tabbar'), 'tab bar hidden');
    const ic = await page.$eval('.chip[data-layer="radar"]', (el) => getComputedStyle(el, '::before').maskImage || getComputedStyle(el, '::before').webkitMaskImage);
    assert(ic && ic.includes('svg'), `chip icon missing: ${ic}`);
    await page.screenshot({ path: path.join(SHOTS, 'ui-icon-mobile.png') });
    await page.reload();
    await page.waitForSelector('body.ready');
    assert((await page.getAttribute('html', 'data-ui')) === 'icon', 'icon UI not persisted');
    await openOptions(page);
    await page.click('#opts-ui [data-ui="text"]');
    await page.click('#btn-more');
    assert(await page.$('.topbar > .actions-top #btn-settings'), 'actions not back in the top bar');
    assert(!(await page.isVisible('#tabbar')), 'tab bar visible in text UI');
  });

  await check('OpenCycleMap basemap uses the Thunderforest key from settings', async () => {
    const seen = [];
    await ctx.route(/tile\.thunderforest\.com/, (r) => { seen.push(r.request().url()); r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64') }); });
    await page.click('#btn-settings');
    await page.waitForSelector('#set-tfkey');
    await page.fill('#set-tfkey', 'TESTKEY');
    await page.dispatchEvent('#set-tfkey', 'change');
    await page.selectOption('#set-base', 'cycle');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1500);
    assert(seen.length > 0, 'no Thunderforest tile requested');
    assert(seen.every((u) => u.includes('/cycle/') && u.includes('apikey=TESTKEY')), `bad tile url ${seen[0]}`);
    const attr = await page.textContent('.leaflet-control-attribution');
    assert(attr.includes('Thunderforest'), 'Thunderforest attribution missing');
    await page.click('#btn-settings');
    await page.selectOption('#set-base', 'topo');
    await page.keyboard.press('Escape');
    await ctx.unroute(/tile\.thunderforest\.com/);
  });

  await check('Thunderforest Landscape and Outdoors basemaps share the key; keyless falls back', async () => {
    const seen = [];
    await ctx.route(/tile\.thunderforest\.com/, (r) => { seen.push(r.request().url()); r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG1, 'base64') }); });
    await page.click('#btn-settings');
    await page.fill('#set-tfkey', 'TESTKEY');
    await page.dispatchEvent('#set-tfkey', 'change');
    for (const style of ['landscape', 'outdoors']) {
      await page.selectOption('#set-base', style);
      await page.waitForTimeout(1200);
      assert(seen.some((u) => u.includes(`/${style}/`) && u.includes('apikey=TESTKEY')), `no ${style} tile requested`);
    }
    await page.fill('#set-tfkey', '');
    await page.dispatchEvent('#set-tfkey', 'change');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.base-note');
    assert((await page.textContent('.base-note')).includes('Outdoors'), 'keyless notice does not name the map');
    await page.click('#btn-settings');
    await page.selectOption('#set-base', 'topo');
    await page.keyboard.press('Escape');
    await ctx.unroute(/tile\.thunderforest\.com/);
  });

  await check('Thunderforest quota used up: the map falls back to the Taiwan e-map and remembers it for a while', async () => {
    const seen = [];
    await ctx.route(/tile\.thunderforest\.com/, (r) => { seen.push(r.request().url()); r.fulfill({ status: 429, contentType: 'text/plain', body: 'quota exceeded' }); });
    await page.evaluate(() => localStorage.removeItem('hikingwx.tfOver.v1'));
    await page.click('#btn-settings');
    await page.waitForSelector('#set-tfkey');
    await page.fill('#set-tfkey', 'QUOTAKEY');                // a key no earlier test used, so no tile comes from the browser cache
    await page.dispatchEvent('#set-tfkey', 'change');
    await page.selectOption('#set-base', 'outdoors');
    await page.keyboard.press('Escape');
    const state = () => page.evaluate(() => ({ note: document.querySelector('.base-note')?.textContent || '', over: localStorage.getItem('hikingwx.tfOver.v1'), base: JSON.parse(localStorage.getItem('hikingwx.settings.v1') || '{}').basemap,
      imgs: [...document.querySelectorAll('.leaflet-tile-pane img')].map((i) => i.src.slice(8, 40)).slice(0, 4) }));
    try {
      await page.waitForFunction(() => document.querySelector('.base-note')?.textContent.includes('額度'), null, { timeout: 20000 });
      await page.waitForFunction(() => [...document.querySelectorAll('.leaflet-tile-pane img')].some((i) => i.src.includes('nlsc.gov.tw')), null, { timeout: 15000 });
    } catch (e) { throw new Error(`${e.message.split('\n')[0]} state=${JSON.stringify(await state())} requests=${seen.length}`); }
    assert((await page.evaluate(() => Boolean(localStorage.getItem('hikingwx.tfOver.v1')))), 'the fallback was not remembered');
    seen.length = 0;
    await page.reload();                                      // within the retry window: no more requests to the exhausted service
    await page.waitForSelector('body.ready');
    await page.waitForTimeout(1500);
    assert(seen.length === 0, `Thunderforest was asked again after the quota fallback: ${seen.length} requests`);
    assert((await page.textContent('.base-note')).includes('額度'), 'notice missing after reload');
    await page.click('#btn-settings');
    await page.selectOption('#set-base', 'topo');             // choosing a map clears the fallback
    await page.keyboard.press('Escape');
    assert((await page.evaluate(() => localStorage.getItem('hikingwx.tfOver.v1'))) === null, 'choosing a map should clear the fallback');
    await page.click('#btn-settings');
    await page.fill('#set-tfkey', '');
    await page.dispatchEvent('#set-tfkey', 'change');
    await page.keyboard.press('Escape');
    await ctx.unroute(/tile\.thunderforest\.com/);
  });

  await check('strong earthquake: map icon opens the report; normal quakes get no icon', async () => {
    const real = JSON.parse(fs.readFileSync(path.join(SITE, 'data', 'quakes.json'), 'utf-8'));
    const qs = real.quakes.map((q) => ({ ...q, maxInt: Math.min(q.maxInt || 0, 4), mag: Math.min(q.mag || 0, 5.9) }));
    const iso = new Date(Date.now() - 2 * 3600e3).toISOString();
    qs.unshift({ ...qs[0], time: iso, mag: 6.4, maxInt: 5.5, areas: [{ area: '花蓮縣地區', county: '花蓮縣', int: '5強', iv: 5.5 }, ...(qs[0].areas || [])] });
    await ctx.route(/data\/quakes\.json/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ quakes: qs }) }));
    await ctx.route(/scweb\.cwa\.gov\.tw/, (r) => r.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(PNG1, 'base64') }));
    await page.reload();
    await page.waitForSelector('body.ready');
    await page.waitForSelector('.eq-strong');
    await page.evaluate(async (q) => { const { S } = await import('./js/state.js'); S.map.setView([q.lat, q.lon], 9, { animate: false }); }, qs[0]);
    assert((await page.$$('.eq-strong')).length === 1, 'expected exactly one strong-quake icon');
    assert((await page.textContent('.eq-strong')).includes('M6.4'), 'icon label missing magnitude');
    assert((await page.textContent('#eq-banner')).includes('5強'), 'banner does not show intensity 5強');
    await page.click('.eq-strong .eq-core');
    await page.waitForFunction(() => (document.getElementById('sheet-title')?.textContent || '').includes('強震'));
    const body = await page.textContent('#sheet-body');
    assert(body.includes('強震注意') && body.includes('花蓮縣地區 5強'), 'strong-quake advice missing');
    assert(await page.$('img.eq-report'), 'report image missing');
    assert(!(await page.$('.eq-strong')), 'strong icon should give way to the epicentre in the quake view');
    await page.screenshot({ path: path.join(SHOTS, 'quake-strong.png') });
    await page.click('#sheet-close');
    await page.waitForSelector('.eq-strong');
    await page.screenshot({ path: path.join(SHOTS, 'quake-strong-icon.png') });
    await ctx.unroute(/data\/quakes\.json/);
    await ctx.unroute(/scweb\.cwa\.gov\.tw/);
    await page.reload();
    await page.waitForSelector('body.ready');
  });

  await check('offline: app shell, data and recent query snapshot from cache', async () => {
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();  // ensure SW controls the page and caches data
    await page.waitForSelector('body.ready');
    await page.waitForTimeout(1500);
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('body.ready', { timeout: 20000 });
    const st = await page.textContent('#status');
    assert(st.includes('離線'), `status ${st}`);
    await page.click('#btn-recent');
    await page.waitForSelector('[data-rid]');
    await page.click('[data-kind="recent"] >> nth=0');
    await page.waitForSelector('.offline-note', { timeout: 10000 });
    await page.screenshot({ path: path.join(SHOTS, 'offline-recent.png') });
    await ctx.setOffline(false);
  });

  await check('recent queries: delete one, clear all (confirmed), favourites kept', async () => {
    await page.reload();
    await page.waitForSelector('body.ready');
    // make one favourite from a fresh point query (the start-up view may frame a typhoon)
    await page.evaluate(async () => { const v = await import('./js/views.js'); await v.showPoint(23.62, 120.93); });
    await page.waitForSelector('#sheet.open #btn-fav');
    await page.click('#btn-fav');
    await page.waitForFunction(() => document.querySelector('#btn-fav').textContent.includes('已收藏'));
    await page.click('#sheet-close');
    await page.click('#btn-recent');
    await page.waitForSelector('[data-kind="recent"][data-del]');
    const n0 = await page.$$eval('[data-kind="recent"][data-del]', (b) => b.length);
    await page.click('[data-kind="recent"][data-del] >> nth=0');
    await page.waitForFunction((n) => document.querySelectorAll('[data-kind="recent"][data-del]').length === n - 1, n0);
    let asked = '';
    page.once('dialog', (d) => { asked = d.message(); d.accept(); });
    if (n0 > 1) {
      await page.click('#btn-clear-recent');
      await page.waitForFunction(() => !document.querySelector('[data-kind="recent"][data-del]'));
      assert(asked.includes('收藏地點會保留'), `confirm text: ${asked}`);
    }
    assert((await page.$$('[data-kind="fav"][data-del]')).length >= 1, 'favourite was removed by clearing recents');
    await page.click('#sheet-close');
  });

  await check('desktop layout screenshot', async () => {
    const p2 = await ctx.newPage();
    await p2.setViewportSize({ width: 1366, height: 860 });
    await p2.evaluate(() => {}).catch(() => {});
    await p2.goto(base);
    await p2.evaluate(() => { localStorage.clear(); });
    await p2.reload();
    await p2.waitForSelector('body.ready');
    await p2.waitForSelector('img.wx-grid');
    const box = await p2.locator('#map').boundingBox();
    await p2.mouse.click(box.x + box.width * 0.42, box.y + box.height * 0.45);
    await p2.waitForSelector('#sheet.open #h-risk', { timeout: 20000 });
    await p2.waitForTimeout(1000);
    await p2.screenshot({ path: path.join(SHOTS, 'desktop.png') });
    await p2.close();
  });

  await check('no uncaught page errors', async () => { assert(!errors.length, errors.join(' | ')); });

  await browser.close();
  srv.close();
  log(failures ? 'FAIL' : 'PASS', `e2e finished: ${failures} failure(s); screenshots in ${SHOTS}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { log('FAIL', e.stack || String(e)); process.exit(1); });
