import { Pause, Play } from "lucide-react";
import { CITIES, cityAt } from "@/lib/ppm/network";
import { congestionLabel } from "@/lib/ppm/solution-engine";
import type { RouteSolution } from "@/lib/ppm/solution-engine";
import { formatClock, rushFactor, wrap24 } from "@/lib/ppm/geo";
import { useMeridian } from "@/lib/meridian-store";

const featured = [...CITIES].sort((a, b) => a.name.localeCompare(b.name));

function formatDuration(hours: number): string {
  const total = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
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
  const focusId = useMeridian((s) => s.focusId);
  const holding = useMeridian((s) => s.holding);
  const setPlaying = useMeridian((s) => s.setPlaying);
  const setOrigin = useMeridian((s) => s.setOrigin);
  const setDest = useMeridian((s) => s.setDest);
  const scrubHour = useMeridian((s) => s.scrubHour);
  const focus = useMeridian((s) => s.focus);

  const maxEta = Math.max(...profile.map((p) => p.totalHours));
  const minEta = Math.min(...profile.map((p) => p.totalHours));
  const names = solution.path.map((id) => cityAt(id).name);

  return (
    <aside className="panel" aria-label="Corridor">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="font-display text-xl leading-none tracking-tight text-fg">Meridian</p>
          <p className="mt-1 text-sm text-muted">PPM solution engine</p>
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

      <p className="mt-3 text-xs text-faint">{holding ? "Holding" : "Orbiting"} · drag to turn the globe</p>

      <div className="mt-4 grid grid-cols-2 gap-2">
        <label className="block">
          <span className="mb-1 block text-xs text-muted">From</span>
          <select
            className="field"
            value={originId}
            onChange={(event) => setOrigin(event.target.value)}
          >
            {featured.map((city) => (
              <option key={city.id} value={city.id}>
                {city.name}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted">To</span>
          <select className="field" value={destId} onChange={(event) => setDest(event.target.value)}>
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
          <p className="mt-1 text-xs text-muted">UTC</p>
        </div>
        <div className="text-right">
          <p className="font-mono text-lg leading-none text-fg tabular-nums">{formatDuration(solution.totalHours)}</p>
          <p className="mt-1 text-xs text-muted">
            {Math.max(0, solution.path.length - 1)} hops · {Math.round(solution.totalKm).toLocaleString("en-US")} km
          </p>
        </div>
      </div>

      <p className="mt-3 text-sm text-fg">{names.join(" → ")}</p>
      <p className="mt-1 text-xs text-muted">
        {sourceLabel(solution.source)} · score {solution.score.toFixed(2)} · {solution.note}
      </p>

      <div className="relative mt-4 h-11 shrink-0">
        <div className="pointer-events-none absolute inset-x-0 bottom-2 flex h-8 items-end gap-px" aria-hidden>
          {profile.map((sample) => {
            const span = maxEta - minEta || 1;
            const t = (sample.totalHours - minEta) / span;
            const active = Math.floor(wrap24(hour)) === sample.hour;
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
          max={24}
          step={0.25}
          value={hour}
          aria-label="Time of day, UTC"
          onChange={(event) => scrubHour(Number(event.target.value))}
        />
      </div>
      <p className="mt-1 text-xs text-faint">Day ribbon is door-to-door time. Taller hours are slower.</p>

      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted">
        <span className="tabular-nums">
          {solution.kvSlots} cached · {solution.graphNodes} remembered
        </span>
        <button type="button" className="text-btn" onClick={onResolveAgain}>
          Resolve again
        </button>
      </div>

      <h2 className="mt-5 text-xs font-medium tracking-wide text-muted">Featured locations</h2>
      <ul className="mt-2 min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {featured.map((city) => {
          const local = wrap24(hour + city.utc);
          const level = congestionLabel(rushFactor(local));
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
  );
}
