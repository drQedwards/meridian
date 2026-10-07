import { haversineKm } from "./geo";

/**
 * First state grain of the United States network: Florida.
 * Places are metros and the links are the roads between them.
 * The clock is Eastern. `utc` is the offset from that clock
 * (Pensacola stays on Central).
 */
export const STATE = {
  id: "fl",
  name: "Florida",
  country: "United States",
  clock: "ET",
  /** Eastern Daylight, still in effect in early October. */
  utc: -4,
  grain: "15 min",
} as const;

export type City = {
  id: string;
  name: string;
  region: string;
  lat: number;
  lon: number;
  /** Hours added to the state clock to get local time. */
  utc: number;
  /** Relative draw. Used when a pair is not in the counted trips. */
  hub: number;
};

export type Corridor = {
  from: string;
  to: string;
  km: number;
  /** Free-flow travel time, hours. */
  airHours: number;
  /** Vehicles per 15 minutes, one direction. */
  capacity: number;
  road: string;
};

export const CITIES: City[] = [
  { id: "mia", name: "Miami", region: "Southeast", lat: 25.77, lon: -80.19, utc: 0, hub: 2.2 },
  { id: "fll", name: "Fort Lauderdale", region: "Southeast", lat: 26.12, lon: -80.14, utc: 0, hub: 1.4 },
  { id: "wpb", name: "West Palm Beach", region: "Southeast", lat: 26.71, lon: -80.05, utc: 0, hub: 0.8 },
  { id: "psl", name: "Port St. Lucie", region: "Treasure Coast", lat: 27.29, lon: -80.35, utc: 0, hub: 0.45 },
  { id: "mlb", name: "Melbourne", region: "Space Coast", lat: 28.08, lon: -80.62, utc: 0, hub: 0.35 },
  { id: "dab", name: "Daytona Beach", region: "Northeast", lat: 29.21, lon: -81.02, utc: 0, hub: 0.4 },
  { id: "jax", name: "Jacksonville", region: "Northeast", lat: 30.33, lon: -81.66, utc: 0, hub: 1.15 },
  { id: "orl", name: "Orlando", region: "Central", lat: 28.54, lon: -81.38, utc: 0, hub: 1.55 },
  { id: "lal", name: "Lakeland", region: "Central", lat: 28.04, lon: -81.95, utc: 0, hub: 0.35 },
  { id: "tpa", name: "Tampa", region: "Gulf", lat: 27.95, lon: -82.46, utc: 0, hub: 1.5 },
  { id: "pie", name: "St. Petersburg", region: "Gulf", lat: 27.77, lon: -82.64, utc: 0, hub: 0.7 },
  { id: "srg", name: "Sarasota", region: "Gulf", lat: 27.34, lon: -82.53, utc: 0, hub: 0.45 },
  { id: "fmy", name: "Fort Myers", region: "Southwest", lat: 26.64, lon: -81.87, utc: 0, hub: 0.55 },
  { id: "apf", name: "Naples", region: "Southwest", lat: 26.14, lon: -81.79, utc: 0, hub: 0.4 },
  { id: "ocf", name: "Ocala", region: "Central", lat: 29.19, lon: -82.14, utc: 0, hub: 0.3 },
  { id: "gnv", name: "Gainesville", region: "North Central", lat: 29.65, lon: -82.32, utc: 0, hub: 0.4 },
  { id: "crv", name: "Crystal River", region: "Nature Coast", lat: 28.9, lon: -82.59, utc: 0, hub: 0.18 },
  { id: "hsa", name: "Homosassa", region: "Nature Coast", lat: 28.78, lon: -82.62, utc: 0, hub: 0.16 },
  { id: "tlh", name: "Tallahassee", region: "Panhandle", lat: 30.44, lon: -84.28, utc: 0, hub: 0.45 },
  { id: "pns", name: "Pensacola", region: "Panhandle", lat: 30.42, lon: -87.22, utc: -1, hub: 0.4 },
  { id: "hom", name: "Homestead", region: "Keys", lat: 25.47, lon: -80.48, utc: 0, hub: 0.25 },
  { id: "eyw", name: "Key West", region: "Keys", lat: 24.56, lon: -81.78, utc: 0, hub: 0.22 },
];

type Road = [string, string, number, number, number, string];

/** [from, to, km, free-flow km/h, veh per 15 min, road name] */
const ROADS: Road[] = [
  ["mia", "fll", 42, 86, 540, "I-95"],
  ["fll", "wpb", 70, 98, 560, "I-95"],
  ["wpb", "psl", 76, 104, 720, "I-95"],
  ["psl", "mlb", 108, 108, 1100, "I-95"],
  ["mlb", "dab", 132, 108, 1160, "I-95"],
  ["dab", "jax", 142, 108, 1240, "I-95"],
  ["mia", "hom", 48, 78, 640, "US-1"],
  ["hom", "eyw", 206, 70, 110, "Overseas Hwy"],
  ["mia", "apf", 174, 112, 1600, "Alligator Alley"],
  ["apf", "fmy", 50, 92, 1200, "I-75"],
  ["fmy", "srg", 84, 100, 1280, "I-75"],
  ["srg", "tpa", 76, 100, 1320, "I-75"],
  ["tpa", "pie", 36, 70, 860, "I-275"],
  ["tpa", "lal", 56, 98, 640, "I-4"],
  ["lal", "orl", 60, 96, 600, "I-4"],
  ["orl", "dab", 88, 98, 740, "I-4"],
  ["psl", "orl", 168, 110, 1180, "Turnpike"],
  ["orl", "gnv", 162, 102, 900, "Turnpike"],
  ["tpa", "ocf", 132, 108, 1500, "I-75"],
  ["ocf", "gnv", 60, 108, 1420, "I-75"],
  ["gnv", "jax", 112, 105, 1300, "I-75"],
  ["jax", "tlh", 262, 112, 1180, "I-10"],
  ["tlh", "pns", 310, 112, 1080, "I-10"],
  ["tpa", "hsa", 102, 86, 520, "US-19"],
  ["hsa", "crv", 16, 72, 420, "US-19"],
  ["crv", "tlh", 246, 90, 380, "US-19"],
  ["gnv", "tlh", 226, 100, 640, "US-27"],
];

function cityById(id: string): City {
  const c = CITIES.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown city ${id}`);
  return c;
}

export const CORRIDORS: Corridor[] = ROADS.map(([a, b, km, kmh, capacity, road]) => ({
  from: a,
  to: b,
  km,
  airHours: km / kmh,
  capacity,
  road,
}));

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

export function linkKey(from: string, to: string): string {
  return `${from}>${to}`;
}

const directed = new Map<string, DirectedEdge>();
for (const id of adjacency.keys()) {
  for (const edge of adjacency.get(id)!) directed.set(linkKey(edge.fromId, edge.toId), edge);
}

export function directedLink(from: string, to: string): DirectedEdge | undefined {
  return directed.get(linkKey(from, to));
}

/** Straight-line km, used only for probe trips that are not in the counted set. */
export function crowKm(from: string, to: string): number {
  const a = cityAt(from);
  const b = cityAt(to);
  return haversineKm(a.lat, a.lon, b.lat, b.lon);
}
