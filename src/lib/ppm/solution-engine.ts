/**
 * PPM solution engine, adapted to time-of-day traffic.
 *
 * Same resolution path as mcp/src/solution-engine.ts in drQedwards/PPM:
 *   1. short-term KV peek
 *   2. long-term graph search (cosine gate, temporal decay)
 *   3. miss → compute, then cache
 * Frequently peeked entries promote into the long-term graph.
 *
 * What gets solved here is the selfish Florida corridor at a 15-minute slice.
 * Link times come from the equilibrium assignment, so the winning path can
 * change as commute, visitors, and through trips load different roads.
 *
 * Scoring constants match the PMLL memory graph:
 *   SIMILARITY_THRESHOLD = 0.72
 *   DECAY_LAMBDA = 0.05          (per day)
 *   PROMOTION_THRESHOLD = 3
 *   relevance = similarity * 0.6 + (decay / weight) * 0.4
 *   depthPenalty = 1 / (1 + depth * 0.3)
 */

import { bucketHour, wrap24 } from "./geo";
import { countedDemand, probeVehicles, sliceAt } from "./assignment";
import {
  CITIES,
  cityAt,
  cityIndexOf,
  directedLink,
  neighbors,
  type DirectedEdge,
} from "./network";

const SIMILARITY_THRESHOLD = 0.72;
const DECAY_LAMBDA = 0.05;
const PROMOTION_THRESHOLD = 3;
const TIME_WEIGHT = 6.6;
const MAX_HOPS = 14;
/** A remembered path is kept only if it is still this close to optimal. */
const STALE_FACTOR = 1.08;

export type MemorySource = "short_term" | "long_term" | "solved";

export type RouteLeg = {
  from: string;
  to: string;
  km: number;
  hours: number;
  /** 0–1 volume/capacity, worse of the two directions. */
  congestion: number;
  road: string;
  /** Vehicles on this directed link this quarter, Q_a. */
  vehicles: number;
};

export type FlowShare = {
  via: string;
  vehicles: number;
};

export type RouteSolution = {
  source: MemorySource;
  /** PPM relevance, 0–1. Fresh graph solves report the retrieval score they missed with. */
  score: number;
  path: string[];
  legs: RouteLeg[];
  totalHours: number;
  totalKm: number;
  hour: number;
  peeks: number;
  promoted: boolean;
  kvSlots: number;
  graphNodes: number;
  graphEdges: number;
  note: string;
  /** Network vehicle-hours, selfish over coordinated. */
  priceOfAnarchy: number;
  /** Trips between this pair this quarter, Q_ij. */
  vehicles: number;
  /** Vehicles on the shown path, Q_ij^r. */
  pathVehicles: number;
  /** True when this pair is in the counted Florida trip table. */
  counted: boolean;
  systemPath: string[];
  systemHours: number;
  /** Selfish path flows for this pair, largest first. */
  shares: FlowShare[];
  /** Coordinated path flows for this pair, largest first. */
  systemShares: FlowShare[];
  /** The other reasonable road, when one exists. */
  altPath: string[];
  altHours: number;
  /** Pins and other points that are not in the city table. */
  places: Record<string, { name: string; lat: number; lon: number }>;
};

type KvEntry = {
  key: string;
  path: string[];
  hour: number;
  from: string;
  to: string;
  embedding: number[];
  peeks: number;
  createdAt: number;
  promoted: boolean;
};

type GraphNode = {
  id: string;
  key: string;
  path: string[];
  from: string;
  to: string;
  hour: number;
  embedding: number[];
  weight: number;
  createdAt: number;
};

type GraphEdge = {
  source: string;
  target: string;
  relation: "relates_to";
  weight: number;
  createdAt: number;
};

export { bucketHour as hourBucket };

function embed(from: string, to: string, hour: number): number[] {
  const v = new Array<number>(CITIES.length * 2 + 2).fill(0);
  v[cityIndexOf(from)] = 1;
  v[CITIES.length + cityIndexOf(to)] = 1;
  const theta = (wrap24(hour) / 24) * Math.PI * 2;
  v[v.length - 2] = Math.sin(theta) * TIME_WEIGHT;
  v[v.length - 1] = Math.cos(theta) * TIME_WEIGHT;
  return v;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

function decayWeight(weight: number, createdAt: number, now = Date.now()): number {
  const days = (now - createdAt) / 86_400_000;
  return weight * Math.exp(-DECAY_LAMBDA * days);
}

/**
 * Directed link at this quarter. `hours` is the selfish equilibrium time.
 * `congestion` is the worse direction, so a two-way road shows its busy side.
 */
export function edgeHours(edge: DirectedEdge, hour: number): {
  hours: number;
  congestion: number;
  vehicles: number;
  road: string;
} {
  const slice = sliceAt(hour);
  const go = slice.directed(edge.fromId, edge.toId);
  const back = slice.directed(edge.toId, edge.fromId);
  return {
    hours: go.hours,
    congestion: Math.min(1, Math.max(go.vc, back.vc)),
    vehicles: go.vehicles,
    road: go.road,
  };
}

function legBetween(from: string, to: string, hour: number): RouteLeg | null {
  const edge = neighbors(from).find((e) => e.toId === to);
  if (!edge) return null;
  const timed = edgeHours(edge, hour);
  return {
    from,
    to,
    km: edge.km,
    hours: timed.hours,
    congestion: timed.congestion,
    road: timed.road || edge.road,
    vehicles: timed.vehicles,
  };
}

type SolvedPath = { path: string[]; legs: RouteLeg[]; totalHours: number; totalKm: number };

function timePath(path: string[], hour: number): SolvedPath | null {
  if (path.length === 0) return null;
  const legs: RouteLeg[] = [];
  let totalHours = 0;
  let totalKm = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const leg = legBetween(path[i], path[i + 1], hour);
    if (!leg) return null;
    legs.push(leg);
    totalHours += leg.hours;
    totalKm += leg.km;
  }
  return { path, legs, totalHours, totalKm };
}

/** Selfish path at this quarter: the path carrying the most of this pair, else the cheapest road. */
export function shortestAt(from: string, to: string, hour: number): SolvedPath | null {
  const slice = sliceAt(hour);
  const dominant = slice.pathsOf(from, to)[0];
  if (dominant && dominant.path.length > 1) {
    const timed = timePath(dominant.path, slice.hour);
    if (timed) return timed;
  }
  return dijkstra(from, to, slice.hour);
}

function dijkstra(
  from: string,
  to: string,
  hour: number,
  hoursOf: (edge: DirectedEdge) => number = (edge) => edgeHours(edge, hour).hours,
): SolvedPath | null {
  const dist = new Map<string, number>();
  const hops = new Map<string, number>();
  const prev = new Map<string, string | null>();
  for (const c of CITIES) {
    dist.set(c.id, Infinity);
    hops.set(c.id, 0);
    prev.set(c.id, null);
  }
  dist.set(from, 0);
  const queue: Array<{ id: string; d: number; hops: number }> = [{ id: from, d: 0, hops: 0 }];
  const settled = new Set<string>();

  while (queue.length) {
    let bestI = 0;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i].d < queue[bestI].d) bestI = i;
    }
    const item = queue.splice(bestI, 1)[0];
    if (settled.has(item.id) || item.d !== dist.get(item.id)) continue;
    settled.add(item.id);
    if (item.id === to) break;
    if (item.hops >= MAX_HOPS) continue;
    for (const edge of neighbors(item.id)) {
      if (settled.has(edge.toId)) continue;
      const w = hoursOf(edge);
      const nd = item.d + w;
      if (nd < (dist.get(edge.toId) ?? Infinity)) {
        dist.set(edge.toId, nd);
        hops.set(edge.toId, item.hops + 1);
        prev.set(edge.toId, item.id);
        queue.push({ id: edge.toId, d: nd, hops: item.hops + 1 });
      }
    }
  }

  if (from === to) return { path: [from], legs: [], totalHours: 0, totalKm: 0 };
  const path: string[] = [];
  let cur: string | null = to;
  const guard = new Set<string>();
  while (cur && cur !== from) {
    if (guard.has(cur)) return null;
    guard.add(cur);
    path.push(cur);
    cur = prev.get(cur) ?? null;
  }
  if (cur !== from) return null;
  path.push(from);
  path.reverse();
  return timePath(path, hour);
}

/** A second road that may share the driveway but not the long stretch of the first. */
function otherPath(from: string, to: string, primary: string[], hour: number): { path: string[]; hours: number } {
  if (from === to || primary.length < 2) return { path: primary, hours: 0 };
  const costly = new Set<string>();
  for (let i = 0; i < primary.length - 1; i++) {
    const edge = directedLink(primary[i], primary[i + 1]);
    if (edge && edge.km >= 2) costly.add(`${primary[i]}>${primary[i + 1]}`);
  }
  const alt = dijkstra(from, to, hour, (edge) => {
    const hours = edgeHours(edge, hour).hours;
    return costly.has(`${edge.fromId}>${edge.toId}`) ? hours * 5 : hours;
  });
  if (!alt || alt.path.join(">") === primary.join(">")) return { path: primary, hours: 0 };
  return { path: alt.path, hours: alt.totalHours };
}

function shareOf(items: Array<{ path: string[]; vehicles: number }>): FlowShare[] {
  return items.slice(0, 3).map((item) => ({
    via: cityAt(item.path[1] ?? item.path[0]).name,
    vehicles: item.vehicles,
  }));
}

function trafficOf(from: string, to: string, path: string[], hour: number) {
  const slice = sliceAt(hour);
  const countedRaw = countedDemand(from, to, hour);
  const counted = countedRaw > 0;
  const flows = slice.pathsOf(from, to);
  const assigned = flows.reduce((sum, item) => sum + item.vehicles, 0);
  const onThis = flows.find((item) => item.path.join(">") === path.join(">"));
  const vehicles = counted ? (assigned > 0 ? assigned : countedRaw) : probeVehicles(from, to, hour);
  const pathVehicles = onThis ? onThis.vehicles : vehicles;
  const coordinated = slice.systemPathsOf(from, to)[0];
  const systemSolved = coordinated
    ? timePath(coordinated.path, hour)
    : dijkstra(from, to, hour, (edge) => slice.coordinated(edge.fromId, edge.toId).hours);
  const systemPath = systemSolved?.path ?? path;
  let systemHours = 0;
  for (let i = 0; i < systemPath.length - 1; i++) {
    systemHours += slice.coordinated(systemPath[i], systemPath[i + 1]).hours;
  }
  const other = otherPath(from, to, path, hour);
  return {
    priceOfAnarchy: slice.priceOfAnarchy,
    vehicles,
    pathVehicles,
    counted,
    systemPath,
    systemHours,
    shares: shareOf(flows),
    systemShares: shareOf(slice.systemPathsOf(from, to)),
    altPath: other.path,
    altHours: other.hours,
    places: {},
  };
}

function relevance(similarity: number, weight: number, createdAt: number, depth: number): number {
  const decayed = decayWeight(weight, createdAt);
  const depthPenalty = 1 / (1 + depth * 0.3);
  const blended = similarity * 0.6 + (decayed / Math.max(weight, 0.01)) * 0.4;
  return blended * depthPenalty;
}

class SolutionEngine {
  private kv: KvEntry[] = [];
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];
  private seq = 1;
  /** Collapse React strict-mode double resolve into one visible answer. */
  private lastResult: { key: string; at: number; result: RouteSolution } | null = null;

  reset(): void {
    this.kv = [];
    this.nodes = [];
    this.edges = [];
    this.seq = 1;
    this.lastResult = null;
  }

  status(): { kvSlots: number; graphNodes: number; graphEdges: number; promotionThreshold: number } {
    return {
      kvSlots: this.kv.length,
      graphNodes: this.nodes.length,
      graphEdges: this.edges.length,
      promotionThreshold: PROMOTION_THRESHOLD,
    };
  }

  /**
   * resolveContext for a route query.
   * Short-term hit → score 1. Long-term hit only if cosine ≥ 0.72 and the
   * remembered path is still within 8% of a fresh shortest path at this hour.
   * Otherwise Dijkstra, then store.
   */
  resolve(from: string, to: string, hour: number): RouteSolution {
    const b = bucketHour(hour);
    const key = `route:${from}:${to}:${b.toFixed(2)}`;
    const now = Date.now();
    if (this.lastResult && this.lastResult.key === key && now - this.lastResult.at < 90) {
      return this.lastResult.result;
    }

    const stats = () => this.status();
    const pack = (
      source: MemorySource,
      score: number,
      solved: SolvedPath,
      peeks: number,
      promoted: boolean,
      note: string,
    ): RouteSolution => {
      const result: RouteSolution = {
        source,
        score,
        path: solved.path,
        legs: solved.legs,
        totalHours: solved.totalHours,
        totalKm: solved.totalKm,
        hour: b,
        peeks,
        promoted,
        ...stats(),
        note,
        ...trafficOf(from, to, solved.path, b),
      };
      this.lastResult = { key, at: now, result };
      return result;
    };

    if (from === to) {
      return pack("solved", 1, { path: [from], legs: [], totalHours: 0, totalKm: 0 }, 0, false, "Same gateway");
    }

    const hit = this.kv.find((e) => e.key === key);
    if (hit) {
      hit.peeks += 1;
      const promoted = this.maybePromote(hit);
      const timed = timePath(hit.path, b);
      if (timed) {
        return pack(
          "short_term",
          1,
          timed,
          hit.peeks,
          promoted || hit.promoted,
          hit.promoted ? "Kept in short-term memory" : "Reused from short-term memory",
        );
      }
    }

    const query = embed(from, to, b);
    const longTerm = this.searchLongTerm(query, from, to);
    const fresh = shortestAt(from, to, b);
    if (!fresh) {
      return pack("solved", 0, { path: [from], legs: [], totalHours: 0, totalKm: 0 }, 0, false, "No corridor");
    }

    if (longTerm) {
      const remembered = timePath(longTerm.node.path, b);
      if (remembered && remembered.totalHours <= fresh.totalHours * STALE_FACTOR) {
        this.remember(key, from, to, b, remembered.path, query);
        const stored = this.kv.find((e) => e.key === key)!;
        return pack(
          "long_term",
          longTerm.score,
          remembered,
          stored.peeks,
          stored.promoted,
          "Reused from long-term memory",
        );
      }
    }

    this.remember(key, from, to, b, fresh.path, query);
    const stored = this.kv.find((e) => e.key === key)!;
    const missed = longTerm ? "Remembered path no longer the loaded one" : "Selfish path for this quarter";
    return pack("solved", 1, fresh, stored.peeks, stored.promoted, missed);
  }

  /** One sample per 15-minute slice, so the ribbon can show the day flip. */
  profile(from: string, to: string): Array<{ hour: number; totalHours: number; path: string[] }> {
    const out = [];
    for (let q = 0; q < 96; q++) {
      const hour = q / 4;
      const solved = shortestAt(from, to, hour);
      out.push({
        hour,
        totalHours: solved?.totalHours ?? 0,
        path: solved?.path ?? [],
      });
    }
    return out;
  }

  private remember(key: string, from: string, to: string, hour: number, path: string[], embedding: number[]): KvEntry {
    const existing = this.kv.find((e) => e.key === key);
    if (existing) return existing;
    const entry: KvEntry = {
      key,
      path,
      hour,
      from,
      to,
      embedding,
      peeks: 1,
      createdAt: Date.now(),
      promoted: false,
    };
    this.kv.push(entry);
    if (this.kv.length > 320) this.kv.shift();
    return entry;
  }

  private maybePromote(entry: KvEntry): boolean {
    if (entry.promoted || entry.peeks < PROMOTION_THRESHOLD) return entry.promoted;
    const id = `n${this.seq++}`;
    this.nodes.push({
      id,
      key: entry.key,
      path: entry.path,
      from: entry.from,
      to: entry.to,
      hour: entry.hour,
      embedding: entry.embedding,
      weight: 1,
      createdAt: Date.now(),
    });
    const kin = this.nodes.filter((n) => n.id !== id && n.from === entry.from && n.to === entry.to);
    for (const other of kin) {
      const sim = cosine(entry.embedding, other.embedding);
      if (sim >= SIMILARITY_THRESHOLD) {
        this.edges.push({
          source: id,
          target: other.id,
          relation: "relates_to",
          weight: sim,
          createdAt: Date.now(),
        });
      }
    }
    entry.promoted = true;
    return true;
  }

  private searchLongTerm(
    query: number[],
    from: string,
    to: string,
  ): { node: GraphNode; score: number } | null {
    let best: { node: GraphNode; score: number } | null = null;
    for (const node of this.nodes) {
      if (node.from !== from || node.to !== to) continue;
      const sim = cosine(query, node.embedding);
      if (sim < SIMILARITY_THRESHOLD) continue;
      // Direct hit, depth 0 — same blend the memory graph uses on a neighbor walk.
      const score = relevance(sim, node.weight, node.createdAt, 0);
      if (!best || score > best.score) best = { node, score };
    }
    return best;
  }
}

export const solutionEngine = new SolutionEngine();

export function previewRoute(from: string, to: string, hour: number): RouteSolution {
  const b = bucketHour(hour);
  const solved = shortestAt(from, to, b) ?? { path: [from], legs: [], totalHours: 0, totalKm: 0 };
  return {
    source: "solved",
    score: 1,
    path: solved.path,
    legs: solved.legs,
    totalHours: solved.totalHours,
    totalKm: solved.totalKm,
    hour: b,
    peeks: 0,
    promoted: false,
    kvSlots: 0,
    graphNodes: 0,
    graphEdges: 0,
    note: from === to ? "Same place" : "Selfish path for this quarter",
    ...trafficOf(from, to, solved.path, b),
  };
}

export const ENGINE = {
  similarityThreshold: SIMILARITY_THRESHOLD,
  decayLambda: DECAY_LAMBDA,
  promotionThreshold: PROMOTION_THRESHOLD,
} as const;

export function congestionLabel(value: number): "Clear" | "Building" | "Heavy" {
  if (value < 0.45) return "Clear";
  if (value < 0.8) return "Building";
  return "Heavy";
}
