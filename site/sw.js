// Service worker: offline app shell, last-known data, and visited map tiles.
const VERSION = 'v81';
const SHELL = `shell-${VERSION}`;
const DATA = 'data';
const TILES = 'tiles';
const MAX_TILES = 6000;
const SHELL_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css', 'css/icons.css',
  'js/app.js', 'js/state.js', 'js/settings.js', 'js/palettes.js', 'js/grid.js', 'js/util.js', 'js/store.js',
  'js/chart.js', 'js/sun.js', 'js/aloft.js', 'js/ensemble.js', 'js/cards.js', 'js/hydro.js', 'js/safety.js', 'js/layers.js', 'js/views.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'vendor/topojson/topojson-client.min.js',
  'geo/towns-10t.json', 'icons/icon-192.png', 'icons/icon-512.png',
];
const TILE_HOSTS = ['tile.opentopomap.org', 'wmts.nlsc.gov.tw', 'tile.openstreetmap.org', 'gis.sinica.edu.tw'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((k) => k.startsWith('shell-') && k !== SHELL).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

function stripSearch(req) {
  const u = new URL(req.url);
  u.search = '';
  return u.toString();
}

async function networkFirst(req) {
  const cache = await caches.open(DATA);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(req, { signal: ctrl.signal });
    clearTimeout(t);
    if (res.ok) cache.put(stripSearch(req), res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(stripSearch(req));
    if (hit) return hit;
    throw err;
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req, { ignoreSearch: true });
  const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => null);
  return hit || (await net) || new Response('offline', { status: 503 });
}

let tileWrites = 0;
async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES).map((k) => cache.delete(k)));
}

async function cacheFirstTile(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  try {
    const res = await fetch(req);
    if (res.ok || res.type === 'opaque') {
      cache.put(req.url, res.clone());
      tileWrites += 1;
      if (tileWrites % 200 === 0) trimTiles();
    }
    return res;
  } catch (err) {
    return new Response('', { status: 504 });
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const tileLike = /\/\d+\/\d+\/\d+(\.png|\.jpg|\.webp)?$/.test(url.pathname) && url.origin !== location.origin && url.hostname !== 'gibs.earthdata.nasa.gov'; // NASA daily imagery changes under the same URL
  if (TILE_HOSTS.some((h) => url.hostname.endsWith(h)) || tileLike) {
    e.respondWith(cacheFirstTile(req));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.includes('/data/')) { e.respondWith(networkFirst(req)); return; }
  e.respondWith(staleWhileRevalidate(req));
});
