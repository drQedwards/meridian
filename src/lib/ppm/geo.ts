/** Great-circle helpers and the local rush curve used as corridor traffic. */

/** State clock steps. 96 slices in a day. */
export const QUARTER_HOURS = 0.25;

export function wrap24(h: number): number {
  const x = h % 24;
  return x < 0 ? x + 24 : x;
}

/** Index 0..95 of the 15-minute slice containing this hour. */
export function quarterIndex(hour: number): number {
  const h = wrap24(hour);
  let q = Math.round(h / QUARTER_HOURS);
  if (q >= 96) q = 0;
  return q;
}

/** Hour snapped to :00, :15, :30, or :45. */
export function bucketHour(hour: number): number {
  return quarterIndex(hour) / 4;
}

export function formatClock(h: number): string {
  const x = wrap24(h);
  const hh = Math.floor(x);
  const mm = Math.floor((x - hh) * 60 + 1e-6);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/** Hours between two clock readings, wrapping at midnight. */
export function hourDistance(a: number, b: number): number {
  const d = Math.abs(wrap24(a) - wrap24(b));
  return Math.min(d, 24 - d);
}

/**
 * Urban + airport rush, 0–1. Morning peak near 08:00, evening near 17:45,
 * with a lower midday shoulder. Night is near zero.
 */
export function rushFactor(localHour: number): number {
  const g = (center: number, sigma: number) => {
    const d = hourDistance(localHour, center) / sigma;
    return Math.exp(-0.5 * d * d);
  };
  const raw = 0.72 * g(8, 1.2) + 1.15 * g(17.7, 1.4) + 0.38 * g(12.3, 2.1);
  return Math.min(1, raw);
}

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export type Vec3 = [number, number, number];

/** Unit sphere, Y-up. lon 0 / lat 0 faces +Z. */
export function latLonToVec(lat: number, lon: number, radius = 1): Vec3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  const x = -radius * Math.sin(phi) * Math.cos(theta);
  const y = radius * Math.cos(phi);
  const z = radius * Math.sin(phi) * Math.sin(theta);
  return [x, y, z];
}

/** Inverse of latLonToVec. */
export function vecToLatLon(x: number, y: number, z: number): { lat: number; lon: number } {
  const r = Math.hypot(x, y, z) || 1;
  const nx = x / r;
  const ny = y / r;
  const nz = z / r;
  const lat = 90 - (Math.acos(Math.max(-1, Math.min(1, ny))) * 180) / Math.PI;
  let lon = (Math.atan2(nz, -nx) * 180) / Math.PI - 180;
  if (lon < -180) lon += 360;
  if (lon > 180) lon -= 360;
  return { lat, lon };
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Raised great-circle samples, Y-up, for a corridor arc above the unit globe. */
export function arcPoints(a: Vec3, b: Vec3, segments = 40): Vec3[] {
  const al = Math.hypot(a[0], a[1], a[2]) || 1;
  const bl = Math.hypot(b[0], b[1], b[2]) || 1;
  const au: Vec3 = [a[0] / al, a[1] / al, a[2] / al];
  const bu: Vec3 = [b[0] / bl, b[1] / bl, b[2] / bl];
  const cos = Math.max(-1, Math.min(1, dot(au, bu)));
  const omega = Math.acos(cos);
  const pts: Vec3[] = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    let p: Vec3;
    if (omega < 1e-4) {
      p = au;
    } else {
      const s = Math.sin(omega);
      const p0 = Math.sin((1 - t) * omega) / s;
      const p1 = Math.sin(t * omega) / s;
      p = [p0 * au[0] + p1 * bu[0], p0 * au[1] + p1 * bu[1], p0 * au[2] + p1 * bu[2]];
    }
    const lift = Math.sin(Math.PI * t) * Math.min(0.012, 0.0004 + omega * 0.04);
    const r = 1.012 + lift;
    pts.push([p[0] * r, p[1] * r, p[2] * r]);
  }
  return pts;
}
