/* global TextDecoder, Blob, DOMParser */
// Earthquake reports straight from the CWA open-data bucket (CORS enabled), so a new report shows up within about a minute
// instead of at the next site build. Same files and fields as pipeline/hazards.py (E-A0015 significant, E-A0016 local).
const BASE = 'https://cwaopendata.s3.ap-northeast-1.amazonaws.com/Earthquake';
const FILES = [['E-A0015-001.zip', 'significant'], ['E-A0016-001.zip', 'local']];

/** Entries of a ZIP file: [{ name, data: Uint8Array }] (stored or deflated). */
export async function unzip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  let eocd = -1;
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i -= 1) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let k = 0; k < n; k += 1) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad zip directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = u8.subarray(start, start + csize);
    let data = raw;
    if (method === 8) data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
    else if (method !== 0) throw new Error(`zip method ${method}`);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const first = (el, tag) => el?.getElementsByTagName(tag)[0] || null;
const text = (el, tag) => { const t = first(el, tag)?.textContent?.trim(); return t || null; };
const num = (s) => { const v = parseFloat(s); return Number.isFinite(v) ? v : null; };

/** '5弱' -> 5, '5強' -> 5.5, '3級' -> 3 */
function intensityValue(s) {
  const m = /^(\d)/.exec(s || '');
  if (!m) return null;
  return Number(m[1]) + (String(s).includes('強') ? 0.5 : 0);
}

/** One earthquake report (XML text) as the object the pipeline writes to quakes.json; null when it has no epicentre. */
export function parseQuake(xml, kind) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const eq = first(doc, 'Earthquake');
  if (!eq || first(doc, 'parsererror')) return null;
  const info = first(eq, 'EarthquakeInfo');
  const epi = first(info, 'Epicenter');
  const lat = num(text(epi, 'EpicenterLatitude'));
  const lon = num(text(epi, 'EpicenterLongitude'));
  if (lat === null || lon === null) return null;
  const areas = [];
  const stations = new Map();
  [...(first(eq, 'Intensity')?.getElementsByTagName('ShakingArea') || [])].forEach((a) => {
    const iv = text(a, 'AreaIntensity');
    areas.push({ area: text(a, 'AreaDesc'), county: text(a, 'CountyName'), int: iv, iv: intensityValue(iv) });
    [...a.getElementsByTagName('EqStation')].forEach((st) => {
      const slat = num(text(st, 'StationLatitude'));
      const slon = num(text(st, 'StationLongitude'));
      if (slat === null || slon === null) return;
      const si = text(st, 'SeismicIntensity');
      const s = { n: text(st, 'StationName'), lat: slat, lon: slon, int: si, iv: intensityValue(si), d: num(text(st, 'EpicenterDistance')) };
      const key = `${s.n}|${slat}|${slon}`;
      if (!stations.has(key) || (s.iv || 0) > (stations.get(key).iv || 0)) stations.set(key, s);
    });
  });
  return {
    no: text(eq, 'EarthquakeNo'), time: text(info, 'OriginTime'), lat, lon, loc: text(epi, 'Location'), depth: num(text(info, 'FocalDepth')),
    mag: num(text(first(info, 'EarthquakeMagnitude'), 'MagnitudeValue')), text: text(eq, 'ReportContent'), color: text(eq, 'ReportColor'),
    web: text(eq, 'Web'), img: text(eq, 'ReportImageURI'), shakemap: text(eq, 'ShakemapImageURI'),
    maxInt: Math.max(0, ...areas.map((a) => a.iv || 0)), areas,
    stations: [...stations.values()].sort((a, b) => (b.iv || 0) - (a.iv || 0)).slice(0, 60), kind,
  };
}

/** Reports of both files (a file that fails is skipped); [] when nothing could be read. */
export async function fetchLiveQuakes(fetchFn = fetch) {
  const lists = await Promise.allSettled(FILES.map(async ([file, kind]) => {
    const res = await fetchFn(`${BASE}/${file}`, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    const entries = await unzip(await res.arrayBuffer());
    return entries.filter((e) => e.name.toLowerCase().endsWith('.xml')).map((e) => parseQuake(new TextDecoder().decode(e.data), kind)).filter(Boolean);
  }));
  return lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

/** Live reports on top of the ones of the last build: same earthquake (time and place) keeps the build's copy (it may carry a shake map). */
export function mergeQuakes(known, live, limit = 60) {
  const by = new Map(live.map((q) => [`${q.time}|${q.lat}|${q.lon}`, q]));
  known.forEach((q) => by.set(`${q.time}|${q.lat}|${q.lon}`, q));
  return [...by.values()].sort((a, b) => String(b.time).localeCompare(String(a.time))).slice(0, limit);
}
