import { create } from "zustand";

export type MapPoint = { lat: number; lon: number };

type MeridianState = {
  hour: number;
  playing: boolean;
  originId: string;
  destId: string;
  /** When set, this map point is the start instead of originId. */
  originPoint: MapPoint | null;
  /** When set, this map point is the end instead of destId. */
  destPoint: MapPoint | null;
  /** Which end the next tap on the globe sets. */
  arm: "origin" | "dest";
  focusId: string | null;
  focusNonce: number;
  hoverId: string | null;
  holding: boolean;
  setHour: (hour: number) => void;
  scrubHour: (hour: number) => void;
  setPlaying: (playing: boolean) => void;
  setOrigin: (id: string) => void;
  setDest: (id: string) => void;
  setArm: (arm: "origin" | "dest") => void;
  dropOnMap: (lat: number, lon: number) => void;
  focus: (id: string) => void;
  setHover: (id: string | null) => void;
  setHolding: (holding: boolean) => void;
};

export const useMeridian = create<MeridianState>((set) => ({
  hour: 12.75,
  playing: false,
  originId: "app",
  destId: "osw",
  originPoint: null,
  destPoint: null,
  arm: "dest",
  focusId: null,
  focusNonce: 0,
  hoverId: null,
  holding: false,
  setHour: (hour) => set({ hour: ((hour % 24) + 24) % 24 }),
  scrubHour: (hour) => set({ hour: ((hour % 24) + 24) % 24, playing: false }),
  setPlaying: (playing) => set({ playing }),
  setOrigin: (originId) =>
    set((s) => {
      if (originId === "__pin") return s;
      if (originId === s.destId && !s.destPoint && !s.originPoint) {
        return { originId, destId: s.originId, originPoint: null };
      }
      return { originId, originPoint: null };
    }),
  setDest: (destId) =>
    set((s) => {
      if (destId === "__pin") return s;
      if (destId === s.originId && !s.originPoint && !s.destPoint) {
        return { destId, originId: s.destId, destPoint: null };
      }
      return { destId, destPoint: null };
    }),
  setArm: (arm) => set({ arm }),
  dropOnMap: (lat, lon) =>
    set((s) => (s.arm === "origin" ? { originPoint: { lat, lon } } : { destPoint: { lat, lon } })),
  focus: (focusId) => set((s) => ({ focusId, focusNonce: s.focusNonce + 1 })),
  setHover: (hoverId) => set({ hoverId }),
  setHolding: (holding) => set({ holding }),
}));