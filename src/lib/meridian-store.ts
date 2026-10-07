import { create } from "zustand";

type MeridianState = {
  hour: number;
  playing: boolean;
  originId: string;
  destId: string;
  focusId: string | null;
  focusNonce: number;
  hoverId: string | null;
  holding: boolean;
  setHour: (hour: number) => void;
  scrubHour: (hour: number) => void;
  setPlaying: (playing: boolean) => void;
  setOrigin: (id: string) => void;
  setDest: (id: string) => void;
  focus: (id: string) => void;
  setHover: (id: string | null) => void;
  setHolding: (holding: boolean) => void;
};

export const useMeridian = create<MeridianState>((set) => ({
  hour: 12.75,
  playing: false,
  originId: "app",
  destId: "osw",
  focusId: null,
  focusNonce: 0,
  hoverId: null,
  holding: false,
  setHour: (hour) => set({ hour: ((hour % 24) + 24) % 24 }),
  scrubHour: (hour) => set({ hour: ((hour % 24) + 24) % 24, playing: false }),
  setPlaying: (playing) => set({ playing }),
  setOrigin: (originId) =>
    set((s) => (originId === s.destId ? { originId, destId: s.originId } : { originId })),
  setDest: (destId) =>
    set((s) => (destId === s.originId ? { destId, originId: s.destId } : { destId })),
  focus: (focusId) => set((s) => ({ focusId, focusNonce: s.focusNonce + 1 })),
  setHover: (hoverId) => set({ hoverId }),
  setHolding: (holding) => set({ holding }),
}));
