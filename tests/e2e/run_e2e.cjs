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
async function check(name, fn) {
  try { await fn(); log('PASS', name); } catch (e) { failures += 1; log('FAIL', `${name}: ${e.message.split('\n')[0]}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
// Layer chips toggle: tapping the active one turns the layer off, so only tap when not selected.
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
    assert(t.includes('雷達'), `legend title ${t}`);
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
    await page.waitForFunction(() => document.querySelector('#legend summary')?.textContent.includes('7天'));
    const top = await page.$eval('#legend .swatches li:first-child', (e) => e.textContent);
    assert(top.includes('1000'), `legend top class ${top}`);
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
      await page.waitForFunction(() => document.querySelector('#legend summary')?.textContent.includes('6小時'));
      const lbl = await page.$$eval('[data-period]', (b) => b.map((x) => x.textContent));
      assert(lbl.every((t) => t.includes('–')), `6h period labels lack an interval: ${lbl.slice(0, 2)}`);
      await page.screenshot({ path: path.join(SHOTS, 'qpf6-mobile.png') });
    } else {
      assert(await page.getAttribute('[data-qpfmode="6"]', 'aria-disabled') === 'true', '6h should be disabled when unavailable');
    }
    await page.click('[data-qpfmode="acc"]');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-period]')].map((b) => b.textContent).join() === '未來24小時,未來48小時');
    await page.click('[data-period="1"]');
    await page.waitForFunction(() => document.querySelector('#legend summary')?.textContent.includes('48'));
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
    const body = await page.textContent('#sheet-body');
    assert(body.includes('雲頂溫度'), 'point panel lacks cloud-top temperature');
    assert(body.includes('未來累積降水') && body.includes('非中央氣象署發布之預報'), 'point panel lacks derived totals with disclaimer');
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
    await page.waitForSelector('#sheet-body .card.station');
    const order = await page.$$eval('#sheet-body > section, #sheet-body > .card', (els) => els.map((e) => e.querySelector('h3')?.id || ''));
    assert(order[0] === 'h-stn' && order[1] === 'h-mtn', `card order ${order.slice(0, 4)}`);
    assert(order.indexOf('h-risk') > order.indexOf('h-mtn'), 'safety card should follow the station cards');
    assert((await page.$$('#sheet-body .card.station .tile')).length >= 3, 'station value tiles missing');
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
    await page.waitForFunction(() => document.querySelector('.chip[data-layer="none"]')?.getAttribute('aria-checked') === 'true');
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

  await check('UI style: text <-> icon switch (tab bar, icon tiles) persists', async () => {
    await page.click('#btn-settings');
    await page.waitForSelector('#set-ui');
    await page.selectOption('#set-ui', 'icon');
    await page.keyboard.press('Escape');
    assert((await page.getAttribute('html', 'data-ui')) === 'icon', 'data-ui not icon');
    assert(await page.$('#tabbar .actions-top #btn-settings'), 'actions not moved to the tab bar');
    assert(await page.isVisible('#tabbar'), 'tab bar hidden');
    const ic = await page.$eval('.chip[data-layer="radar"]', (el) => getComputedStyle(el, '::before').maskImage || getComputedStyle(el, '::before').webkitMaskImage);
    assert(ic && ic.includes('svg'), `chip icon missing: ${ic}`);
    await page.screenshot({ path: path.join(SHOTS, 'ui-icon-mobile.png') });
    await page.reload();
    await page.waitForSelector('body.ready');
    assert((await page.getAttribute('html', 'data-ui')) === 'icon', 'icon UI not persisted');
    await page.click('#btn-settings');
    await page.selectOption('#set-ui', 'text');
    await page.keyboard.press('Escape');
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
    // make one favourite from a fresh point query
    const box = await page.locator('#map').boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.35);
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
