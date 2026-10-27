// Sunrise, sunset and civil twilight for a place and date (NOAA solar position equations; accurate to about a minute).

const RAD = Math.PI / 180;

/** Minutes after 00:00 UTC of the given UTC date when the sun is `alt` degrees below/above the horizon (rising or setting). */
function eventUTC(y, m, d, lat, lon, alt, rising) {
  const jd0 = Date.UTC(y, m - 1, d) / 86400000 + 2440587.5;
  let t = rising ? 360 : 1080; // first guess (minutes UTC), refined twice
  for (let k = 0; k < 3; k++) {
    const T = (jd0 + t / 1440 - 2451545) / 36525;
    const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
    const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
    const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
    const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T)) + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T)
      + Math.sin(3 * M * RAD) * 0.000289;
    const trueLon = L0 + C;
    const omega = 125.04 - 1934.136 * T;
    const lam = trueLon - 0.00569 - 0.00478 * Math.sin(omega * RAD);
    const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos(omega * RAD);
    const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lam * RAD));
    const y2 = Math.tan(eps * RAD / 2) ** 2;
    const eqTime = 4 / RAD * (y2 * Math.sin(2 * L0 * RAD) - 2 * e * Math.sin(M * RAD) + 4 * e * y2 * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
      - 0.5 * y2 * y2 * Math.sin(4 * L0 * RAD) - 1.25 * e * e * Math.sin(2 * M * RAD));
    const cosH = (Math.sin(alt * RAD) - Math.sin(lat * RAD) * Math.sin(decl)) / (Math.cos(lat * RAD) * Math.cos(decl));
    if (cosH > 1 || cosH < -1) return null; // polar day / night (not in Taiwan)
    const H = Math.acos(cosH) / RAD;
    t = 720 - 4 * (lon + (rising ? H : -H)) - eqTime;
  }
  return t;
}

const pad = (n) => String(n).padStart(2, '0');

/** "HH:MM" in Taiwan time (UTC+8) for minutes after 00:00 UTC of the given date. */
function hhmm(min) {
  const m = Math.round(min + 480);
  const mm = ((m % 1440) + 1440) % 1440;
  return `${pad(Math.floor(mm / 60))}:${pad(mm % 60)}`;
}

/**
 * Sun times of a Taiwan calendar date (y, m, d). Returns { dawn, rise, set, dusk, dayMin } as "HH:MM" strings (Taiwan time):
 * dawn / dusk = civil twilight (sun 6° below the horizon, enough light to walk without a headlamp).
 * ele (m): observer height. With an unobstructed horizon at that height the horizon dips by about 0.0293° x sqrt(ele), so the sun
 * rises earlier and sets later (sunrise / sunset only; terrain that blocks the horizon is not modelled).
 */
export function sunTimes(lat, lon, y, m, d, ele = 0) {
  const dip = ele > 0 ? 0.0293 * Math.sqrt(ele) : 0;
  // Taiwan day d spans UTC d-1 16:00 .. d 16:00; compute for UTC date d (events fall inside the local day).
  const at = (alt, rising) => eventUTC(y, m, d, lat, lon, alt, rising);
  const rise = at(-0.833 - dip, true); const set = at(-0.833 - dip, false);
  const dawn = at(-6, true); const dusk = at(-6, false);
  if ([rise, set, dawn, dusk].some((v) => v === null)) return null;
  return { dawn: hhmm(dawn), rise: hhmm(rise), set: hhmm(set), dusk: hhmm(dusk), dayMin: Math.round(set - rise) };
}

/** Taiwan calendar date parts of a timestamp. */
export function twDate(ts = Date.now()) {
  const d = new Date(ts + 8 * 3600e3);
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

/** "12 小時 3 分" */
export function dayLength(min) {
  return `${Math.floor(min / 60)} 小時 ${min % 60} 分`;
}
