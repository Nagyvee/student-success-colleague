'use client';

import { useCallback, useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

/* What makes the lesson read as video rather than slides.
 *
 *  Backdrop    a living frame: a slow colour field, soft lights drifting in depth,
 *              film grain and a vignette; the academy's own footage behind the
 *              greeting and the big moments, graded into the brand and slowly zooming
 *  Camera      every scene breathes: a slow push in, pull out or pan, never still
 *  LightLeak   a warm sweep of light across the cut into the big moments
 *  useScore    a soft music bed under the voice (the academy's own track, or a
 *              generated pad) and a light whoosh on every cut */

export interface SceneFootage { url: string; kind: 'video' | 'photo' }

/* ── Backdrop ─────────────────────────────────────────────────────────────── */

export function Backdrop({ footage, index, playing, light = false }: { footage: SceneFootage | null; index: number; playing: boolean; light?: boolean }) {
  return (
    <div className={`cin-bg${playing ? '' : ' is-paused'}`} aria-hidden="true">
      <div className="cin-mesh" />
      <div className="cin-lights">{Array.from({ length: 9 }, (_, k) => <i key={k} />)}</div>
      <AnimatePresence>
        {footage && (
          <motion.div
            key={`${footage.url}-${index}`}
            className={`cin-footage kb-${index % 4}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.9, ease: [0.4, 0, 0.2, 1] }}
          >
            {footage.kind === 'video'
              ? <FootageVideo src={footage.url} playing={playing} />
              : <img src={footage.url} alt="" />}
          </motion.div>
        )}
      </AnimatePresence>
      {/* The grade: footage sits in the brand's colours, the scene stays readable on top. */}
      <div className={`cin-grade${footage ? ' is-on' : ''}${light ? ' is-light' : ''}`} />
      <div className="cin-grain" />
      <div className="cin-vignette" />
    </div>
  );
}

function FootageVideo({ src, playing }: { src: string; playing: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (playing) void v.play().catch(() => { /* muted autoplay may still be refused: the still frame stays */ });
    else v.pause();
  }, [playing]);
  return <video ref={ref} src={src} muted loop playsInline autoPlay preload="auto" />;
}

/* ── Camera ───────────────────────────────────────────────────────────────── */

const MOVES = ['push', 'pan-l', 'pull', 'pan-r'] as const;

/** A slow, continuous move over the scene's whole length (CSS, so it never stutters). */
export function Camera({ index, durMs, paused, children }: { index: number; durMs: number; paused: boolean; children: React.ReactNode }) {
  return (
    <div className={`cin-cam cam-${MOVES[index % MOVES.length]}`} style={{ ['--cam-dur' as string]: `${Math.max(3000, durMs + 800)}ms`, animationPlayState: paused ? 'paused' : 'running' }}>
      {children}
    </div>
  );
}

/* ── Transitions ──────────────────────────────────────────────────────────── */

export type CutKind = 'push' | 'focus' | 'zoom' | 'dip';

/** One primary cut (push) for related points; focus pull to open, zoom through into the big
 *  moments, a dip for the ending. Outgoing and incoming move together: the cut is the exit. */
export function cutFor(index: number, total: number, visual: string | undefined): CutKind {
  if (index <= 1) return 'focus';
  if (visual === 'cta') return 'dip';
  if (visual === 'recap' || visual === 'big') return 'zoom';
  return 'push';
}

const EASE_IN: [number, number, number, number] = [0.55, 0, 1, 0.45];
const EASE_OUT: [number, number, number, number] = [0.16, 1, 0.3, 1];

export const cutVariants = {
  enter: (k: CutKind) => (
    k === 'push' ? { opacity: 0, y: '9%', filter: 'blur(12px)' }
      : k === 'zoom' ? { opacity: 0, scale: 0.86, filter: 'blur(10px)' }
        : k === 'dip' ? { opacity: 0, scale: 1.04, filter: 'blur(4px)' }
          : { opacity: 0, scale: 1.02, filter: 'blur(22px)' }
  ),
  center: (k: CutKind) => ({
    opacity: 1, y: '0%', scale: 1, filter: 'blur(0px)',
    transition: { duration: k === 'focus' ? 0.95 : k === 'dip' ? 0.8 : 0.7, ease: EASE_OUT, delay: k === 'dip' ? 0.25 : 0.05 },
  }),
  exit: (k: CutKind) => (
    k === 'push' ? { opacity: 0, y: '-9%', filter: 'blur(12px)', transition: { duration: 0.42, ease: EASE_IN } }
      : k === 'zoom' ? { opacity: 0, scale: 1.18, filter: 'blur(14px)', transition: { duration: 0.45, ease: EASE_IN } }
        : k === 'dip' ? { opacity: 0, filter: 'blur(6px) brightness(0.3)', transition: { duration: 0.45, ease: EASE_IN } }
          : { opacity: 0, filter: 'blur(22px)', transition: { duration: 0.6, ease: [0.45, 0, 0.55, 1] as [number, number, number, number] } }
  ),
};

/** A warm leak of light that sweeps across the cut (into the recap and the ending). */
export function LightLeak({ show }: { show: boolean }) {
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          className="cin-leak"
          aria-hidden="true"
          initial={{ opacity: 0, x: '-35%' }}
          animate={{ opacity: [0, 0.9, 0], x: ['-35%', '10%', '45%'] }}
          exit={{ opacity: 0 }}
          transition={{ duration: 1.4, ease: 'easeInOut', times: [0, 0.4, 1] }}
        />
      )}
    </AnimatePresence>
  );
}

/* ── Sound: a music bed and a whoosh on cuts ──────────────────────────────── */

type Score = { ctx: AudioContext; master: GainNode; timer: ReturnType<typeof setInterval> | null; next: number; step: number; noise: AudioBuffer | null };

/** MIDI note → Hz */
const hz = (n: number) => 440 * 2 ** ((n - 69) / 12);

/* A light, hopeful bed in C major (C, G, Am, F), 100 beats a minute: a soft pad, a gentle
 * plucked arpeggio, a round bass note on each bar and a quiet shaker on the off-beats.
 * Mixed well under the voice: it should feel like a good morning, not a film score. */
const BPM = 100;
const STEP = 60 / BPM / 2; // one eighth note
const STEPS_PER_CHORD = 16; // two bars per chord
const PROGRESSION = [
  { bass: 36, pad: [55, 60, 64], arp: [60, 64, 67, 72] }, // C
  { bass: 43, pad: [55, 59, 62], arp: [59, 62, 67, 71] }, // G
  { bass: 45, pad: [57, 60, 64], arp: [60, 64, 69, 72] }, // Am
  { bass: 41, pad: [57, 60, 65], arp: [60, 65, 69, 72] }, // F
];
const ARP = [0, 1, 2, 3, 2, 1, 2, 3];
const MUSIC_LEVEL = 0.16; // the whole bed (was 0.32 with louder voices: about a quarter as loud now)
const TRACK_LEVEL = 0.07; // an uploaded track, under the voice

export function useScore({ enabled, playing, track }: { enabled: boolean; playing: boolean; track?: string | null }) {
  const score = useRef<Score | null>(null);
  const trackEl = useRef<HTMLAudioElement | null>(null);

  const ensure = useCallback((): Score | null => {
    if (score.current) return score.current;
    const AC = (typeof window !== 'undefined' && (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)) || null;
    if (!AC) return null;
    const ctx = new AC();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    score.current = { ctx, master, timer: null, next: 0, step: 0, noise: null };
    return score.current;
  }, []);

  /** A soft plucked note (a quick attack that rings out), like a muted marimba. */
  const pluck = (s: Score, note: number, at: number, level: number) => {
    const f = s.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 2600;
    const g = s.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level, at + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
    for (const [type, mult, amt] of [['triangle', 1, 1], ['sine', 2, 0.25]] as const) {
      const o = s.ctx.createOscillator();
      o.type = type;
      o.frequency.value = hz(note) * mult;
      const og = s.ctx.createGain();
      og.gain.value = amt;
      o.connect(og).connect(g);
      o.start(at);
      o.stop(at + 0.6);
    }
    g.connect(f).connect(s.master);
  };

  /** The pad: the chord held softly for two bars, swelling in and out. */
  const pad = (s: Score, notes: number[], at: number, len: number) => {
    const f = s.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1500;
    f.connect(s.master);
    for (const n of notes) for (const detune of [-5, 5]) {
      const o = s.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = hz(n);
      o.detune.value = detune;
      const g = s.ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.022, at + 0.6);
      g.gain.setValueAtTime(0.022, at + len - 0.3);
      g.gain.linearRampToValueAtTime(0, at + len + 0.4);
      o.connect(g).connect(f);
      o.start(at);
      o.stop(at + len + 0.5);
    }
  };

  /** A round bass note at the start of a bar. */
  const bass = (s: Score, note: number, at: number) => {
    const o = s.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = hz(note);
    const g = s.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.07, at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 1.1);
    o.connect(g).connect(s.master);
    o.start(at);
    o.stop(at + 1.2);
  };

  /** A very quiet shaker on the off-beat (high noise, a few milliseconds long). */
  const shaker = (s: Score, at: number) => {
    if (!s.noise) {
      const len = Math.floor(s.ctx.sampleRate * 0.08);
      s.noise = s.ctx.createBuffer(1, len, s.ctx.sampleRate);
      const d = s.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = s.ctx.createBufferSource();
    src.buffer = s.noise;
    const hp = s.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = s.ctx.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.03, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.07);
    src.connect(hp).connect(g).connect(s.master);
    src.start(at);
    src.stop(at + 0.08);
  };

  /** Schedules the next half-second of music (called every 100 ms while playing). */
  const tick = useCallback((s: Score) => {
    while (s.next < s.ctx.currentTime + 0.5) {
      const c = PROGRESSION[Math.floor(s.step / STEPS_PER_CHORD) % PROGRESSION.length];
      const i = s.step % STEPS_PER_CHORD;
      if (i === 0) pad(s, c.pad, s.next, STEP * STEPS_PER_CHORD);
      if (i % 8 === 0) bass(s, c.bass, s.next);
      if (i % 8 !== 7) pluck(s, c.arp[ARP[i % 8]], s.next, i % 4 === 0 ? 0.075 : 0.05);
      if (i % 2 === 1) shaker(s, s.next);
      s.next += STEP;
      s.step++;
    }
  }, []);

  useEffect(() => {
    const on = enabled && playing;
    // The academy's own track: a plain looping audio element, kept low under the voice.
    if (track) {
      if (!trackEl.current) {
        const a = new Audio(track);
        a.loop = true;
        a.volume = 0;
        trackEl.current = a;
      }
      const a = trackEl.current;
      if (on) {
        void a.play().catch(() => { /* needs a tap first */ });
        const t0 = performance.now();
        const fade = setInterval(() => { a.volume = Math.min(TRACK_LEVEL, ((performance.now() - t0) / 1500) * TRACK_LEVEL); if (a.volume >= TRACK_LEVEL) clearInterval(fade); }, 60);
        return () => clearInterval(fade);
      }
      a.pause();
      return;
    }
    const s = on ? ensure() : score.current;
    if (!s) return;
    if (on) {
      void s.ctx.resume();
      s.master.gain.cancelScheduledValues(s.ctx.currentTime);
      s.master.gain.setTargetAtTime(MUSIC_LEVEL, s.ctx.currentTime, 1.2);
      if (!s.timer) {
        s.next = s.ctx.currentTime + 0.05;
        tick(s);
        s.timer = setInterval(() => tick(s), 100);
      }
    } else {
      s.master.gain.setTargetAtTime(0, s.ctx.currentTime, 0.25);
      if (s.timer) { clearInterval(s.timer); s.timer = null; }
    }
  }, [enabled, playing, track, ensure, tick]);

  // Close everything when the player goes away.
  useEffect(() => () => {
    const s = score.current;
    if (s) { if (s.timer) clearInterval(s.timer); void s.ctx.close().catch(() => {}); score.current = null; }
    trackEl.current?.pause();
  }, []);

  /** A soft air whoosh: filtered noise swept upward, for a cut. */
  const whoosh = useCallback(() => {
    if (!enabled) return;
    const s = ensure();
    if (!s) return;
    if (s.ctx.state === 'suspended') void s.ctx.resume();
    const len = Math.floor(s.ctx.sampleRate * 0.7);
    const buf = s.ctx.createBuffer(1, len, s.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    const src = s.ctx.createBufferSource();
    src.buffer = buf;
    const bp = s.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    const t = s.ctx.currentTime;
    bp.frequency.setValueAtTime(350, t);
    bp.frequency.exponentialRampToValueAtTime(2600, t + 0.55);
    const g = s.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.045, t + 0.22);
    g.gain.linearRampToValueAtTime(0, t + 0.65);
    src.connect(bp).connect(g).connect(s.ctx.destination);
    src.start(t);
    src.stop(t + 0.7);
  }, [enabled, ensure]);

  return { whoosh };
}
