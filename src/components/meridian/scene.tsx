import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls as OrbitControlsImpl } from "three-stdlib";
import { arcPoints, latLonToVec } from "@/lib/ppm/geo";
import { CITIES, CORRIDORS, cityAt, type City } from "@/lib/ppm/network";
import { edgeHours } from "@/lib/ppm/solution-engine";
import type { RouteSolution } from "@/lib/ppm/solution-engine";
import { useMeridian } from "@/lib/meridian-store";

const CLEAR = new THREE.Color("#9aabbc");
const HEAVY = new THREE.Color("#c4928c");
const GLOBE = new THREE.Color("#07080a");

function angDiff(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

function mixCongestion(amount: number): THREE.Color {
  return CLEAR.clone().lerp(HEAVY, THREE.MathUtils.clamp(amount, 0, 1));
}

function ClockDriver() {
  const acc = useRef(0);
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.1);
    if (!useMeridian.getState().playing) return;
    acc.current += dt;
    if (acc.current < 0.08) return;
    const step = acc.current;
    acc.current = 0;
    const { hour, setHour } = useMeridian.getState();
    setHour(hour + step * 0.9);
  });
  return null;
}

function Sun() {
  const hour = useMeridian((s) => s.hour);
  const pos = latLonToVec(10, (12 - hour) * 15, 8);
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
    const scratch = new THREE.Color();
    for (const range of ranges) {
      const edge = CORRIDORS.find((e) => e.from === range.from && e.to === range.to);
      if (!edge) continue;
      const timed = edgeHours({ ...edge, fromId: edge.from, toId: edge.to }, hour);
      scratch.copy(CLEAR).lerp(HEAVY, timed.congestion);
      for (let i = 0; i < range.count; i++) {
        attr.setXYZ(range.start + i, scratch.r, scratch.g, scratch.b);
      }
    }
    attr.needsUpdate = true;
  }, [geometry, hour]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial vertexColors transparent opacity={0.38} depthWrite={false} />
    </lineSegments>
  );
}

function RouteArc({ solution }: { solution: RouteSolution }) {
  const reduce = useRef(false);
  useEffect(() => {
    reduce.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  const legs = useMemo(() => {
    return solution.legs.map((leg) => {
      const a = cityAt(leg.from);
      const b = cityAt(leg.to);
      const pts = arcPoints(latLonToVec(a.lat, a.lon), latLonToVec(b.lat, b.lon), 48).map(
        (p) => new THREE.Vector3(p[0], p[1], p[2]),
      );
      const curve = new THREE.CatmullRomCurve3(pts);
      const geometry = new THREE.TubeGeometry(curve, 64, 0.0075, 8, false);
      return { geometry, color: mixCongestion(leg.congestion), pts };
    });
  }, [solution]);

  useEffect(() => {
    return () => {
      for (const leg of legs) leg.geometry.dispose();
    };
  }, [legs]);

  const all = useMemo(() => legs.flatMap((leg) => leg.pts), [legs]);
  const pulse = useRef<THREE.Mesh>(null);
  const phase = useRef(0);

  useFrame((_, delta) => {
    const mesh = pulse.current;
    if (!mesh || all.length < 2) return;
    if (reduce.current) {
      mesh.position.copy(all[0]);
      return;
    }
    const dt = Math.min(delta, 0.1);
    phase.current = (phase.current + dt * 0.18) % 1;
    const f = phase.current * (all.length - 1);
    const i = Math.floor(f);
    const k = f - i;
    mesh.position.lerpVectors(all[i], all[Math.min(all.length - 1, i + 1)], k);
  });

  if (legs.length === 0) return null;

  return (
    <group>
      {legs.map((leg, i) => (
        <mesh key={i} geometry={leg.geometry}>
          <meshBasicMaterial color={leg.color} toneMapped={false} transparent opacity={0.95} />
        </mesh>
      ))}
      <mesh ref={pulse}>
        <sphereGeometry args={[0.014, 14, 14]} />
        <meshBasicMaterial color="#f7f4ef" toneMapped={false} />
      </mesh>
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
        <sphereGeometry args={[selected ? 0.022 : onPath ? 0.016 : 0.012, 16, 16]} />
        <meshBasicMaterial color={selected ? "#f7f4ef" : "#e7eef5"} toneMapped={false} />
      </mesh>
      <sprite scale={selected ? 0.22 : onPath ? 0.14 : 0.1} renderOrder={2}>
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
        <sphereGeometry args={[0.055, 10, 10]} />
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
      {CITIES.map((city) => (
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
    typeof window !== "undefined" && window.matchMedia("(max-width: 767px)").matches ? -0.36 : 0,
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const apply = () => setLift(mq.matches ? -0.36 : 0);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  return lift;
}

function Rig() {
  const lift = useGlobeLift();
  const { camera, gl } = useThree();
  const controls = useRef<OrbitControlsImpl | null>(null);
  const flying = useRef<{ phi: number; theta: number } | null>(null);
  const dragging = useRef(false);
  const reduce = useRef(false);
  const idleUntil = useRef(0);
  const hold = useRef(false);
  const focusNonce = useMeridian((s) => s.focusNonce);
  const focusId = useMeridian((s) => s.focusId);

  useLayoutEffect(() => {
    const controlsNow = new OrbitControlsImpl(camera);
    controlsNow.connect(gl.domElement);
    controlsNow.enablePan = false;
    controlsNow.enableDamping = true;
    controlsNow.rotateSpeed = 0.62;
    controlsNow.zoomSpeed = 0.7;
    controlsNow.minDistance = 1.4;
    controlsNow.maxDistance = 4.8;
    controlsNow.minPolarAngle = 0.12;
    controlsNow.maxPolarAngle = Math.PI - 0.12;
    controlsNow.target.set(0, lift, 0);
    controlsNow.dampingFactor = 0.1;
    controlsNow.autoRotateSpeed = 0.55;
    reduce.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    controlsNow.autoRotate = !reduce.current;
    const onStart = () => {
      dragging.current = true;
      flying.current = null;
      controlsNow.dampingFactor = 0.1;
      hold.current = true;
      useMeridian.getState().setHolding(true);
    };
    const onEnd = () => {
      dragging.current = false;
      idleUntil.current = performance.now() + 2600;
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
    if (!focusId || !controlsNow) return;
    const city = cityAt(focusId);
    const v = latLonToVec(city.lat, city.lon, 1);
    const phi = Math.acos(Math.max(-1, Math.min(1, v[1])));
    const theta = Math.atan2(v[0], v[2]);
    flying.current = { phi, theta };
    controlsNow.autoRotate = false;
    controlsNow.dampingFactor = reduce.current ? 1 : 0.05;
    controlsNow.setAzimuthalAngle(theta);
    controlsNow.setPolarAngle(phi);
    useMeridian.getState().setHolding(true);
    hold.current = true;
  }, [focusNonce, focusId]);

  useFrame(() => {
    const controlsNow = controls.current;
    if (!controlsNow) return;
    if (flying.current) {
      const dTheta = Math.abs(angDiff(controlsNow.getAzimuthalAngle(), flying.current.theta));
      const dPhi = Math.abs(flying.current.phi - controlsNow.getPolarAngle());
      if (dTheta < 0.02 && dPhi < 0.02) {
        flying.current = null;
        controlsNow.dampingFactor = 0.1;
        idleUntil.current = performance.now() + 2400;
      }
    } else {
      const allow = !reduce.current && !dragging.current && performance.now() > idleUntil.current;
      if (controlsNow.autoRotate !== allow) controlsNow.autoRotate = allow;
      if (hold.current === allow) {
        hold.current = !allow;
        useMeridian.getState().setHolding(!allow);
      }
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
      camera={{ position: latLonToVec(18, 42, 2.58), fov: 40, near: 0.1, far: 80 }}
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
      {solution ? <RouteArc key={`${solution.path.join(">")}:${solution.hour}`} solution={solution} /> : null}
      <Markers solution={solution} />
      <Rig />
      <ClockDriver />
    </Canvas>
  );
}
