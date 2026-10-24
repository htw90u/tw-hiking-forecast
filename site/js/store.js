// IndexedDB storage for recent queries and favourites (works offline).
const DB_NAME = 'hikingwx';
const DB_VERSION = 1;
const MAX_RECENT = 40;

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('recent')) d.createObjectStore('recent', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('fav')) d.createObjectStore('fav', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

function tx(store, mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    Promise.resolve(fn(s)).then((r) => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
  }));
}

function all(store) {
  return tx(store, 'readonly', (s) => new Promise((resolve) => {
    const req = s.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  }));
}

export const pointId = (lat, lon) => `${lat.toFixed(3)},${lon.toFixed(3)}`;

export async function saveRecent(entry) {
  try {
    await tx('recent', 'readwrite', (s) => { s.put({ ...entry, savedAt: new Date().toISOString() }); });
    const items = (await all('recent')).sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    if (items.length > MAX_RECENT) {
      await tx('recent', 'readwrite', (s) => items.slice(MAX_RECENT).forEach((x) => s.delete(x.id)));
    }
  } catch (e) {
    console.warn('saveRecent failed', e);
  }
}

export async function listRecent() {
  try { return (await all('recent')).sort((a, b) => b.savedAt.localeCompare(a.savedAt)); } catch { return []; }
}

export async function getRecent(id) {
  try {
    return await tx('recent', 'readonly', (s) => new Promise((resolve) => {
      const req = s.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    }));
  } catch { return null; }
}

export async function toggleFav(entry) {
  const favs = await listFav();
  const exists = favs.some((f) => f.id === entry.id);
  await tx('fav', 'readwrite', (s) => (exists ? s.delete(entry.id) : s.put({ ...entry, savedAt: new Date().toISOString() })));
  return !exists;
}

export async function listFav() {
  try { return (await all('fav')).sort((a, b) => b.savedAt.localeCompare(a.savedAt)); } catch { return []; }
}

export async function clearRecent() {
  await tx('recent', 'readwrite', (s) => s.clear());
}

export async function deleteRecent(id) {
  await tx('recent', 'readwrite', (s) => s.delete(id));
}

export async function deleteFav(id) {
  await tx('fav', 'readwrite', (s) => s.delete(id));
}

export async function clearAll() {
  await tx('recent', 'readwrite', (s) => s.clear());
  await tx('fav', 'readwrite', (s) => s.clear());
}
