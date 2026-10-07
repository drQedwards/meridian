import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { arcPoints, latLonToVec } from "@/lib/ppm/geo";
import { CITIES, CORRIDORS, cityAt, type City } from "@/lib/ppm/network";
import { edgeHours } from "@/lib/ppm/solution-engine";
import type { RouteSolution } from "@/lib/ppm/solution-engine";
import { useMeridian } from "@/lib/meridian-store";

const GLOBE = new THREE.Color("#07080a");
const OK = new THREE.Color("#b7d7c8");
const WARN = new THREE.Color("#e4d2b0");
const BAD = new THREE.Color("#e4b4ae");
const UP = new THREE.Vector3(0, 1, 0);
const scratchColor = new THREE.Color();
const scratchSph = new THREE.Spherical();
const scratchOffset = new THREE.Vector3();
const scratchTangent = new THREE.Vector3();

function angDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function trafficColor(amount: number, out: THREE.Color): THREE.Color {
  const t = THREE.MathUtils.clamp(amount, 0, 1);
  if (t < 0.5) return out.copy(OK).lerp(WARN, t / 0.5);
  return out.copy(WARN).lerp(BAD, (t - 0.5) / 0.5);
}

type Aim = { phi: number; theta: number; radius: number };

function aimForPath(path: string[], target: THREE.Vector3): Aim | null {
  if (path.length === 0) return null;
  const dir = new THREE.Vector3();
  const pts: THREE.Vector3[] = [];
  for (const id of path) {
    const city = cityAt(id);
    const v = latLonToVec(city.lat, city.lon, 1);
    const p = new THREE.Vector3(v[0], v[1], v[2]);
    pts.push(p);
    dir.add(p);
  }
  if (dir.lengthSq() < 1e-8) return null;
  dir.normalize();
  let maxAng = 0.006;
  for (const p of pts) maxAng = Math.max(maxAng, dir.angleTo(p));
  const distance = THREE.MathUtils.clamp(1.016 + maxAng * 3.6, 1.03, 2.55);
  scratchOffset.copy(dir).multiplyScalar(distance).sub(target);
  scratchSph.setFromVector3(scratchOffset);
  return { phi: scratchSph.phi, theta: scratchSph.theta, radius: scratchSph.radius };
}

function ClockDriver() {
  const acc = useRef(0);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    if (!useMeridian.getState().playing) return;
    acc.current += dt;
    if (acc.current < 0.5) return;
    acc.current = 0;
    const { hour, setHour } = useMeridian.getState();
    setHour(hour + 0.25);
  });
  return null;
}

function Sun() {
  const hour = useMeridian((s) => s.hour);
  const utc = (hour + 4 + 24) % 24;
  const pos = latLonToVec(18, (12 - utc) * 15, 8);
  return <directionalLight position={pos} intensity={1.15} color="#fff4e4" />;
}

function Stars() {
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    const arr = new Float32Array(700 * 3);
    const dir = new THREE.Vector3();
    for (let i = 0; i < 700; i++) {
      dir.randomDirection().multiplyScalar(28 + Math.random() * 14);
      arr[i * 3] = dir.x;
      arr[i * 3 + 1] = dir.y;
      arr[i * 3 + 2] = dir.z;
    }
    g.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    return g;
  }, []);
  return (
    <points geometry={geometry}>
      <pointsMaterial color="#d5dde6" size={1.15} sizeAttenuation={false} transparent opacity={0.75} />
    </points>
  );
}

function Atmosphere() {
  const material = useMemo(
    () =>
      new THREE.ShaderMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.FrontSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        vertexShader: `
          varying vec3 vN;
          varying vec3 vW;
          void main() {
            vN = normalize(mat3(modelMatrix) * normal);
            vec4 w = modelMatrix * vec4(position, 1.0);
            vW = w.xyz;
            gl_Position = projectionMatrix * viewMatrix * w;
          }
        `,
        fragmentShader: `
          varying vec3 vN;
          varying vec3 vW;
          void main() {
            vec3 viewDir = normalize(cameraPosition - vW);
            float fres = pow(1.0 - max(dot(normalize(vN), viewDir), 0.0), 3.1);
            gl_FragColor = vec4(0.58, 0.70, 0.84, fres * 0.48);
          }
        `,
      }),
    [],
  );
  return (
    <mesh scale={1.055} material={material}>
      <sphereGeometry args={[1, 64, 48]} />
    </mesh>
  );
}

function Earth({ map }: { map: THREE.Texture | null }) {
  const gl = useThree((s) => s.gl);
  useLayoutEffect(() => {
    if (!map) return;
    map.anisotropy = Math.min(8, gl.capabilities.getMaxAnisotropy());
    map.needsUpdate = true;
  }, [gl, map]);
  return (
    <mesh>
      <sphereGeometry args={[1, 96, 72]} />
      <meshLambertMaterial
        map={map ?? undefined}
        emissiveMap={map ?? undefined}
        emissive={map ? "#93a0ad" : "#000000"}
        color={map ? "#ffffff" : "#1a222c"}
      />
    </mesh>
  );
}

function TrafficField() {
  const hour = useMeridian((s) => s.hour);
  const geometry = useMemo(() => {
    const positions: number[] = [];
    const colors: number[] = [];
    const ranges: Array<{ start: number; count: number; from: string; to: string }> = [];
    for (const edge of CORRIDORS) {
      const a = cityAt(edge.from);
      const b = cityAt(edge.to);
      const pts = arcPoints(latLonToVec(a.lat, a.lon), latLonToVec(b.lat, b.lon), 28);
      const start = positions.length / 3;
      for (let i = 0; i < pts.length - 1; i++) {
        positions.push(...pts[i], ...pts[i + 1]);
        colors.push(1, 1, 1, 1, 1, 1);
      }
      ranges.push({ start, count: (pts.length - 1) * 2, from: edge.from, to: edge.to });
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    g.userData.ranges = ranges;
    return g;
  }, []);

  useLayoutEffect(() => {
    const attr = geometry.getAttribute("color") as THREE.BufferAttribute;
    const ranges = geometry.userData.ranges as Array<{
      start: number;
      count: number;
      from: string;
      to: string;
    }>;
    const scratchColor = new THREE.Color();
    for (const range of ranges) {
      const edge = CORRIDORS.find((e) => e.from === range.from && e.to === range.to);
      if (!edge) continue;
      const timed = edgeHours({ ...edge, fromId: edge.from, toId: edge.to }, hour);
      trafficColor(timed.congestion, scratchColor);
      for (let i = 0; i < range.count; i++) {
        attr.setXYZ(range.start + i, scratchColor.r, scratchColor.g, scratchColor.b);
      }
    }
    attr.needsUpdate = true;
  }, [geometry, hour]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial vertexColors transparent opacity={0.72} depthWrite={false} />
    </lineSegments>
  );
}

type Ribbon = {
  core: THREE.TubeGeometry;
  casing: THREE.TubeGeometry;
  pts: THREE.Vector3[];
  owner: number[];
  tubular: number;
  radial: number;
  radius: number;
};

function setRibbonDraw(geometry: THREE.BufferGeometry, t: number) {
  const index = geometry.index;
  if (!index) return;
  const count = t >= 1 ? index.count : Math.max(0, Math.floor(index.count * t));
  if (geometry.drawRange.start !== 0 || geometry.drawRange.count !== count) {
    geometry.setDrawRange(0, count);
  }
}

function traceCities(ids: string[], clearance: number): { pts: THREE.Vector3[]; owner: number[] } {
  const pts: THREE.Vector3[] = [];
  const owner: number[] = [];
  for (let leg = 0; leg < ids.length - 1; leg++) {
    const a = cityAt(ids[leg]);
    const b = cityAt(ids[leg + 1]);
    const seg = arcPoints(latLonToVec(a.lat, a.lon), latLonToVec(b.lat, b.lon), 16);
    const start = leg === 0 ? 0 : 1;
    for (let i = start; i < seg.length; i++) {
      const p = seg[i];
      const v = new THREE.Vector3(p[0], p[1], p[2]);
      const len = v.length() || 1;
      v.multiplyScalar((len + clearance) / len);
      pts.push(v);
      owner.push(leg);
    }
  }
  return { pts, owner };
}

function routeSpan(ids: string[]): number {
  const dir = new THREE.Vector3();
  const pts: THREE.Vector3[] = [];
  for (const id of ids) {
    const city = cityAt(id);
    const v = latLonToVec(city.lat, city.lon, 1);
    const p = new THREE.Vector3(v[0], v[1], v[2]);
    pts.push(p);
    dir.add(p);
  }
  if (dir.lengthSq() < 1e-8) return 0.02;
  dir.normalize();
  let max = 0.004;
  for (const p of pts) max = Math.max(max, dir.angleTo(p));
  return max;
}

function makeRibbon(ids: string[]): Ribbon | null {
  if (ids.length < 2) return null;
  const span = routeSpan(ids);
  const radius = THREE.MathUtils.clamp(span * 0.07, 0.0007, 0.009);
  const clearance = Math.max(0.001, radius * 2.2);
  const traced = traceCities(ids, clearance);
  if (traced.pts.length < 2) return null;
  const tubular = Math.max(1, traced.pts.length - 1);
  const radial = 5;
  const curve = new THREE.CatmullRomCurve3(traced.pts, false, "catmullrom", 0);
  const core = new THREE.TubeGeometry(curve, tubular, radius, radial, false);
  const casing = new THREE.TubeGeometry(curve, tubular, radius * 1.35, radial, false);
  core.setDrawRange(0, 0);
  casing.setDrawRange(0, 0);
  return { core, casing, pts: traced.pts, owner: traced.owner, tubular, radial, radius };
}

function disposeRibbon(ribbon: Ribbon | null) {
  ribbon?.core.dispose();
  ribbon?.casing.dispose();
}

function minutesLabel(hours: number): string {
  const minutes = Math.max(1, Math.round(hours * 60));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem === 0 ? `${h} hr` : `${h} hr ${rem}`;
}

function labelTexture(text: string, strong: boolean): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.clearRect(0, 0, 256, 96);
    ctx.fillStyle = strong ? "#3c3170" : "#2c3036";
    ctx.beginPath();
    ctx.roundRect(6, 14, 244, 68, 30);
    ctx.fill();
    ctx.fillStyle = strong ? "#f4f1ff" : "#d9d6e0";
    ctx.font = "600 40px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 128, 48);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function placeTag(sprite: THREE.Sprite | null, pts: THREE.Vector3[], radius: number, side: number) {
  if (!sprite || pts.length < 2) return;
  const mid = pts[Math.min(pts.length - 1, Math.floor(pts.length * 0.42))];
  scratchTangent.crossVectors(mid, UP);
  if (scratchTangent.lengthSq() < 1e-8) scratchTangent.set(1, 0, 0);
  scratchTangent.normalize().multiplyScalar(radius * 7 * side);
  sprite.position.copy(mid).add(scratchTangent);
  const s = Math.max(radius * 26, 0.012);
  sprite.scale.set(s, s * 0.38, 1);
}

function ride(mesh: THREE.Object3D | null, pts: THREE.Vector3[], t: number, lift: number, pointForward: boolean) {
  if (!mesh || pts.length < 2) return;
  const f = THREE.MathUtils.clamp(t, 0, 0.999) * (pts.length - 1);
  const i = Math.floor(f);
  const next = Math.min(pts.length - 1, i + 1);
  mesh.position.lerpVectors(pts[i], pts[next], f - i);
  const len = mesh.position.length() || 1;
  mesh.position.multiplyScalar((len + lift) / len);
  if (!pointForward) return;
  scratchTangent.copy(pts[next]).sub(pts[i]);
  if (scratchTangent.lengthSq() < 1e-8) return;
  mesh.quaternion.setFromUnitVectors(UP, scratchTangent.normalize());
}

function RouteLayer({ solution }: { solution: RouteSolution }) {
  const reduce = useRef(false);
  const build = useRef(0);
  const drive = useRef(0);
  const puck = useRef<THREE.Mesh>(null);
  const chevrons = useRef<Array<THREE.Mesh | null>>([]);
  const bestTag = useRef<THREE.Sprite>(null);
  const altTag = useRef<THREE.Sprite>(null);
  const [ribbon, setRibbon] = useState<Ribbon | null>(null);
  const [alt, setAlt] = useState<Ribbon | null>(null);
  const pathKey = solution.path.join(">");
  const altIds = solution.altPath.length > 1 && solution.altPath.join(">") !== pathKey ? solution.altPath : [];
  const altKey = altIds.join(">");
  const showAlt = altIds.length > 1;
  const bestMap = useMemo(() => labelTexture(minutesLabel(solution.totalHours), true), [solution.totalHours]);
  const altMap = useMemo(
    () => labelTexture(solution.altHours > 0 ? minutesLabel(solution.altHours) : "", false),
    [solution.altHours],
  );

  useEffect(() => {
    return () => {
      bestMap.dispose();
      altMap.dispose();
    };
  }, [bestMap, altMap]);

  useEffect(() => {
    reduce.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = makeRibbon(solution.path);
    const altNext = showAlt ? makeRibbon(altIds) : null;
    build.current = reduce.current ? 1 : 0;
    drive.current = 0;
    if (reduce.current && next) {
      setRibbonDraw(next.core, 1);
      setRibbonDraw(next.casing, 1);
      if (altNext) {
        setRibbonDraw(altNext.core, 1);
        setRibbonDraw(altNext.casing, 1);
      }
    }
    setRibbon(next);
    setAlt(altNext);
    return () => {
      disposeRibbon(next);
      disposeRibbon(altNext);
    };
  }, [pathKey, altKey, showAlt]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const hops = Math.max(1, solution.path.length - 1);
    const dur = Math.min(2.2, 0.62 + hops * 0.15);
    if (reduce.current) build.current = 1;
    else build.current = Math.min(1, build.current + dt / dur);
    const t = build.current;
    if (ribbon) {
      setRibbonDraw(ribbon.core, t);
      setRibbonDraw(ribbon.casing, t);
    }
    if (alt) {
      setRibbonDraw(alt.core, t);
      setRibbonDraw(alt.casing, t);
    }
    const pts = ribbon?.pts;
    if (!pts) return;
    const flowing = t >= 1 && !reduce.current;
    if (flowing) drive.current = (drive.current + dt * 0.16) % 1;
    const radius = ribbon?.radius ?? 0.001;
    if (puck.current) {
      puck.current.visible = true;
      puck.current.scale.setScalar(radius * 2.6);
      ride(puck.current, pts, flowing ? drive.current : t, radius * 1.1, false);
    }
    chevrons.current.forEach((mesh, index) => {
      if (!mesh) return;
      mesh.visible = flowing;
      if (!flowing) return;
      mesh.scale.setScalar(radius * 2.2);
      ride(mesh, pts, (drive.current + index * 0.2) % 1, radius * 1.3, true);
    });
    placeTag(bestTag.current, pts, radius, 1);
    if (alt) placeTag(altTag.current, alt.pts, alt.radius, -1);
  });

  if (!ribbon) return null;

  return (
    <group>
      {alt ? (
        <group>
          <mesh geometry={alt.casing} renderOrder={1}>
            <meshBasicMaterial color="#3a3d44" side={THREE.BackSide} />
          </mesh>
          <mesh geometry={alt.core} renderOrder={2}>
            <meshBasicMaterial color="#c4c0d2" toneMapped={false} />
          </mesh>
          <sprite ref={altTag} renderOrder={5}>
            <spriteMaterial map={altMap} transparent depthWrite={false} toneMapped={false} />
          </sprite>
        </group>
      ) : null}
      <mesh geometry={ribbon.casing} renderOrder={2}>
        <meshBasicMaterial color="#2a2348" side={THREE.BackSide} />
      </mesh>
      <mesh geometry={ribbon.core} renderOrder={3}>
        <meshBasicMaterial color="#6f5cb8" toneMapped={false} />
      </mesh>
      <sprite ref={bestTag} renderOrder={6}>
        <spriteMaterial map={bestMap} transparent depthWrite={false} toneMapped={false} />
      </sprite>
      <mesh ref={puck} renderOrder={4}>
        <sphereGeometry args={[1, 14, 14]} />
        <meshBasicMaterial color="#f7f4ef" toneMapped={false} />
      </mesh>
      {[0, 1, 2].map((index) => (
        <mesh
          key={index}
          ref={(node) => {
            chevrons.current[index] = node;
          }}
          renderOrder={4}
          visible={false}
        >
          <coneGeometry args={[0.45, 1.15, 4]} />
          <meshBasicMaterial color="#f4f1ff" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

function Marker({
  city,
  selected,
  onPath,
  glow,
}: {
  city: City;
  selected: boolean;
  onPath: boolean;
  glow: THREE.Texture;
}) {
  const group = useRef<THREE.Group>(null);
  const { camera, gl } = useThree();
  const position = useMemo(() => {
    const v = latLonToVec(city.lat, city.lon, 1.012);
    return new THREE.Vector3(v[0], v[1], v[2]);
  }, [city]);

  useFrame(() => {
    const node = group.current;
    if (!node) return;
    const facing = position.dot(camera.position) > 0.12;
    node.visible = facing;
    const height = Math.max(0.02, camera.position.length() - 1);
    node.scale.setScalar(THREE.MathUtils.clamp(height / 0.38, 0.06, 1.35));
  });

  return (
    <group ref={group} position={position}>
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          useMeridian.getState().focus(city.id);
        }}
        onPointerOver={(event) => {
          event.stopPropagation();
          gl.domElement.style.cursor = "pointer";
          useMeridian.getState().setHover(city.id);
        }}
        onPointerOut={() => {
          gl.domElement.style.cursor = "";
          if (useMeridian.getState().hoverId === city.id) useMeridian.getState().setHover(null);
        }}
      >
        <sphereGeometry args={[selected ? 0.01 : onPath ? 0.008 : 0.006, 12, 12]} />
        <meshBasicMaterial color={selected ? "#f7f4ef" : "#e7eef5"} toneMapped={false} />
      </mesh>
      <sprite scale={selected ? 0.07 : onPath ? 0.05 : 0.04} renderOrder={2}>
        <spriteMaterial
          map={glow}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          toneMapped={false}
          opacity={selected ? 0.95 : 0.7}
        />
      </sprite>
      <mesh
        onClick={(event) => {
          event.stopPropagation();
          useMeridian.getState().focus(city.id);
        }}
      >
        <sphereGeometry args={[0.022, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </group>
  );
}

function glowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    const glow = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    glow.addColorStop(0, "rgba(255,255,255,0.95)");
    glow.addColorStop(0.18, "rgba(214,224,234,0.55)");
    glow.addColorStop(0.45, "rgba(180,196,214,0.16)");
    glow.addColorStop(1, "rgba(180,196,214,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function Markers({ solution }: { solution: RouteSolution | null }) {
  const glow = useMemo(() => glowTexture(), []);
  const originId = useMeridian((s) => s.originId);
  const destId = useMeridian((s) => s.destId);
  const focusId = useMeridian((s) => s.focusId);
  const hoverId = useMeridian((s) => s.hoverId);
  const onPath = new Set(solution?.path ?? []);
  return (
    <group>
      {CITIES.filter((city) => city.listed !== false).map((city) => (
        <Marker
          key={city.id}
          city={city}
          glow={glow}
          selected={city.id === originId || city.id === destId || city.id === focusId || city.id === hoverId}
          onPath={onPath.has(city.id)}
        />
      ))}
    </group>
  );
}

function useGlobeLift(): number {
  const [lift, setLift] = useState(() =>
    typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches ? -0.14 : 0,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => setLift(mq.matches ? -0.14 : 0);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return lift;
}

function syncControls(camera: THREE.Camera, controlsNow: OrbitControlsImpl) {
  const savedPos = camera.position.clone();
  const savedTarget = controlsNow.target.clone();
  const damping = controlsNow.dampingFactor;
  controlsNow.autoRotate = false;
  controlsNow.dampingFactor = 1;
  controlsNow.update();
  camera.position.copy(savedPos);
  controlsNow.target.copy(savedTarget);
  controlsNow.dampingFactor = damping;
}

function placeAim(camera: THREE.Camera, controlsNow: OrbitControlsImpl, aim: Aim) {
  scratchOffset.setFromSpherical(new THREE.Spherical(aim.radius, aim.phi, aim.theta));
  camera.position.copy(controlsNow.target).add(scratchOffset);
  camera.lookAt(controlsNow.target);
  controlsNow.update();
}

const EMPTY_PATH: string[] = [];

function Rig({ path }: { path: string[] }) {
  const lift = useGlobeLift();
  const { camera, gl } = useThree();
  const controls = useRef<OrbitControlsImpl | null>(null);
  const flying = useRef<Aim | null>(null);
  const pending = useRef<Aim | null>(null);
  const dragging = useRef(false);
  const reduce = useRef(false);
  const idleUntil = useRef(0);
  const hold = useRef(false);
  const focusNonce = useMeridian((s) => s.focusNonce);
  const focusId = useMeridian((s) => s.focusId);
  const pathKey = path.join(">");

  useLayoutEffect(() => {
    const controlsNow = new OrbitControlsImpl(camera);
    controlsNow.connect(gl.domElement);
    controlsNow.enablePan = false;
    controlsNow.enableDamping = true;
    controlsNow.rotateSpeed = 0.62;
    controlsNow.zoomSpeed = 0.7;
    controlsNow.minDistance = 1.02;
    controlsNow.maxDistance = 3.4;
    controlsNow.minPolarAngle = 0.12;
    controlsNow.maxPolarAngle = Math.PI - 0.12;
    controlsNow.target.set(0, lift, 0);
    controlsNow.dampingFactor = 0.1;
    controlsNow.autoRotateSpeed = 0.22;
    reduce.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    controlsNow.autoRotate = !reduce.current;
    const onStart = () => {
      dragging.current = true;
      flying.current = null;
      pending.current = null;
      syncControls(camera, controlsNow);
      controlsNow.dampingFactor = 0.1;
      hold.current = true;
      useMeridian.getState().setHolding(true);
    };
    const onEnd = () => {
      dragging.current = false;
      idleUntil.current = performance.now() + 2600;
      const aim = pending.current;
      if (!aim) return;
      pending.current = null;
      controlsNow.autoRotate = false;
      flying.current = aim;
    };
    controlsNow.addEventListener("start", onStart);
    controlsNow.addEventListener("end", onEnd);
    controls.current = controlsNow;
    controlsNow.update();
    return () => {
      controlsNow.removeEventListener("start", onStart);
      controlsNow.removeEventListener("end", onEnd);
      controlsNow.dispose();
      controls.current = null;
    };
  }, [camera, gl]);

  useEffect(() => {
    const controlsNow = controls.current;
    if (!controlsNow) return;
    controlsNow.target.y = lift;
    controlsNow.update();
  }, [lift]);

  useEffect(() => {
    const controlsNow = controls.current;
    if (!controlsNow || path.length < 2) return;
    const aim = aimForPath(path, controlsNow.target);
    if (!aim) return;
    if (dragging.current) {
      pending.current = aim;
      return;
    }
    syncControls(camera, controlsNow);
    controlsNow.autoRotate = false;
    if (reduce.current) {
      placeAim(camera, controlsNow, aim);
      return;
    }
    flying.current = aim;
    hold.current = true;
    useMeridian.getState().setHolding(true);
  }, [pathKey, lift, camera, path.length]);

  useEffect(() => {
    const controlsNow = controls.current;
    if (!focusId || !controlsNow) return;
    const aim = aimForPath([focusId], controlsNow.target);
    if (!aim) return;
    aim.radius = Math.min(aim.radius, 1.5);
    if (dragging.current) {
      pending.current = aim;
      return;
    }
    syncControls(camera, controlsNow);
    controlsNow.autoRotate = false;
    if (reduce.current) {
      placeAim(camera, controlsNow, aim);
      return;
    }
    flying.current = aim;
    hold.current = true;
    useMeridian.getState().setHolding(true);
  }, [focusNonce, focusId, camera]);

  useFrame((_, delta) => {
    const controlsNow = controls.current;
    if (!controlsNow) return;
    const aim = flying.current;
    if (aim && !dragging.current) {
      const dt = Math.min(delta, 0.05);
      scratchOffset.copy(camera.position).sub(controlsNow.target);
      scratchSph.setFromVector3(scratchOffset);
      const k = 1 - Math.exp(-dt * 2.8);
      scratchSph.theta += angDiff(scratchSph.theta, aim.theta) * k;
      scratchSph.phi += (aim.phi - scratchSph.phi) * k;
      scratchSph.radius += (aim.radius - scratchSph.radius) * k;
      scratchSph.phi = THREE.MathUtils.clamp(scratchSph.phi, controlsNow.minPolarAngle, controlsNow.maxPolarAngle);
      scratchSph.radius = THREE.MathUtils.clamp(
        scratchSph.radius,
        controlsNow.minDistance,
        controlsNow.maxDistance,
      );
      scratchOffset.setFromSpherical(scratchSph);
      camera.position.copy(controlsNow.target).add(scratchOffset);
      camera.lookAt(controlsNow.target);
      const done =
        Math.abs(angDiff(scratchSph.theta, aim.theta)) < 0.012 &&
        Math.abs(scratchSph.phi - aim.phi) < 0.012 &&
        Math.abs(scratchSph.radius - aim.radius) < 0.02;
      if (done) {
        flying.current = null;
        idleUntil.current = performance.now() + 8000;
        controlsNow.dampingFactor = 0.1;
        controlsNow.update();
      }
      return;
    }
    const playing = useMeridian.getState().playing;
    const allow = !reduce.current && !dragging.current && !playing && performance.now() > idleUntil.current;
    if (controlsNow.autoRotate !== allow) controlsNow.autoRotate = allow;
    if (hold.current === allow) {
      hold.current = !allow;
      useMeridian.getState().setHolding(!allow);
    }
    controlsNow.update();
  });

  return null;
}

export function Scene({ solution, map }: { solution: RouteSolution | null; map: THREE.Texture | null }) {
  return (
    <Canvas
      className="h-full w-full touch-none"
      dpr={[1, 1.75]}
      camera={{ position: latLonToVec(28.96, -82.4, 1.12), fov: 42, near: 0.001, far: 80 }}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      onCreated={({ gl }) => {
        gl.setClearColor(GLOBE);
      }}
    >
      <ambientLight intensity={0.22} color="#c5d0dc" />
      <Sun />
      <Stars />
      <Earth map={map} />
      <Atmosphere />
      <TrafficField />
      {solution ? <RouteLayer solution={solution} /> : null}
      <Markers solution={solution} />
      <Rig path={solution?.path ?? EMPTY_PATH} />
      <ClockDriver />
    </Canvas>
  );
}
