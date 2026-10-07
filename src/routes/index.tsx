import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Hud } from "@/components/meridian/hud";
import { Scene } from "@/components/meridian/scene";
import { useLandMap } from "@/lib/use-land";
import { useRouteSolution } from "@/lib/use-route";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const [ready, setReady] = useState(false);
  const { solution, profile, resolveAgain } = useRouteSolution();
  const map = useLandMap();

  useEffect(() => {
    setReady(true);
  }, []);

  return (
    <main className="relative h-dvh overflow-hidden bg-bg text-fg">
      <div className="stage">{ready ? <Scene solution={solution} map={map} /> : null}</div>
      <Hud solution={solution} profile={profile} onResolveAgain={resolveAgain} />
    </main>
  );
}
