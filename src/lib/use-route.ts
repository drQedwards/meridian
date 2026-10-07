import { useEffect, useMemo, useState } from "react";
import { useMeridian } from "@/lib/meridian-store";
import { profileAny, routeAny } from "@/lib/ppm/any-route";
import { cityAt } from "@/lib/ppm/network";
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
  const originPoint = useMeridian((s) => s.originPoint);
  const destPoint = useMeridian((s) => s.destPoint);
  const hour = useMeridian((s) => s.hour);
  const bucket = hourBucket(hour);
  const [repeats, setRepeats] = useState(0);
  const [live, setLive] = useState<RouteSolution | null>(null);
  const pinned = originPoint !== null || destPoint !== null;

  const preview = useMemo(() => {
    if (!pinned) return previewRoute(originId, destId, bucket);
    const origin = originPoint ?? { lat: cityAt(originId).lat, lon: cityAt(originId).lon };
    const dest = destPoint ?? { lat: cityAt(destId).lat, lon: cityAt(destId).lon };
    return routeAny(origin, dest, bucket);
  }, [pinned, originId, destId, originPoint, destPoint, bucket, repeats]);

  const pinnedProfile = useMemo(() => {
    if (!pinned) return null;
    const origin = originPoint ?? { lat: cityAt(originId).lat, lon: cityAt(originId).lon };
    const dest = destPoint ?? { lat: cityAt(destId).lat, lon: cityAt(destId).lon };
    return profileAny(origin, dest);
  }, [pinned, originId, destId, originPoint, destPoint, repeats]);

  useEffect(() => {
    if (pinned) return;
    setLive(solutionEngine.resolve(originId, destId, bucket));
  }, [originId, destId, bucket, repeats, pinned]);

  const cityProfile = useMemo(
    () => (pinned ? [] : solutionEngine.profile(originId, destId)),
    [pinned, originId, destId],
  );

  const solution =
    pinned
      ? preview
      : live && live.hour === bucket && live.path[0] === originId && live.path[live.path.length - 1] === destId
        ? live
        : preview;

  return {
    solution,
    profile: pinnedProfile ?? cityProfile,
    resolveAgain: () => setRepeats((n) => n + 1),
  };
}