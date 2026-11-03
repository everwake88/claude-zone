'use client';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { locate, type Segment } from '@/lib/scribe/transcript';
import type { Recording } from './types';

// What the parts of the visit share: the transcript, the segment in focus (an evidence chip was
// opened, so its words light up in the transcript), and "play that moment".
interface Ctx {
  segments: Segment[];
  focus: string[];
  setFocus: (ids: string[]) => void;
  playing: string | null;
  play: (segId: string) => Promise<void>;
  canPlay: boolean;
}
const VisitCtx = createContext<Ctx>({ segments: [], focus: [], setFocus: () => {}, playing: null, play: async () => {}, canPlay: false });
export const useVisit = () => useContext(VisitCtx);

export function VisitProvider({ recording, segments, children }: { recording: Recording | null; segments: Segment[]; children: ReactNode }) {
  const [focus, setFocus] = useState<string[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const stopAt = useRef<ReturnType<typeof setTimeout> | null>(null);
  const canPlay = !!recording && !recording.audio_deleted_at && recording.chunks.some(c => c.path);

  const play = useCallback(async (segId: string) => {
    audio.current?.pause();
    if (stopAt.current) clearTimeout(stopAt.current);
    if (playing === segId) { setPlaying(null); return; }
    const seg = segments.find(s => s.id === segId);
    if (!recording || !seg) return;
    const at = locate(recording.chunks, seg.start);
    if (!at) return;
    setPlaying(segId);
    try {
      const r = await fetch(`/api/scribe/audio?recording_id=${recording.id}&seq=${at.seq}`);
      const j = await r.json();
      if (!r.ok || !j.url) throw new Error(j.error || 'no audio');
      const a = new Audio(j.url);
      a.preload = 'auto';
      audio.current = a;
      await new Promise<void>((res, rej) => { a.onloadedmetadata = () => res(); a.onerror = () => rej(new Error('audio')); });
      // a recorded piece may not know its length until it is read through
      if (!Number.isFinite(a.duration)) { a.currentTime = 1e6; await new Promise(r2 => { a.ontimeupdate = () => { a.ontimeupdate = null; r2(null); }; }); }
      a.currentTime = Math.max(0, at.offset - 0.3);
      await a.play();
      stopAt.current = setTimeout(() => { a.pause(); setPlaying(p => (p === segId ? null : p)); }, Math.max(1.5, seg.end - seg.start + 0.9) * 1000);
      a.onended = () => setPlaying(p => (p === segId ? null : p));
    } catch {
      setPlaying(null);
    }
  }, [recording, segments, playing]);

  return <VisitCtx.Provider value={{ segments, focus, setFocus, playing, play, canPlay }}>{children}</VisitCtx.Provider>;
}
