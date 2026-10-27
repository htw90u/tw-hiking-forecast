#!/usr/bin/env node
// Mobile layout audit: overflow, touch target size, minimum font size and map
// visibility on common phone/tablet viewports. Usage: node tests/e2e/mobile_audit.cjs
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const SITE = path.join(ROOT, 'site');
const SHOTS = path.join(ROOT, 'logs', 'shots', 'mobile');
fs.mkdirSync(SHOTS, { recursive: true });
const TZ = process.env.LOG_TZ || 'Asia/Taipei';
const hms = () => new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date());
const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, dateStyle: 'short', timeStyle: 'medium' }).format(new Date()).replace(/[-: ]/g, '');
const logFile = path.join(ROOT, 'logs', `mobile-audit-${stamp}.log`);
fs.writeFileSync(logFile, `# Reproduce: cd ${ROOT} && node tests/e2e/mobile_audit.cjs\n`);
const color = process.stdout.isTTY || process.env.FORCE_COLOR;
let failures = 0;
function log(level, msg) {
  const line = `[${hms()}] ${level.padEnd(5)} ${msg}`;
  fs.appendFileSync(logFile, line + '\n');
  const c = { PASS: '\x1b[32m', FAIL: '\x1b[31m', WARN: '\x1b[33m' }[level];
  console.log(color && c ? line.replace(level, `${c}${level}\x1b[0m`) : line);
  if (level === 'FAIL') failures += 1;
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json' };
const VIEWPORTS = [
  { name: 'small-android-360', width: 360, height: 740 },
  { name: 'iphone-390', width: 390, height: 844 },
  { name: 'android-412', width: 412, height: 915 },
  { name: 'landscape-740', width: 740, height: 360 },
  { name: 'tablet-768', width: 768, height: 1024 },
];
const MIN_TARGET = 44; // px, WCAG 2.5.5 / platform guidelines
const MIN_FONT = 12;   // px

async function audit(page, where) {
  return page.evaluate(({ MIN_TARGET, MIN_FONT, where }) => {
    const vis = (e) => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const scope = document.querySelector(where) || document.body;
    const small = [];
    scope.querySelectorAll('button, a.btn, input, select, [role="radio"], [role="tab"], summary').forEach((e) => {
      if (!vis(e) || e.closest('.leaflet-control-attribution')) return;
      const r = e.getBoundingClientRect();
      const inline = e.classList.contains('link') || (e.type === 'checkbox' && e.closest('label'));
      const box = inline && e.closest('label') ? e.closest('label').getBoundingClientRect() : r;
      if (Math.min(box.width, box.height) < (inline ? 32 : MIN_TARGET)) small.push(`${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${[...e.classList].join('.')} "${(e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 12)}" ${Math.round(box.width)}x${Math.round(box.height)}`);
    });
    const tinyText = new Set();
    scope.querySelectorAll('*').forEach((e) => {
      if (!vis(e) || !e.childNodes.length || e.closest('svg, .leaflet-control-attribution')) return;
      const hasText = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (hasText && parseFloat(getComputedStyle(e).fontSize) < MIN_FONT) tinyText.add(`${e.tagName.toLowerCase()}.${[...e.classList].join('.')} ${getComputedStyle(e).fontSize}`);
    });
    const overflow = [];
    document.querySelectorAll('body *').forEach((e) => {
      if (!vis(e) || e.closest('.leaflet-pane, .scroll, .chips, #q-results, svg')) return;
      const r = e.getBoundingClientRect();
      if (r.right > window.innerWidth + 1 && getComputedStyle(e).position !== 'fixed') overflow.push(`${e.tagName.toLowerCase()}.${[...e.classList].join('.')} right=${Math.round(r.right)}`);
    });
    const map = document.getElementById('map').getBoundingClientRect();
    return { docW: document.documentElement.scrollWidth, vw: window.innerWidth, small: small.slice(0, 15), nSmall: small.length,
      tiny: [...tinyText].slice(0, 10), overflow: overflow.slice(0, 10), mapFrac: map.height / window.innerHeight };
  }, { MIN_TARGET, MIN_FONT, where });
}

(async () => {
  const srv = http.createServer((req, res) => {
    let p = path.join(SITE, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    fs.readFile(p, (e, b) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(b); });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: vp.width < 700, hasTouch: true, deviceScaleFactor: 2, locale: 'zh-TW' });
    await ctx.route(/opentopomap|nlsc\.gov\.tw|openstreetmap/, (r) => r.fulfill({ status: 204, body: '' }));
    const page = await ctx.newPage();
    await page.goto(base);
    await page.waitForSelector('body.ready');
    await page.waitForTimeout(800);
    let a = await audit(page, 'body');
    const tag = `${vp.name} ${vp.width}x${vp.height}`;
    log(a.docW <= a.vw ? 'PASS' : 'FAIL', `${tag} main: no horizontal scroll (doc ${a.docW}px / viewport ${a.vw}px)${a.overflow.length ? ' ' + a.overflow.join('; ') : ''}`);
    log(a.mapFrac >= (vp.height < 500 ? 0.35 : 0.5) ? 'PASS' : 'FAIL', `${tag} main: map uses ${(a.mapFrac * 100).toFixed(0)}% of screen height`);
    log(a.nSmall ? 'FAIL' : 'PASS', `${tag} main: touch targets >= ${MIN_TARGET}px${a.nSmall ? ` (${a.nSmall} too small: ${a.small.join(' | ')})` : ''}`);
    log(a.tiny.length ? 'FAIL' : 'PASS', `${tag} main: text >= ${MIN_FONT}px${a.tiny.length ? ` (${a.tiny.join(' | ')})` : ''}`);
    await page.screenshot({ path: path.join(SHOTS, `${vp.name}-main.png`) });
    // point panel: opened directly (a tap can land on a mountain marker, which opens that spot instead)
    await page.evaluate(async () => { const v = await import('./js/views.js'); await v.showPoint(23.62, 120.93); });
    await page.waitForSelector('#sheet.open #h-risk', { timeout: 20000 });
    await page.click('[data-cards="open"]');                              // audit the contents of every card
    await page.click('details.sub[data-sub="hist"] > summary');
    await page.waitForSelector('#hist-out figure, #hist-out p', { timeout: 20000 });
    a = await audit(page, '#sheet');
    log(a.docW <= a.vw ? 'PASS' : 'FAIL', `${tag} panel: no horizontal scroll${a.overflow.length ? ' ' + a.overflow.join('; ') : ''}`);
    log(a.nSmall ? 'FAIL' : 'PASS', `${tag} panel: touch targets${a.nSmall ? ` (${a.nSmall} too small: ${a.small.join(' | ')})` : ''}`);
    log(a.tiny.length ? 'FAIL' : 'PASS', `${tag} panel: text >= ${MIN_FONT}px${a.tiny.length ? ` (${a.tiny.join(' | ')})` : ''}`);
    await page.screenshot({ path: path.join(SHOTS, `${vp.name}-panel.png`) });
    await page.evaluate(() => { const b = document.getElementById('sheet-body'); b.scrollTop = b.scrollHeight * 0.45; });
    await page.screenshot({ path: path.join(SHOTS, `${vp.name}-panel-mid.png`) });
    await ctx.close();
  }
  await browser.close();
  srv.close();
  log(failures ? 'FAIL' : 'PASS', `mobile audit finished: ${failures} failure(s); screenshots in ${SHOTS}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { log('FAIL', e.stack || String(e)); process.exit(1); });
