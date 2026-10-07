import { haversineKm, latLonToVec, vecToLatLon, type Vec3 } from "./geo";
import { CORRIDORS, CITIES, cityAt, neighbors, type DirectedEdge } from "./network";
import {
  edgeHours,
  previewRoute,
  solutionEngine,
  type RouteLeg,
  type RouteSolution,
} from "./solution-engine";
import { sliceAt } from "./assignment";

export type GeoPoint = { lat: number; lon: number };

type Snap = {
  lat: number;
  lon: number;
  from: string;
  to: string;
  /** 0 at `from`, 1 at `to`. */
  t: number;
  km: number;
  road: string;
};

type End =
  | { kind: "city"; id: string }
  | { kind: "pin"; id: string; snap: Snap };

type Step = {
  to: string;
  km: number;
  hours: number;
  road: string;
  congestion: number;
  vehicles: number;
};

function slerpPoint(a: Vec3, b: Vec3, t: number): { lat: number; lon: number } {
  const al = Math.hypot(a[0], a[1], a[2]) || 1;
  const bl = Math.hypot(b[0], b[1], b[2]) || 1;
  const au: Vec3 = [a[0] / al, a[1] / al, a[2] / al];
  const bu: Vec3 = [b[0] / bl, b[1] / bl, b[2] / bl];
  const cos = Math.max(-1, Math.min(1, au[0] * bu[0] + au[1] * bu[1] + au[2] * bu[2]));
  const omega = Math.acos(cos);
  let p: Vec3;
  if (omega < 1e-4) p = au;
  else {
    const s = Math.sin(omega);
    const p0 = Math.sin((1 - t) * omega) / s;
    const p1 = Math.sin(t * omega) / s;
    p = [p0 * au[0] + p1 * bu[0], p0 * au[1] + p1 * bu[1], p0 * au[2] + p1 * bu[2]];
  }
  return vecToLatLon(p[0], p[1], p[2]);
}

function nearestOnNetwork(lat: number, lon: number): { snap: Snap; offKm: number } | null {
  let best: Snap | null = null;
  let offKm = Infinity;
  for (const edge of CORRIDORS) {
    const a = cityAt(edge.from);
    const b = cityAt(edge.to);
    const av = latLonToVec(a.lat, a.lon, 1);
    const bv = latLonToVec(b.lat, b.lon, 1);
    const steps = Math.max(2, Math.ceil(edge.km / 3));
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const p = slerpPoint(av, bv, t);
      const d = haversineKm(lat, lon, p.lat, p.lon);
      if (d < offKm) {
        offKm = d;
        best = { lat: p.lat, lon: p.lon, from: edge.from, to: edge.to, t, km: edge.km, road: edge.road };
      }
    }
  }
  if (!best) return null;
  return { snap: best, offKm };
}

function nearestCity(lat: number, lon: number): { id: string; km: number } {
  let id = CITIES[0].id;
  let km = Infinity;
  for (const city of CITIES) {
    if (city.listed === false) continue;
    const d = haversineKm(lat, lon, city.lat, city.lon);
    if (d < km) {
      km = d;
      id = city.id;
    }
  }
  return { id, km };
}

function resolveEnd(point: GeoPoint, pinId: string): End {
  const city = nearestCity(point.lat, point.lon);
  const snapped = nearestOnNetwork(point.lat, point.lon);
  if (!snapped || city.km <= snapped.offKm + 1 || city.km < 8) return { kind: "city", id: city.id };
  if (snapped.offKm > 90) return { kind: "city", id: city.id };
  if (snapped.snap.t < 0.04) return { kind: "city", id: snapped.snap.from };
  if (snapped.snap.t > 0.96) return { kind: "city", id: snapped.snap.to };
  return { kind: "pin", id: pinId, snap: snapped.snap };
}

function directed(from: string, to: string): DirectedEdge | undefined {
  return neighbors(from).find((edge) => edge.toId === to);
}

function addCityLinks(extra: Map<string, Step[]>, hour: number) {
  for (const city of CITIES) {
    const list: Step[] = [];
    for (const edge of neighbors(city.id)) {
      const timed = edgeHours(edge, hour);
      list.push({
        to: edge.toId,
        km: edge.km,
        hours: timed.hours,
        road: edge.road,
        congestion: timed.congestion,
        vehicles: timed.vehicles,
      });
    }
    extra.set(city.id, list);
  }
}

function spur(pin: End & { kind: "pin" }, hour: number): Step[] {
  const { snap } = pin;
  const forward = directed(snap.from, snap.to);
  const back = directed(snap.to, snap.from);
  const steps: Step[] = [];
  if (back) {
    const timed = edgeHours(back, hour);
    steps.push({
      to: snap.from,
      km: snap.km * snap.t,
      hours: timed.hours * snap.t,
      road: snap.road,
      congestion: timed.congestion,
      vehicles: timed.vehicles,
    });
  }
  if (forward) {
    const timed = edgeHours(forward, hour);
    steps.push({
      to: snap.to,
      km: snap.km * (1 - snap.t),
      hours: timed.hours * (1 - snap.t),
      road: snap.road,
      congestion: timed.congestion,
      vehicles: timed.vehicles,
    });
  }
  return steps;
}

function linkPins(a: End, b: End, graph: Map<string, Step[]>, hour: number) {
  if (a.kind !== "pin" || b.kind !== "pin") return;
  const same =
    (a.snap.from === b.snap.from && a.snap.to === b.snap.to) ||
    (a.snap.from === b.snap.to && a.snap.to === b.snap.from);
  if (!same) return;
  const forward = a.snap.from === b.snap.from;
  const tA = a.snap.t;
  const tB = forward ? b.snap.t : 1 - b.snap.t;
  const edge = directed(a.snap.from, a.snap.to);
  if (!edge) return;
  const span = Math.abs(tB - tA);
  const goingToB = tB >= tA;
  const timed = edgeHours(goingToB ? edge : directed(a.snap.to, a.snap.from) ?? edge, hour);
  const step = (to: string): Step => ({
    to,
    km: edge.km * span,
    hours: timed.hours * span,
    road: edge.road,
    congestion: timed.congestion,
    vehicles: timed.vehicles,
  });
  graph.get(a.id)?.push(step(b.id));
  graph.get(b.id)?.push(step(a.id));
}

function solve(
  from: string,
  to: string,
  graph: Map<string, Step[]>,
  penalize: Set<string>,
): { path: string[]; legs: RouteLeg[] } | null {
  const dist = new Map<string, number>();
  const prev = new Map<string, string | null>();
  const hops = new Map<string, number>();
  const nodes = new Set<string>([...CITIES.map((c) => c.id), ...graph.keys()]);
  for (const id of nodes) {
    dist.set(id, Infinity);
    prev.set(id, null);
    hops.set(id, 0);
  }
  dist.set(from, 0);
  const queue: Array<{ id: string; d: number; hops: number }> = [{ id: from, d: 0, hops: 0 }];
  const settled = new Set<string>();
  while (queue.length) {
    let bestI = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].d < queue[bestI].d) bestI = i;
    const item = queue.splice(bestI, 1)[0];
    if (settled.has(item.id) || item.d !== dist.get(item.id)) continue;
    settled.add(item.id);
    if (item.id === to) break;
    if (item.hops >= 18) continue;
    for (const step of graph.get(item.id) ?? []) {
      if (settled.has(step.to)) continue;
      const penalty = penalize.has(`${item.id}>${step.to}`) && step.km >= 2 ? 5 : 1;
      const nd = item.d + step.hours * penalty;
      if (nd < (dist.get(step.to) ?? Infinity)) {
        dist.set(step.to, nd);
        prev.set(step.to, item.id);
        hops.set(step.to, item.hops + 1);
        queue.push({ id: step.to, d: nd, hops: item.hops + 1 });
      }
    }
  }
  if ((dist.get(to) ?? Infinity) === Infinity) return null;
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
  const legs: RouteLeg[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const step = (graph.get(path[i]) ?? []).find((edge) => edge.to === path[i + 1]);
    if (!step) return null;
    legs.push({
      from: path[i],
      to: path[i + 1],
      km: step.km,
      hours: step.hours,
      congestion: step.congestion,
      road: step.road,
      vehicles: step.vehicles,
    });
  }
  return { path, legs };
}

function graphFor(from: End, to: End, hour: number): Map<string, Step[]> {
  const graph = new Map<string, Step[]>();
  addCityLinks(graph, hour);
  for (const end of [from, to]) {
    if (end.kind !== "pin") continue;
    graph.set(end.id, spur(end, hour));
    for (const step of graph.get(end.id) ?? []) {
      const back = graph.get(step.to) ?? [];
      back.push({ ...step, to: end.id });
      graph.set(step.to, back);
    }
  }
  linkPins(from, to, graph, hour);
  return graph;
}

function placesFor(from: End, to: End): RouteSolution["places"] {
  const places: RouteSolution["places"] = {};
  for (const end of [from, to]) {
    if (end.kind !== "pin") continue;
    places[end.id] = { name: `On ${end.snap.road}`, lat: end.snap.lat, lon: end.snap.lon };
  }
  return places;
}

/** Best road between any two map points, snapped onto the Florida network. */
export function routeAny(a: GeoPoint, b: GeoPoint, hour: number): RouteSolution {
  const from = resolveEnd(a, "pin:o");
  const to = resolveEnd(b, "pin:d");
  if (from.kind === "city" && to.kind === "city") return previewRoute(from.id, to.id, hour);
  const fromId = from.id;
  const toId = to.id;
  if (fromId === toId) return previewRoute(from.kind === "city" ? from.id : CITIES[0].id, from.kind === "city" ? from.id : CITIES[0].id, hour);
  const graph = graphFor(from, to, hour);
  const best = solve(fromId, toId, graph, new Set());
  const slice = sliceAt(hour);
  const stats = solutionEngine.status();
  if (!best) {
    const fallback = from.kind === "city" ? from.id : to.kind === "city" ? to.id : "hsa";
    return previewRoute(fallback, fallback, hour);
  }
  const banned = new Set<string>();
  for (let i = 0; i < best.path.length - 1; i++) {
    if (best.legs[i].km >= 2) banned.add(`${best.path[i]}>${best.path[i + 1]}`);
  }
  const alt = solve(fromId, toId, graph, banned);
  const same = !alt || alt.path.join(">") === best.path.join(">");
  const altHours = same || !alt ? 0 : alt.legs.reduce((sum, leg) => sum + leg.hours, 0);
  const totalHours = best.legs.reduce((sum, leg) => sum + leg.hours, 0);
  const totalKm = best.legs.reduce((sum, leg) => sum + leg.km, 0);
  return {
    source: "solved",
    score: 1,
    path: best.path,
    legs: best.legs,
    totalHours,
    totalKm,
    hour: slice.hour,
    peeks: 0,
    promoted: false,
    kvSlots: stats.kvSlots,
    graphNodes: stats.graphNodes,
    graphEdges: stats.graphEdges,
    note: "Snapped to the nearest road",
    priceOfAnarchy: slice.priceOfAnarchy,
    vehicles: 0,
    pathVehicles: 0,
    counted: false,
    systemPath: same || !alt ? best.path : alt.path,
    systemHours: altHours,
    shares: [],
    systemShares: [],
    altPath: same || !alt ? best.path : alt.path,
    altHours,
    places: placesFor(from, to),
  };
}

export function profileAny(a: GeoPoint, b: GeoPoint): Array<{ hour: number; totalHours: number; path: string[] }> {
  const out: Array<{ hour: number; totalHours: number; path: string[] }> = [];
  for (let q = 0; q < 96; q++) {
    const hour = q / 4;
    const solved = routeAny(a, b, hour);
    out.push({ hour, totalHours: solved.totalHours, path: solved.path });
  }
  return out;
}
