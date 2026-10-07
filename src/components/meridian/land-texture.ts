export type LandData = {
  features: Array<{
    geometry: { type: string; coordinates: unknown };
  }>;
};

function outersOf(type: string, coordinates: unknown): number[][][] {
  if (type === "Polygon") {
    const rings = coordinates as number[][][];
    return rings[0] ? [rings[0]] : [];
  }
  if (type === "MultiPolygon") {
    return (coordinates as number[][][][]).map((poly) => poly[0]).filter(Boolean);
  }
  return [];
}

function traceRing(ctx: CanvasRenderingContext2D, ring: number[][], w: number, h: number): void {
  for (let i = 0; i < ring.length; i++) {
    const x = ((ring[i][0] + 180) / 360) * w;
    const y = ((90 - ring[i][1]) / 180) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Equirectangular land mask. Light slate land, ink ocean, readable after night-side emissive. */
export function buildLandTexture(data: LandData): HTMLCanvasElement {
  const w = 2048;
  const h = 1024;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  ctx.fillStyle = "#0a1016";
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = "#d0dae4";
  ctx.strokeStyle = "rgba(236, 242, 247, 0.9)";
  ctx.lineWidth = 1.25;
  ctx.lineJoin = "round";
  for (const feature of data.features) {
    for (const ring of outersOf(feature.geometry.type, feature.geometry.coordinates)) {
      if (ring.length < 3) continue;
      ctx.beginPath();
      traceRing(ctx, ring, w, h);
      ctx.fill();
      ctx.stroke();
    }
  }

  ctx.beginPath();
  ctx.strokeStyle = "rgba(186, 198, 212, 0.16)";
  ctx.lineWidth = 1;
  for (let lon = -180; lon <= 180; lon += 30) {
    const x = ((lon + 180) / 360) * w;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let lat = -60; lat <= 60; lat += 30) {
    const y = ((90 - lat) / 180) * h;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  return canvas;
}
