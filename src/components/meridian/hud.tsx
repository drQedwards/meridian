import { Pause, Play } from "lucide-react";
import { CITIES, STATE, cityAt, directedLink } from "@/lib/ppm/network";
import { placePressure } from "@/lib/ppm/assignment";
import { congestionLabel } from "@/lib/ppm/solution-engine";
import type { RouteSolution } from "@/lib/ppm/solution-engine";
import { bucketHour, formatClock, wrap24 } from "@/lib/ppm/geo";
import { useMeridian } from "@/lib/meridian-store";

const featured = [...CITIES].filter((city) => city.listed !== false).sort((a, b) => a.name.localeCompare(b.name));

function formatMin(hours: number): string {
  const minutes = Math.max(1, Math.round(hours * 60));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${h} hr` : `${h} hr ${rem}`;
}

function formatMi(km: number): string {
  const mi = km * 0.621371;
  if (mi < 10) return `${mi.toFixed(1)} mi`;
  return `${Math.round(mi)} mi`;
}

function formatVeh(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function splitText(shares: Array<{ via: string; vehicles: number }>): string {
  if (shares.length === 0) return "";
  if (shares.length === 1) return `all ${formatVeh(shares[0].vehicles)} via ${shares[0].via}`;
  return shares.map((share) => `${formatVeh(share.vehicles)} via ${share.via}`).join(" · ");
}

function roadLine(solution: RouteSolution): string {
  const names: string[] = [];
  for (const leg of solution.legs) {
    if (!leg.road || leg.km < 2) continue;
    if (names[names.length - 1] !== leg.road) names.push(leg.road);
  }
  return names.join(" · ");
}

function roadsAlong(ids: string[]): string {
  const names: string[] = [];
  for (let i = 0; i < ids.length - 1; i++) {
    const edge = directedLink(ids[i], ids[i + 1]);
    if (!edge || edge.km < 2) continue;
    if (names[names.length - 1] !== edge.road) names.push(edge.road);
  }
  return names.join(" · ");
}

function sourceLabel(source: RouteSolution["source"]): string {
  if (source === "short_term") return "Short-term memory";
  if (source === "long_term") return "Long-term graph";
  return "Solved on the graph";
}

export function Hud({
  solution,
  profile,
  onResolveAgain,
}: {
  solution: RouteSolution;
  profile: Array<{ hour: number; totalHours: number; path: string[] }>;
  onResolveAgain: () => void;
}) {
  const hour = useMeridian((s) => s.hour);
  const playing = useMeridian((s) => s.playing);
  const originId = useMeridian((s) => s.originId);
  const destId = useMeridian((s) => s.destId);
  const originPoint = useMeridian((s) => s.originPoint);
  const destPoint = useMeridian((s) => s.destPoint);
  const arm = useMeridian((s) => s.arm);
  const focusId = useMeridian((s) => s.focusId);
  const setPlaying = useMeridian((s) => s.setPlaying);
  const setOrigin = useMeridian((s) => s.setOrigin);
  const setDest = useMeridian((s) => s.setDest);
  const setArm = useMeridian((s) => s.setArm);
  const scrubHour = useMeridian((s) => s.scrubHour);
  const focus = useMeridian((s) => s.focus);

  const maxEta = Math.max(...profile.map((p) => p.totalHours));
  const minEta = Math.min(...profile.map((p) => p.totalHours));
  const bucket = bucketHour(hour);
  const names = solution.path
    .map((id) => solution.places[id]?.name ?? (cityAt(id).listed === false ? null : cityAt(id).name))
    .filter((name): name is string => Boolean(name));
  const pct = Math.max(0, Math.round((solution.priceOfAnarchy - 1) * 100));
  const roads = roadLine(solution);
  const first = solution.legs[0];
  const nextRoad = first ? solution.legs.slice(1).find((leg) => leg.road !== first.road)?.road : undefined;
  const altRoads = solution.altHours > 0 ? roadsAlong(solution.altPath) : "";

  return (
    <>
      {first ? (
        <div className="nav-banner">
          <p className="font-mono text-sm tabular-nums text-muted">{formatMi(first.km)}</p>
          <p className="text-lg leading-tight text-fg">{first.road}</p>
          {nextRoad ? <p className="text-sm text-muted">and then {nextRoad}</p> : null}
        </div>
      ) : null}
      <aside className="panel" aria-label="Corridor">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-xl leading-none tracking-tight text-fg">Meridian</p>
          <p className="mt-1 text-sm text-muted">
            {STATE.country} · {STATE.name}
          </p>
        </div>
        <button
          type="button"
          className="grid h-11 w-11 shrink-0 place-items-center rounded-lg border border-border bg-subtle text-fg"
          aria-label={playing ? "Pause the day" : "Play through the day"}
          onClick={() => setPlaying(!playing)}
        >
          {playing ? <Pause size={18} strokeWidth={1.75} /> : <Play size={18} strokeWidth={1.75} />}
        </button>
      </header>

      <p className="mt-3 text-xs text-faint">
        {arm === "origin" ? "Next tap sets the start." : "Next tap sets the end."} Drag still turns the globe.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <button
          type="button"
          className={`text-btn ${arm === "origin" ? "text-fg" : ""}`}
          aria-pressed={arm === "origin"}
          onClick={() => setArm("origin")}
        >
          Set start
        </button>
        <button
          type="button"
          className={`text-btn ${arm === "dest" ? "text-fg" : ""}`}
          aria-pressed={arm === "dest"}
          onClick={() => setArm("dest")}
        >
          Set end
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-xs text-muted">From</span>
          <select
            className="field"
            value={originPoint ? "__pin" : originId}
            onChange={(event) => setOrigin(event.target.value)}
          >
            {originPoint ? (
              <option value="__pin">{solution.places["pin:o"]?.name ?? "Map pin"}</option>
            ) : null}
            {featured.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">To</span>
          <select className="field" value={destPoint ? "__pin" : destId} onChange={(event) => setDest(event.target.value)}>
            {destPoint ? <option value="__pin">{solution.places["pin:d"]?.name ?? "Map pin"}</option> : null}
            {featured.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="mt-4 flex items-end justify-between gap-3">
        <div>
          <p className="font-mono text-2xl leading-none text-fg tabular-nums">{formatClock(hour)}</p>
          <p className="mt-1 text-xs text-muted">{STATE.clock}</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-lg leading-none text-fg tabular-nums">{formatMin(solution.totalHours)}</p>
          <p className="mt-1 text-xs text-muted">
            {formatMi(solution.totalKm)} · {Math.max(0, names.length - 1)} turns
          </p>
        </div>
      </div>

      <p className="mt-3 text-sm text-fg">{names.join(" → ")}</p>
      {roads ? <p className="mt-1 text-xs text-muted">Via {roads}</p> : null}
      {solution.altHours > 0 ? (
        <p className="mt-1 text-xs text-faint">
          Other route {formatMin(solution.altHours)}
          {altRoads ? ` via ${altRoads}` : ""}
        </p>
      ) : (
        <p className="mt-1 text-xs text-faint">The route draws on the globe, then a marker drives it.</p>
      )}
      <p className="mt-1 text-xs text-muted">
        {sourceLabel(solution.source)} · score {solution.score.toFixed(2)} · {solution.note}
      </p>
      <p className="mt-2 text-sm text-fg">Price of anarchy {solution.priceOfAnarchy.toFixed(2)}</p>
      <p className="mt-1 text-xs text-muted">
        {pct === 0
          ? "Selfish and coordinated routing cost the same this quarter."
          : `Selfish trips in Florida cost ${pct}% more time than coordinated routing.`}
      </p>
      <p className="mt-1 text-xs text-faint">
        {solution.counted && solution.shares.length > 0
          ? `Selfish ${splitText(solution.shares)}`
          : `${formatVeh(solution.vehicles)} veh on this path · outside the counted trips`}
      </p>
      {solution.counted && solution.systemShares.length > 0 ? (
        <p className="mt-1 text-xs text-faint">Coordinated {splitText(solution.systemShares)}</p>
      ) : null}

      <div className="relative mt-4 h-11 shrink-0">
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex h-8 items-end" aria-hidden>
          {profile.map((sample) => {
            const span = maxEta - minEta || 1;
            const t = (sample.totalHours - minEta) / span;
            const active = Math.abs(sample.hour - bucket) < 0.01;
            return (
              <span
                key={sample.hour}
                className={`min-w-0 flex-1 ${active ? "bg-accent" : "bg-border"}`}
                style={{ height: `${Math.round(8 + t * 24)}px` }}
              />
            );
          })}
        </div>
        <input
          className="hour-range"
          type="range"
          min={0}
          max={23.75}
          step={0.25}
          value={Math.min(23.75, hour)}
          aria-label="Time of day, Eastern, in 15-minute steps"
          onChange={(event) => scrubHour(Number(event.target.value))}
        />
      </div>
      <p className="mt-1 text-xs text-faint">Each bar is 15 minutes. Taller bars are a slower selfish trip.</p>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted">
        <span className="tabular-nums">
          {solution.kvSlots} cached · {solution.graphNodes} remembered
        </span>
        <button type="button" className="text-btn" onClick={onResolveAgain}>
          Resolve again
        </button>
      </div>

      <h2 className="mt-5 text-xs font-medium tracking-wide text-muted">Florida</h2>
      <ul className="mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {featured.map((city) => {
          const local = wrap24(hour + city.utc);
          const level = congestionLabel(Math.min(1, placePressure(city.id, hour)));
          const tone = level === "Clear" ? "text-ok" : level === "Building" ? "text-warn" : "text-bad";
          const marked = city.id === originId || city.id === destId || city.id === focusId;
          const role = city.id === originId ? "From" : city.id === destId ? "To" : "";
          return (
            <li key={city.id}>
              <button
                type="button"
                className={`city-row ${marked ? "bg-subtle" : ""}`}
                onClick={() => focus(city.id)}
              >
                <span className="min-w-0">
                  <span className="block truncate text-sm text-fg">{city.name}</span>
                  <span className="block text-xs text-faint">{city.region}</span>
                </span>
                <span className="text-right">
                  <span className="block font-mono text-xs text-fg tabular-nums">{formatClock(local)}</span>
                  <span className={`block text-xs ${tone}`}>
                    {level}
                    {role ? ` · ${role}` : ""}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
    </>
  );
}
