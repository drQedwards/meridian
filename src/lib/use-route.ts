import { useEffect, useMemo, useState } from "react";
import { useMeridian } from "@/lib/meridian-store";
import {
  hourBucket,
  previewRoute,
  solutionEngine,
  type RouteSolution,
} from "@/lib/ppm/solution-engine";

export function useRouteSolution(): {
  solution: RouteSolution;
  profile: Array<{ hour: number; totalHours: number; path: string[] }>;
  resolveAgain: () => void;
} {
  const originId = useMeridian((s) => s.originId);
  const destId = useMeridian((s) => s.destId);
  const hour = useMeridian((s) => s.hour);
  const bucket = hourBucket(hour);
  const [repeats, setRepeats] = useState(0);
  const [live, setLive] = useState<RouteSolution | null>(null);

  const preview = useMemo(() => previewRoute(originId, destId, bucket), [originId, destId, bucket]);

  useEffect(() => {
    setLive(solutionEngine.resolve(originId, destId, bucket));
  }, [originId, destId, bucket, repeats]);

  const profile = useMemo(() => solutionEngine.profile(originId, destId), [originId, destId]);

  const solution = live && live.hour === bucket && live.path[0] === originId && live.path[live.path.length - 1] === destId
    ? live
    : preview;

  return {
    solution,
    profile,
    resolveAgain: () => setRepeats((n) => n + 1),
  };
}