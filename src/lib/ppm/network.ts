import { haversineKm } from "./geo";

export type City = {
  id: string;
  name: string;
  region: string;
  lat: number;
  lon: number;
  /** Standard time offset from UTC, hours. */
  utc: number;
  /** How hard local traffic hits this gateway. 1 = major hub. */
  hub: number;
};

export type Corridor = {
  from: string;
  to: string;
  km: number;
  /** Cruise time with no traffic, hours. */
  airHours: number;
  /**
   * How strongly time-of-day traffic inflates this corridor.
   * Short hauls feel airport queues; ultra-long tracks feel flow programs.
   */
  sensitivity: number;
};

export const CITIES: City[] = [
  { id: "rek", name: "Reykjavík", region: "Atlantic", lat: 64.15, lon: -21.94, utc: 0, hub: 0.55 },
  { id: "lon", name: "London", region: "Europe", lat: 51.51, lon: -0.12, utc: 0, hub: 1.15 },
  { id: "par", name: "Paris", region: "Europe", lat: 48.86, lon: 2.35, utc: 1, hub: 1.05 },
  { id: "cai", name: "Cairo", region: "Africa", lat: 30.04, lon: 31.24, utc: 2, hub: 0.82 },
  { id: "cpt", name: "Cape Town", region: "Africa", lat: -33.92, lon: 18.42, utc: 2, hub: 0.62 },
  { id: "dxb", name: "Dubai", region: "Gulf", lat: 25.2, lon: 55.27, utc: 4, hub: 1.12 },
  { id: "bom", name: "Mumbai", region: "South Asia", lat: 19.08, lon: 72.88, utc: 5.5, hub: 0.98 },
  { id: "sin", name: "Singapore", region: "Southeast Asia", lat: 1.35, lon: 103.82, utc: 8, hub: 1.08 },
  { id: "hkg", name: "Hong Kong", region: "East Asia", lat: 22.32, lon: 114.17, utc: 8, hub: 1.1 },
  { id: "tyo", name: "Tokyo", region: "East Asia", lat: 35.68, lon: 139.69, utc: 9, hub: 1.18 },
  { id: "syd", name: "Sydney", region: "Oceania", lat: -33.87, lon: 151.21, utc: 10, hub: 0.9 },
  { id: "lax", name: "Los Angeles", region: "Pacific", lat: 34.05, lon: -118.24, utc: -8, hub: 1.12 },
  { id: "sfo", name: "San Francisco", region: "Pacific", lat: 37.77, lon: -122.42, utc: -8, hub: 0.96 },
  { id: "nyc", name: "New York", region: "Atlantic", lat: 40.71, lon: -74.0, utc: -5, hub: 1.2 },
  { id: "gru", name: "São Paulo", region: "South America", lat: -23.55, lon: -46.63, utc: -3, hub: 0.92 },
  { id: "mex", name: "Mexico City", region: "Americas", lat: 19.43, lon: -99.13, utc: -6, hub: 0.88 },
];

const PAIRS: Array<[string, string]> = [
  ["rek", "lon"],
  ["rek", "nyc"],
  ["rek", "par"],
  ["lon", "par"],
  ["lon", "nyc"],
  ["lon", "dxb"],
  ["lon", "cai"],
  ["lon", "cpt"],
  ["lon", "sin"],
  ["par", "nyc"],
  ["par", "cai"],
  ["par", "dxb"],
  ["par", "gru"],
  ["par", "bom"],
  ["nyc", "lax"],
  ["nyc", "sfo"],
  ["nyc", "mex"],
  ["nyc", "gru"],
  ["nyc", "tyo"],
  ["lax", "sfo"],
  ["lax", "tyo"],
  ["lax", "syd"],
  ["lax", "mex"],
  ["lax", "hkg"],
  ["sfo", "tyo"],
  ["sfo", "hkg"],
  ["sfo", "syd"],
  ["sfo", "sin"],
  ["mex", "gru"],
  ["gru", "cpt"],
  ["cpt", "dxb"],
  ["cpt", "cai"],
  ["cai", "dxb"],
  ["dxb", "bom"],
  ["dxb", "sin"],
  ["dxb", "hkg"],
  ["bom", "sin"],
  ["bom", "hkg"],
  ["sin", "hkg"],
  ["sin", "tyo"],
  ["sin", "syd"],
  ["hkg", "tyo"],
  ["hkg", "syd"],
  ["tyo", "syd"],
];

const CRUISE_KMH = 840;

function sensitivityFor(km: number): number {
  if (km < 3500) return 1.05;
  if (km < 7500) return 0.62;
  return 0.9;
}

function cityById(id: string): City {
  const c = CITIES.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown city ${id}`);
  return c;
}

export const CORRIDORS: Corridor[] = PAIRS.map(([a, b]) => {
  const ca = cityById(a);
  const cb = cityById(b);
  const km = haversineKm(ca.lat, ca.lon, cb.lat, cb.lon);
  return {
    from: a,
    to: b,
    km,
    airHours: km / CRUISE_KMH,
    sensitivity: sensitivityFor(km),
  };
});

const cityIndex = new Map(CITIES.map((c, i) => [c.id, i]));

export function cityAt(id: string): City {
  return cityById(id);
}

export function cityIndexOf(id: string): number {
  const i = cityIndex.get(id);
  if (i === undefined) throw new Error(`Unknown city ${id}`);
  return i;
}

export type DirectedEdge = Corridor & { toId: string; fromId: string };

const adjacency = new Map<string, DirectedEdge[]>();
for (const c of CITIES) adjacency.set(c.id, []);
for (const edge of CORRIDORS) {
  adjacency.get(edge.from)!.push({ ...edge, fromId: edge.from, toId: edge.to });
  adjacency.get(edge.to)!.push({
    ...edge,
    from: edge.to,
    to: edge.from,
    fromId: edge.to,
    toId: edge.from,
  });
}

export function neighbors(id: string): DirectedEdge[] {
  return adjacency.get(id) ?? [];
}
