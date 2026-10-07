import { useEffect, useState } from "react";
import * as THREE from "three";
import { buildLandTexture, type LandData } from "@/components/meridian/land-texture";

export function useLandMap(): THREE.CanvasTexture | null {
  const [map, setMap] = useState<THREE.CanvasTexture | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/land.json")
      .then((response) => {
        if (!response.ok) throw new Error("land");
        return response.json() as Promise<LandData>;
      })
      .then((data) => {
        if (!live) return;
        const tex = new THREE.CanvasTexture(buildLandTexture(data));
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 8;
        tex.needsUpdate = true;
        setMap(tex);
      })
      .catch((error) => {
        console.error(error);
      });
    return () => {
      live = false;
    };
  }, []);
  return map;
}
