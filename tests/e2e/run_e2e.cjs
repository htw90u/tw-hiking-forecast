#!/usr/bin/env node
// End-to-end test of the web app with Playwright (Chromium).
// Usage: node tests/e2e/run_e2e.cjs [--site site] [--shots logs/shots]
// Requires site/data built by `python -m pipeline.build`.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

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
      await page.click(`.chip[data-layer="${id}"]`);
      await page.waitForTimeout(id === 'none' ? 200 : 1200);
      const checked = await page.getAttribute(`.chip[data-layer="${id}"]`, 'aria-checked');
      assert(checked === 'true', `chip ${id} not checked`);
    }
    assert(!errors.length, errors.join(' | '));
  });

  await check('accumulated rainfall: selectable periods up to 7 days', async () => {
    await page.click('.chip[data-layer="rainacc"]');
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
    await page.click('.chip[data-layer="qpf"]');
    await page.waitForSelector('[data-period]');
    const n = await page.$$eval('[data-period]', (b) => b.length);
    assert(n === 4, `periods ${n}`);
    await page.click('[data-period="1"]');
    await page.waitForTimeout(800);
    assert(await page.$('img.qpf-title'), 'QPF title image missing');
    await page.screenshot({ path: path.join(SHOTS, 'qpf-mobile.png') });
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
    await page.click('.chip[data-layer="radar"]');
    await page.evaluate(() => window.scrollTo(0, 0));
    const box = await page.locator('#map').boundingBox();
    await page.mouse.click(box.x + box.width * 0.55, box.y + box.height * 0.4);
    await page.waitForSelector('#sheet.open #h-risk', { timeout: 20000 });
    await page.waitForSelector('#hist-out figure.chart, #hist-out p', { timeout: 20000 });
    const title = await page.textContent('#sheet-title');
    assert(title && title !== '查詢中…', `title ${title}`);
    assert(!(await page.textContent('#sheet-body')).includes('鄉鎮不明'), 'unknown-township text should not be shown');
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
    await page.click('.chip[data-layer="qpf"]');
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
    await page.click('.chip[data-layer="qpe1h"]');
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
