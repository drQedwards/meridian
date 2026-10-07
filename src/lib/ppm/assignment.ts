/**
 * Quarter-hour traffic assignment for Florida.
 *
 * Path flows Q_ij^r are vehicles on path r between i and j.
 * They conserve the trips: sum_r Q_ij^r = Q_ij, and every Q is ≥ 0.
 * A link's vehicles are the paths that use it:
 *   Q_a = sum_i sum_j sum_r α_ij^{ar} Q_ij^r
 *
 * Selfish drivers take the cheapest remaining path (user equilibrium).
 * A coordinator minimizes total vehicle-hours (system optimum, Beckmann
 * with marginal cost). The ratio of those two totals is the price of
 * anarchy — the cost of everyone routing for themselves.
 *
 * Link time is the BPR curve, t0 * (1 + 0.15 * (Q/c)^4).
 */

import { bucketHour, hourDistance } from "./geo";
import {
  CITIES,
  cityAt,
  directedLink,
  linkKey,
  neighbors,
  type DirectedEdge,
} from "./network";

const BPR_ALPHA = 0.15;
const BPR_BETA = 4;
const FW_ITERS = 18;
const MIN_TRIPS = 6;

export type DemandKind = "am" | "pm" | "mid" | "flat" | "both";

type Demand = {
  from: string;
  to: string;
  peak: number;
  kind: DemandKind;
};

/**
 * Counted Florida trips, vehicles per 15 minutes at the peak of the pattern.
 * Commute is directional. Midday is visitors. Flat is freight and through trips.
 */
const DEMANDS: Demand[] = [
  { from: "fll", to: "mia", peak: 260, kind: "am" },
  { from: "mia", to: "fll", peak: 260, kind: "pm" },
  { from: "wpb", to: "fll", peak: 170, kind: "am" },
  { from: "fll", to: "wpb", peak: 170, kind: "pm" },
  { from: "wpb", to: "mia", peak: 140, kind: "am" },
  { from: "mia", to: "wpb", peak: 140, kind: "pm" },
  { from: "pie", to: "tpa", peak: 220, kind: "am" },
  { from: "tpa", to: "pie", peak: 220, kind: "pm" },
  { from: "lal", to: "orl", peak: 180, kind: "am" },
  { from: "orl", to: "lal", peak: 180, kind: "pm" },
  { from: "tpa", to: "orl", peak: 200, kind: "am" },
  { from: "orl", to: "tpa", peak: 200, kind: "pm" },
  { from: "dab", to: "orl", peak: 90, kind: "am" },
  { from: "orl", to: "dab", peak: 90, kind: "pm" },
  { from: "mia", to: "jax", peak: 780, kind: "both" },
  { from: "jax", to: "mia", peak: 720, kind: "both" },
  { from: "mia", to: "orl", peak: 640, kind: "both" },
  { from: "orl", to: "mia", peak: 600, kind: "both" },
  { from: "mia", to: "tpa", peak: 560, kind: "both" },
  { from: "tpa", to: "mia", peak: 520, kind: "both" },
  { from: "tpa", to: "jax", peak: 380, kind: "both" },
  { from: "jax", to: "tpa", peak: 340, kind: "both" },
  { from: "orl", to: "jax", peak: 320, kind: "both" },
  { from: "jax", to: "orl", peak: 300, kind: "both" },
  { from: "jax", to: "tlh", peak: 90, kind: "flat" },
  { from: "tlh", to: "jax", peak: 80, kind: "flat" },
  { from: "tlh", to: "pns", peak: 70, kind: "flat" },
  { from: "pns", to: "tlh", peak: 60, kind: "flat" },
  { from: "mia", to: "eyw", peak: 100, kind: "mid" },
  { from: "eyw", to: "mia", peak: 90, kind: "mid" },
  { from: "tpa", to: "hsa", peak: 55, kind: "mid" },
  { from: "hsa", to: "tpa", peak: 50, kind: "mid" },
  { from: "hsa", to: "crv", peak: 40, kind: "am" },
  { from: "crv", to: "hsa", peak: 40, kind: "pm" },
  { from: "tpa", to: "crv", peak: 70, kind: "mid" },
  { from: "crv", to: "tpa", peak: 60, kind: "mid" },
];

function gauss(hour: number, center: number, sigma: number): number {
  const d = hourDistance(hour, center) / sigma;
  return Math.exp(-0.5 * d * d);
}

export function demandShape(kind: DemandKind, hour: number): number {
  if (kind === "am") return 0.92 * gauss(hour, 7.75, 0.85) + 0.12 * gauss(hour, 17.4, 1.1);
  if (kind === "pm") return 0.95 * gauss(hour, 17.25, 0.9) + 0.1 * gauss(hour, 8.0, 1.0);
  if (kind === "mid") return 0.22 + 0.78 * gauss(hour, 13.1, 2.3);
  if (kind === "both") return 0.12 + 0.72 * gauss(hour, 8.0, 1.25) + 0.9 * gauss(hour, 17.25, 1.15);
  return 0.58 + 0.22 * gauss(hour, 11.5, 3.2) + 0.12 * gauss(hour, 15.5, 2.4);
}

type Trip = { from: string; to: string; vehicles: number };

function countedTrips(hour: number): Trip[] {
  const out: Trip[] = [];
  for (const spec of DEMANDS) {
    const vehicles = spec.peak * demandShape(spec.kind, hour);
    if (vehicles >= MIN_TRIPS) out.push({ from: spec.from, to: spec.to, vehicles });
  }
  return out;
}

export function probeVehicles(from: string, to: string, hour: number): number {
  if (from === to) return 0;
  const a = cityAt(from);
  const b = cityAt(to);
  const km = Math.hypot((a.lat - b.lat) * 111, (a.lon - b.lon) * 100);
  const mid = 0.4 + 0.6 * gauss(hour, 13, 3.1);
  return 28 * a.hub * b.hub * Math.exp(-km / 340) * mid;
}

function bpr(freeHours: number, flow: number, capacity: number): number {
  const x = flow / Math.max(capacity, 1);
  return freeHours * (1 + BPR_ALPHA * x ** BPR_BETA);
}

function marginal(freeHours: number, flow: number, capacity: number): number {
  const x = flow / Math.max(capacity, 1);
  return freeHours * (1 + BPR_ALPHA * (BPR_BETA + 1) * x ** BPR_BETA);
}

function cheapest(from: string, to: string, cost: (edge: DirectedEdge, flow: number) => number, flow: Map<string, number>): string[] | null {
  if (from === to) return [from];
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  for (const c of CITIES) {
    dist.set(c.id, Infinity);
    prev.set(c.id, null);
  }
  dist.set(from, 0);
  const queue: string[] = [from];
  const settled = new Set<string>();
  while (queue.length) {
    let bestI = 0;
    for (let i = 1; i < queue.length; i++) {
      if ((dist.get(queue[i]) ?? Infinity) < (dist.get(queue[bestI]) ?? Infinity)) bestI = i;
    }
    const id = queue.splice(bestI, 1)[0];
    if (settled.has(id)) continue;
    settled.add(id);
    if (id === to) break;
    const soFar = dist.get(id) ?? Infinity;
    for (const edge of neighbors(id)) {
      if (settled.has(edge.toId)) continue;
      const q = flow.get(linkKey(edge.fromId, edge.toId)) ?? 0;
      const nd = soFar + cost(edge, q);
      if (nd < (dist.get(edge.toId) ?? Infinity)) {
        dist.set(edge.toId, nd);
        prev.set(edge.toId, id);
        queue.push(edge.toId);
      }
    }
  }
  if ((dist.get(to) ?? Infinity) === Infinity) return null;
  const path = [to];
  let cur = to;
  while (cur !== from) {
    const p = prev.get(cur);
    if (!p) return null;
    path.push(p);
    cur = p;
  }
  path.reverse();
  return path;
}

function addAlong(flow: Map<string, number>, path: string[], vehicles: number): void {
  for (let i = 0; i < path.length - 1; i++) {
    const k = linkKey(path[i], path[i + 1]);
    flow.set(k, (flow.get(k) ?? 0) + vehicles);
  }
}

type PathBook = Map<string, Map<string, number>>;

function odKey(from: string, to: string): string {
  return linkKey(from, to);
}

function mixNum(base: Map<string, number>, add: Map<string, number>, a: number): Map<string, number> {
  const out = new Map<string, number>();
  const keys = new Set([...base.keys(), ...add.keys()]);
  for (const k of keys) {
    const v = (1 - a) * (base.get(k) ?? 0) + a * (add.get(k) ?? 0);
    if (v >= 0.05) out.set(k, v);
  }
  return out;
}

function mixPaths(base: PathBook, add: PathBook, a: number): PathBook {
  const out: PathBook = new Map();
  const ods = new Set([...base.keys(), ...add.keys()]);
  for (const od of ods) {
    const dst = new Map<string, number>();
    const left = base.get(od) ?? new Map<string, number>();
    const right = add.get(od) ?? new Map<string, number>();
    const paths = new Set([...left.keys(), ...right.keys()]);
    for (const p of paths) {
      const v = (1 - a) * (left.get(p) ?? 0) + a * (right.get(p) ?? 0);
      if (v >= 0.05) dst.set(p, v);
    }
    if (dst.size) out.set(od, dst);
  }
  return out;
}

type Loaded = { flow: Map<string, number>; paths: PathBook };

function loadOf(flow: Map<string, number>, from: string, to: string): DirectedLoad {
  const edge = directedLink(from, to);
  if (!edge) return { hours: 1, vc: 0, vehicles: 0, capacity: 1, road: "", km: 0 };
  const vehicles = flow.get(linkKey(from, to)) ?? 0;
  const vc = vehicles / edge.capacity;
  return {
    hours: bpr(edge.airHours, vehicles, edge.capacity),
    vc,
    vehicles,
    capacity: edge.capacity,
    road: edge.road,
    km: edge.km,
  };
}

function beckmann(flow: Map<string, number>): number {
  let total = 0;
  for (const [key, q] of flow) {
    const [from, to] = key.split(">");
    const edge = directedLink(from, to);
    if (!edge || q <= 0) continue;
    const x = q / edge.capacity;
    total += edge.airHours * (q + (BPR_ALPHA / (BPR_BETA + 1)) * q * x ** BPR_BETA);
  }
  return total;
}

function allOrNothing(trips: Trip[], flow: Map<string, number>, mode: "user" | "system"): Loaded {
  const y = new Map<string, number>();
  const yPaths: PathBook = new Map();
  const cost = (edge: DirectedEdge, q: number) =>
    mode === "user" ? bpr(edge.airHours, q, edge.capacity) : marginal(edge.airHours, q, edge.capacity);
  for (const trip of trips) {
    const path = cheapest(trip.from, trip.to, cost, flow);
    if (!path || path.length < 2) continue;
    addAlong(y, path, trip.vehicles);
    const key = path.join(">");
    const book = yPaths.get(odKey(trip.from, trip.to)) ?? new Map<string, number>();
    book.set(key, (book.get(key) ?? 0) + trip.vehicles);
    yPaths.set(odKey(trip.from, trip.to), book);
  }
  return { flow: y, paths: yPaths };
}

/** Frank–Wolfe. Selfish routing minimizes the Beckmann integral; coordination minimizes vehicle-hours. */
function assign(trips: Trip[], mode: "user" | "system", start?: Loaded): Loaded {
  let flow: Map<string, number>;
  let paths: PathBook;
  if (start) {
    flow = start.flow;
    paths = start.paths;
  } else {
    const first = allOrNothing(trips, new Map(), mode);
    flow = first.flow;
    paths = first.paths;
  }
  const objective = mode === "user" ? beckmann : vehicleHours;
  for (let k = 0; k < FW_ITERS; k++) {
    const direction = allOrNothing(trips, flow, mode);
    let bestA = 0;
    let best = objective(flow);
    for (let i = 1; i <= 12; i++) {
      const a = i / 12;
      const score = objective(mixNum(flow, direction.flow, a));
      if (score < best - 1e-4) {
        best = score;
        bestA = a;
      }
    }
    if (bestA === 0) break;
    flow = mixNum(flow, direction.flow, bestA);
    paths = mixPaths(paths, direction.paths, bestA);
  }
  return { flow, paths };
}

function vehicleHours(flow: Map<string, number>): number {
  let total = 0;
  for (const [key, q] of flow) {
    const [from, to] = key.split(">");
    const edge = directedLink(from, to);
    if (!edge || q <= 0) continue;
    total += q * bpr(edge.airHours, q, edge.capacity);
  }
  return total;
}

export type DirectedLoad = {
  hours: number;
  /** Volume over capacity. May exceed 1. */
  vc: number;
  vehicles: number;
  capacity: number;
  road: string;
  km: number;
};

export type PathLoad = { path: string[]; vehicles: number };

export type Slice = {
  hour: number;
  priceOfAnarchy: number;
  selfishHours: number;
  coordinatedHours: number;
  directed: (from: string, to: string) => DirectedLoad;
  coordinated: (from: string, to: string) => DirectedLoad;
  pathsOf: (from: string, to: string) => PathLoad[];
  systemPathsOf: (from: string, to: string) => PathLoad[];
};

function loadsOf(book: PathBook, from: string, to: string): PathLoad[] {
  const m = book.get(odKey(from, to));
  if (!m) return [];
  const out: PathLoad[] = [];
  for (const [key, vehicles] of m) {
    if (vehicles < 0.5) continue;
    out.push({ path: key.split(">"), vehicles });
  }
  out.sort((a, b) => b.vehicles - a.vehicles);
  return out;
}

function buildSlice(hour: number): Slice {
  const bucket = bucketHour(hour);
  const trips = countedTrips(bucket);
  const user = assign(trips, "user");
  const system = assign(trips, "system", user);
  const selfishHours = vehicleHours(user.flow);
  const coordinatedHours = vehicleHours(system.flow);
  const priceOfAnarchy = coordinatedHours > 1 ? Math.max(1, selfishHours / coordinatedHours) : 1;
  return {
    hour: bucket,
    priceOfAnarchy,
    selfishHours,
    coordinatedHours,
    directed: (from, to) => loadOf(user.flow, from, to),
    coordinated: (from, to) => loadOf(system.flow, from, to),
    pathsOf: (from, to) => loadsOf(user.paths, from, to),
    systemPathsOf: (from, to) => loadsOf(system.paths, from, to),
  };
}

const cache = new Map<number, Slice>();

export function sliceAt(hour: number): Slice {
  const q = Math.round(bucketHour(hour) * 4);
  const hit = cache.get(q);
  if (hit) return hit;
  const slice = buildSlice(q / 4);
  cache.set(q, slice);
  return slice;
}

export function placePressure(id: string, hour: number): number {
  const slice = sliceAt(hour);
  let worst = 0;
  for (const edge of neighbors(id)) {
    worst = Math.max(worst, slice.directed(edge.fromId, edge.toId).vc);
    worst = Math.max(worst, slice.directed(edge.toId, edge.fromId).vc);
  }
  return worst;
}

export function countedDemand(from: string, to: string, hour: number): number {
  const bucket = bucketHour(hour);
  let total = 0;
  for (const spec of DEMANDS) {
    if (spec.from === from && spec.to === to) total += spec.peak * demandShape(spec.kind, bucket);
  }
  return total;
}
