/**
 * PPM solution engine, adapted to time-of-day traffic.
 *
 * Same resolution path as mcp/src/solution-engine.ts in drQedwards/PPM:
 *   1. short-term KV peek
 *   2. long-term graph search (cosine gate, temporal decay)
 *   3. miss → compute, then cache
 * Frequently peeked entries promote into the long-term graph.
 *
 * What gets solved here is the shortest corridor between two cities at a
 * given UTC hour. Edge cost is cruise time inflated by local rush at both
 * ends — so the winning path can change as the day moves.
 *
 * Scoring constants match the PMLL memory graph:
 *   SIMILARITY_THRESHOLD = 0.72
 *   DECAY_LAMBDA = 0.05          (per day)
 *   PROMOTION_THRESHOLD = 3
 *   relevance = similarity * 0.6 + (decay / weight) * 0.4
 *   depthPenalty = 1 / (1 + depth * 0.3)
 */

import { haversineKm, rushFactor, wrap24 } from "./geo";
import {
  CITIES,
  cityAt,
  cityIndexOf,
  neighbors,
  type DirectedEdge,
} from "./network";

const SIMILARITY_THRESHOLD = 0.72;
const DECAY_LAMBDA = 0.05;
const PROMOTION_THRESHOLD = 3;
/** Time features must outweigh the two one-hots so a 3h shift falls under 0.72. */
const TIME_WEIGHT = 6.6;
const HOUR_BUCKET = 0.5;
/** A hop may dogleg this far (km) and still count as progress toward the destination. */
const DETOUR_SLACK_KM = 1600;
const MAX_HOPS = 4;
/** A remembered path is kept only if it is still this close to optimal. */
const STALE_FACTOR = 1.08;

export type MemorySource = "short_term" | "long_term" | "solved";

export type RouteLeg = {
  from: string;
  to: string;
  km: number;
  hours: number;
  /** 0–1 blend of rush at the two ends. */
  congestion: number;
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

function bucketHour(hour: number): number {
  const h = wrap24(hour);
  const b = Math.round(h / HOUR_BUCKET) * HOUR_BUCKET;
  return b >= 24 ? 0 : Math.round(b * 10) / 10;
}

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
 * Door-to-door hours on one directed hop at a UTC hour.
 * Cruise is fixed; traffic inflates it by rush at departure and arrival,
 * scaled by the corridor's sensitivity and the two hubs.
 */
export function edgeHours(edge: DirectedEdge, utcHour: number): { hours: number; congestion: number } {
  const a = cityAt(edge.fromId);
  const b = cityAt(edge.toId);
  const hA = wrap24(utcHour + a.utc);
  const hB = wrap24(utcHour + b.utc);
  const rA = rushFactor(hA);
  const rB = rushFactor(hB);
  const congestion = Math.min(1, rA * 0.55 + rB * 0.45);
  const hubBlend = (a.hub + b.hub) / 2;
  const hours = edge.airHours * (1 + edge.sensitivity * congestion * hubBlend);
  return { hours, congestion };
}

type SolvedPath = { path: string[]; legs: RouteLeg[]; totalHours: number; totalKm: number };

function reconstruct(
  prev: Map<string, { id: string; edge: DirectedEdge } | null>,
  from: string,
  to: string,
  utcHour: number,
): SolvedPath | null {
  if (from === to) {
    return { path: [from], legs: [], totalHours: 0, totalKm: 0 };
  }
  const path: string[] = [];
  let cur: string | null = to;
  const guard = new Set<string>();
  while (cur && cur !== from) {
    if (guard.has(cur)) return null;
    guard.add(cur);
    path.push(cur);
    cur = prev.get(cur)?.id ?? null;
  }
  if (cur !== from) return null;
  path.push(from);
  path.reverse();
  const legs: RouteLeg[] = [];
  let totalHours = 0;
  let totalKm = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const edge = neighbors(path[i]).find((e) => e.toId === path[i + 1]);
    if (!edge) return null;
    const timed = edgeHours(edge, utcHour);
    legs.push({
      from: path[i],
      to: path[i + 1],
      km: edge.km,
      hours: timed.hours,
      congestion: timed.congestion,
    });
    totalHours += timed.hours;
    totalKm += edge.km;
  }
  return { path, legs, totalHours, totalKm };
}

/** Time-dependent Dijkstra. Weights are frozen at `utcHour`. */
export function shortestAt(from: string, to: string, utcHour: number): SolvedPath | null {
  const dist = new Map<string, number>();
  const hops = new Map<string, number>();
  const prev = new Map<string, { id: string; edge: DirectedEdge } | null>();
  for (const c of CITIES) {
    dist.set(c.id, Infinity);
    hops.set(c.id, 0);
    prev.set(c.id, null);
  }
  dist.set(from, 0);
  const dest = cityAt(to);
  const remain = (id: string) => {
    const c = cityAt(id);
    return haversineKm(c.lat, c.lon, dest.lat, dest.lon);
  };
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
    const remFrom = remain(item.id);
    for (const edge of neighbors(item.id)) {
      if (settled.has(edge.toId)) continue;
      if (remain(edge.toId) > remFrom + DETOUR_SLACK_KM) continue;
      const w = edgeHours(edge, utcHour).hours;
      const nd = item.d + w;
      if (nd < (dist.get(edge.toId) ?? Infinity)) {
        dist.set(edge.toId, nd);
        hops.set(edge.toId, item.hops + 1);
        prev.set(edge.toId, { id: item.id, edge });
        queue.push({ id: edge.toId, d: nd, hops: item.hops + 1 });
      }
    }
  }

  return reconstruct(prev, from, to, utcHour);
}

function timePath(path: string[], utcHour: number): SolvedPath | null {
  if (path.length === 0) return null;
  const legs: RouteLeg[] = [];
  let totalHours = 0;
  let totalKm = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const edge = neighbors(path[i]).find((e) => e.toId === path[i + 1]);
    if (!edge) return null;
    const timed = edgeHours(edge, utcHour);
    legs.push({
      from: path[i],
      to: path[i + 1],
      km: edge.km,
      hours: timed.hours,
      congestion: timed.congestion,
    });
    totalHours += timed.hours;
    totalKm += edge.km;
  }
  return { path, legs, totalHours, totalKm };
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
    const key = `route:${from}:${to}:${b.toFixed(1)}`;
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
    const missed = longTerm ? "Remembered path no longer shortest" : "Shortest path for this hour";
    return pack("solved", 1, fresh, stored.peeks, stored.promoted, missed);
  }

  /** 24 hourly samples so the ribbon can show when the corridor flips. */
  profile(from: string, to: string): Array<{ hour: number; totalHours: number; path: string[] }> {
    const out = [];
    for (let h = 0; h < 24; h++) {
      const solved = shortestAt(from, to, h);
      out.push({
        hour: h,
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
    if (this.kv.length > 96) this.kv.shift();
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
    note: from === to ? "Same gateway" : "Shortest path for this hour",
  };
}

export const ENGINE = {
  similarityThreshold: SIMILARITY_THRESHOLD,
  decayLambda: DECAY_LAMBDA,
  promotionThreshold: PROMOTION_THRESHOLD,
} as const;

export function congestionLabel(value: number): "Clear" | "Building" | "Heavy" {
  if (value < 0.28) return "Clear";
  if (value < 0.62) return "Building";
  return "Heavy";
}
