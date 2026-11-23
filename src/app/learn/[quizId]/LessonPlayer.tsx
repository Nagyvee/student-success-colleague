'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowRight, Captions, CaptionsOff, Check, Maximize2, Minimize2, Music, Pause, Play,
  RotateCcw, SkipBack, SkipForward, Volume2, VolumeX,
} from 'lucide-react';
import type { Lesson, LessonSlide } from '@/lib/types';
import Scene from './scenes';
import { Backdrop, Camera, LightLeak, cutFor, cutVariants, useScore, type SceneFootage } from './cinema';
import './cinema.css';
import '../../lesson.css';
import './scenes.css';

/* The personal video lesson.
 *
 * Lindiwe wrote eight slides and their narration for this one learner. The
 * player stages each slide as a scene (greeting, concept, steps, code,
 * compare, analogy, recap, call to action), a natural voice reads the
 * narration (server text-to-speech when configured, the browser's voice
 * otherwise, captions always), and it ends in the learner's test. */

interface View {
  learner: { name: string };
  module: { code: string; title: string };
  topic: string;
  passMark: number;
  questions: unknown[];
  lesson: Lesson | null;
  academyName?: string;
  evidence?: { scorePct: number | null; missedTopics: string[] } | null;
  /** The academy's colours: navy base, a deep second colour, one accent. */
  brand?: { base: string; deep: string; accent: string };
  /** The academy's logo (shown in white on the dark player). */
  logo?: string | null;
  /* A lead's programme video (not a lesson before a test): */
  /** What the presenter noticed about them (their programme, quiz result, where they came from). */
  noticed?: string[];
  presenter?: { label: string };
  /** Where the video ends: the career-fit quiz or the application. */
  cta?: { href: string; label: string };
  skip?: { href: string; label: string };
  ctaTiles?: [string, string][];
  ctaKicker?: string;
  /** The academy's footage for each scene (null: the animated backdrop). */
  footage?: (SceneFootage | null)[];
  /** The academy's own music track (else a soft generated bed). */
  music?: string | null;
  /** Changes when the script changes: a different programme or a rebuilt video never replays a cached voice. */
  audioVersion?: string;
  /** The natural voice is ready (known with the video, so pressing play at once still uses it). */
  voice?: boolean;
}

type Phase = 'title' | 'playing' | 'paused' | 'done';
type Voice = 'server' | 'browser' | 'silent';

const estimateMs = (t: string) => Math.max(4200, t.split(/\s+/).filter(Boolean).length * 400 + 900);
const fmt = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** Captions in readable chunks: a sentence or two, never a wall of text. */
function chunk(say: string): string[] {
  // Split only where a sentence really ends (punctuation then a space), so "Promise.all" or "3.5" stay whole.
  const sentences = say.split(/(?<=[.!?]["')]?)\s+/).map((x) => x.trim()).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (cur && (cur + ' ' + s).length > 120) { out.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

/** A tenth of a second of silence: played inside the tap, so a phone lets the voice start when it arrives. */
function silence(): string {
  const n = 800;
  const b = new Uint8Array(44 + n).fill(128);
  const v = new DataView(b.buffer);
  const word = (at: number, t: string) => { for (let k = 0; k < 4; k++) b[at + k] = t.charCodeAt(k); };
  word(0, 'RIFF'); v.setUint32(4, 36 + n, true); word(8, 'WAVE'); word(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  word(36, 'data'); v.setUint32(40, n, true);
  return URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}

/** The best voice the device has: natural/neural voices first, South African English
 *  preferred, the robotic Windows desktop voices last. Used only without a server voice. */
function rankVoice(v: SpeechSynthesisVoice): number {
  const name = v.name.toLowerCase();
  let score = 0;
  if (!/^en/i.test(v.lang)) return -1000;
  if (/natural|neural/.test(name)) score += 60;
  if (/online/.test(name)) score += 20;
  if (/google/.test(name)) score += 35;
  if (/siri|premium|enhanced/.test(name)) score += 30;
  if (/en-za/i.test(v.lang)) score += 18;
  else if (/en-gb/i.test(v.lang)) score += 10;
  else if (/en-us/i.test(v.lang)) score += 8;
  if (/leah|libby|sonia|aria|jenny|ava|emma|natasha|samantha|karen|female/.test(name)) score += 4;
  if (/desktop|david|zira|mark|hazel|george|susan|microsoft (david|zira|mark)/.test(name) && !/natural|online/.test(name)) score -= 50;
  return score;
}

export default function LessonPlayer({ quizId, lead }: { quizId: string; lead?: string }) {
  // A lead's programme video reads from the nurture API with their signed token; a lesson reads by quiz id.
  const enc = encodeURIComponent;
  const dataUrl = lead ? `/api/nurture/public?watch=1&t=${enc(lead)}` : `/api/quiz/${enc(quizId)}`;
  const reduced = useReducedMotion();
  const [view, setView] = useState<View | null>(null);
  const audioUrl = (n: number | 'probe') => (lead
    ? `/api/nurture/public?audio=${n}&t=${enc(lead)}${view?.audioVersion ? `&v=${enc(view.audioVersion)}` : ''}`
    : n === 'probe' ? `/api/lesson/${enc(quizId)}/audio?probe=1` : `/api/lesson/${enc(quizId)}/audio?slide=${n}`);
  const [err, setErr] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>('title');
  const [i, setI] = useState(0);
  const [progress, setProgress] = useState(0);
  const [voice, setVoice] = useState<Voice>('browser');
  // The voice in use now: scenes that follow use it, even if it was not known yet when play was pressed.
  const voiceRef = useRef<Voice>('browser');
  voiceRef.current = voice;
  // Nothing could be heard on this scene (captions show, and a tap tries again).
  const [unheard, setUnheard] = useState(false);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  mutedRef.current = muted;
  // Captions: off when a real voice narrates (it is a video, not a reading), on when muted or silent.
  const [ccChoice, setCc] = useState<boolean | null>(null);
  const [full, setFull] = useState(false);
  // The music bed under the voice: on unless the viewer turned it off before.
  const [musicOn, setMusicOn] = useState(true);
  useEffect(() => { try { if (localStorage.getItem('thuso-music') === 'off') setMusicOn(false); } catch { /* private mode */ } }, []);
  const toggleMusic = () => setMusicOn((m) => { try { localStorage.setItem('thuso-music', m ? 'off' : 'on'); } catch { /* ignore */ } return !m; });
  const [leakAt, setLeakAt] = useState(-1);
  const [pseudoFull, setPseudoFull] = useState(false);

  const playerRef = useRef<HTMLDivElement | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Each scene's voice, downloaded whole and played from memory: phones differ in how they stream sound.
  const clips = useRef(new Map<string, { url: string | null; job: Promise<string | null> }>());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clock = useRef({ start: 0, pausedAt: 0, pausedTotal: 0, dur: 5000, mode: 'timer' as 'audio' | 'speech' | 'timer', loading: false });
  const runId = useRef(0);
  const speechVoice = useRef<SpeechSynthesisVoice | null>(null);

  const slides = useMemo(() => view?.lesson?.slides || [], [view]);
  const slide: LessonSlide | undefined = slides[i];
  const first = view?.learner.name.split(' ')[0] || '';
  const n = view?.lesson?.questionCount || view?.questions.length || 10;
  const pass = view?.passMark ?? view?.lesson?.passMark ?? 70;
  const tutor = view?.lesson?.tutorName || 'Your tutor';
  const academy = view?.lesson?.academyName || view?.academyName || '';
  const totalMs = useMemo(() => slides.reduce((t, s) => t + estimateMs(s.say), 0), [slides]);
  const minutes = Math.max(2, Math.round(totalMs / 60000));

  // Every photo of the video starts loading at once, so a scene never appears before its photo.
  useEffect(() => {
    for (const f of view?.footage || []) if (f?.kind === 'photo') { const img = new Image(); img.src = f.url; }
  }, [view?.footage]);

  /* ── load the lesson and pick the voice ─────────────────────────────── */
  useEffect(() => {
    fetch(dataUrl, { cache: 'no-store' })
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Not found'); setView(d as View); if ((d as View).voice) setVoice('server'); })
      .catch((e) => setErr((e as Error).message));
    fetch(audioUrl('probe'), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d?.available) setVoice('server'); })
      .catch(() => { /* browser voice */ });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quizId, lead]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('speechSynthesis' in window)) { setVoice((v) => (v === 'server' ? v : 'silent')); return; }
    const pick = () => {
      const vs = window.speechSynthesis.getVoices().filter((v) => rankVoice(v) > -1000);
      speechVoice.current = vs.sort((a, b) => rankVoice(b) - rankVoice(a))[0] || null;
    };
    pick();
    window.speechSynthesis.onvoiceschanged = pick;
    return () => { window.speechSynthesis.cancel(); };
  }, []);

  /** The voice of one scene as a local address (null: it could not be had; asked for again next time). */
  const clip = (k: number) => {
    const src = audioUrl(k);
    const have = clips.current.get(src);
    if (have) return have;
    const entry: { url: string | null; job: Promise<string | null> } = { url: null, job: Promise.resolve(null) };
    entry.job = fetch(src)
      .then(async (r) => {
        if (!r.ok) throw new Error(String(r.status));
        entry.url = URL.createObjectURL(await r.blob());
        return entry.url;
      })
      .catch(() => { clips.current.delete(src); return null; });
    clips.current.set(src, entry);
    return entry;
  };
  // Their greeting is ready before they press play.
  useEffect(() => {
    if (voice === 'server' && slides.length) clip(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice, slides]);
  useEffect(() => {
    const all = clips.current;
    return () => { for (const c of all.values()) if (c.url) URL.revokeObjectURL(c.url); all.clear(); };
  }, []);

  /* ── the playback engine ─────────────────────────────────────────────── */
  const stopAll = useCallback(() => {
    runId.current += 1;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const a = audioRef.current;
    if (a) { a.onended = null; a.onerror = null; a.pause(); }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  const playSlide = useCallback((n0: number, opts: { muted: boolean; voice: Voice }) => {
    stopAll();
    const s = slides[n0];
    if (!s) return;
    const run = runId.current;
    setI(n0);
    setProgress(0);
    setPhase('playing');
    const c = clock.current;
    c.start = performance.now(); c.pausedTotal = 0; c.pausedAt = 0; c.dur = estimateMs(s.say);
    c.loading = false;
    setUnheard(false);

    const next = () => {
      if (run !== runId.current) return;
      timerRef.current = setTimeout(() => {
        if (run !== runId.current) return;
        if (n0 + 1 >= slides.length) { setProgress(1); setPhase('done'); stopAll(); }
        else playSlide(n0 + 1, { muted: mutedRef.current, voice: voiceRef.current });
      }, 650);
    };
    const timed = (ms: number) => { c.mode = 'timer'; timerRef.current = setTimeout(next, ms); };
    // No sound is possible: the captions carry the scene, for as long as it takes to read.
    let hushed = false;
    const quiet = () => {
      if (hushed || run !== runId.current) return;
      hushed = true;
      if (!opts.muted) setUnheard(true);
      timed(Math.max(2500, c.dur - (performance.now() - c.start - c.pausedTotal)));
    };
    const speak = () => {
      if (opts.muted) { timed(c.dur); return; }
      if (typeof window === 'undefined' || !('speechSynthesis' in window)) { quiet(); return; }
      c.mode = 'speech';
      const parts = chunk(s.say);
      let began = false;
      window.speechSynthesis.cancel();
      // Phones drop speech silently (outside a tap, inside another app's browser): never pretend she is speaking.
      const watch = () => setTimeout(() => {
        if (run !== runId.current || began) return;
        if (c.pausedAt) { watch(); return; }
        window.speechSynthesis.cancel();
        quiet();
      }, 2500);
      watch();
      parts.forEach((p, k) => {
        const u = new SpeechSynthesisUtterance(p);
        if (speechVoice.current) u.voice = speechVoice.current;
        u.rate = 1; u.pitch = 1;
        u.onstart = () => { began = true; };
        if (k === parts.length - 1) u.onend = () => { if (began) next(); };
        u.onerror = (ev) => { if (run === runId.current && ev.error !== 'interrupted' && ev.error !== 'canceled') quiet(); };
        window.speechSynthesis.speak(u);
      });
    };

    if (opts.voice === 'server') {
      const a = audioRef.current;
      if (!a) { speak(); return; }
      c.mode = 'audio';
      a.muted = opts.muted;
      // The scene's sound would not load or play: once, whichever way the browser says so.
      let failed = false;
      const fail = () => {
        if (failed || run !== runId.current) return;
        failed = true; c.loading = false; a.onerror = null; a.onended = null;
        c.start = performance.now(); c.pausedTotal = 0;
        speak();
      };
      const play = () => a.play().catch((e: { name?: string }) => {
        if (run !== runId.current || c.loading || e?.name === 'AbortError') return; // paused, or on to another scene
        if (e?.name !== 'NotAllowedError') { fail(); return; }
        // The phone wants a tap before sound: wait on the play button instead of playing silently.
        c.pausedAt = performance.now();
        setPhase('paused');
      });
      const sound = (url: string) => {
        c.loading = false;
        a.src = url;
        a.onended = next;
        a.onerror = fail;
        c.start = performance.now(); c.pausedTotal = 0;
        if (!c.pausedAt) void play();
      };
      const mine = clip(n0);
      if (mine.url) sound(mine.url);
      else {
        // Not here yet: the tap's permission is kept with a moment of silence until it arrives.
        c.loading = true;
        a.src = silence();
        void play();
        void mine.job.then((url) => { if (run !== runId.current) return; if (url) sound(url); else if (!c.pausedAt) fail(); else c.loading = false; });
      }
      // The next scene's voice, so there is no gap.
      if (n0 + 1 < slides.length) clip(n0 + 1);
    } else {
      speak();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slides, quizId, lead, stopAll]);

  // One clock for progress, whatever is speaking.
  useEffect(() => {
    if (phase !== 'playing') return;
    let raf = 0;
    const tick = () => {
      const c = clock.current;
      const a = audioRef.current;
      let p: number;
      if (c.mode === 'audio' && c.loading) p = 0;
      else if (c.mode === 'audio' && a && Number.isFinite(a.duration) && a.duration > 0) p = a.currentTime / a.duration;
      else p = (performance.now() - c.start - c.pausedTotal) / c.dur;
      setProgress(Math.max(0, Math.min(1, p)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [phase, i]);

  useEffect(() => () => stopAll(), [stopAll]);

  const { whoosh } = useScore({ enabled: musicOn && !muted, playing: phase === 'playing', track: view?.music || null });
  const cutKind = cutFor(i, slides.length, slide?.visual);
  // Every cut gets a whoosh; the cuts into the big moments get a sweep of warm light.
  const lastCut = useRef(-1);
  useEffect(() => {
    if (phase !== 'playing' || lastCut.current === i) return;
    const first = lastCut.current === -1;
    lastCut.current = i;
    if (first) return;
    whoosh();
    if (!reduced && (cutKind === 'zoom' || cutKind === 'dip')) {
      setLeakAt(i);
      const t = setTimeout(() => setLeakAt(-1), 1500);
      return () => clearTimeout(t);
    }
  }, [i, phase, cutKind, whoosh, reduced]);
  const counted = useRef(false);
  const start = () => {
    // Heard even when an iPhone's side switch is on silent, like any video.
    try { const session = (navigator as unknown as { audioSession?: { type: string } }).audioSession; if (session) session.type = 'playback'; } catch { /* not supported */ }
    // A lead pressing play counts once towards how interested they are.
    if (lead && !counted.current) {
      counted.current = true;
      void fetch('/api/nurture/public', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: lead, watched: true }) }).catch(() => { /* not critical */ });
    }
    playSlide(0, { muted, voice });
  };
  const pause = () => {
    if (phase !== 'playing') return;
    const c = clock.current;
    c.pausedAt = performance.now();
    if (c.mode === 'audio') audioRef.current?.pause();
    else if (c.mode === 'speech') window.speechSynthesis.pause();
    else if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    setPhase('paused');
  };
  const resume = () => {
    if (phase !== 'paused') return;
    const c = clock.current;
    c.pausedTotal += performance.now() - c.pausedAt;
    c.pausedAt = 0;
    setPhase('playing');
    if (c.mode === 'audio' && !audioRef.current?.onended) playSlide(i, { muted, voice }); // its sound had not arrived yet
    else if (c.mode === 'audio') { void audioRef.current?.play().catch(() => playSlide(i, { muted, voice: 'browser' })); }
    else if (c.mode === 'speech') {
      window.speechSynthesis.resume();
      // Some phones drop paused speech: if nothing is speaking, restart the slide.
      setTimeout(() => { if (!window.speechSynthesis.speaking) playSlide(i, { muted, voice }); }, 400);
    } else {
      const left = Math.max(400, c.dur - (performance.now() - c.start - c.pausedTotal));
      const run = runId.current;
      timerRef.current = setTimeout(() => { if (run === runId.current) { if (i + 1 >= slides.length) { setPhase('done'); stopAll(); } else playSlide(i + 1, { muted, voice }); } }, left);
    }
  };
  const toggle = () => (phase === 'playing' ? pause() : phase === 'paused' ? resume() : start());
  const go = (k: number) => { const t = Math.max(0, Math.min(slides.length - 1, k)); playSlide(t, { muted, voice }); };
  const toggleMute = () => {
    const m = !muted;
    setMuted(m);
    const c = clock.current;
    if (c.mode === 'audio' && audioRef.current) audioRef.current.muted = m;
    else if (phase === 'playing' && (c.mode === 'speech' || c.mode === 'timer')) playSlide(i, { muted: m, voice });
  };

  /* ── fullscreen (real where supported, a fixed overlay on iPhone) ───── */
  const toggleFull = () => {
    const el = playerRef.current;
    if (!el) return;
    if (document.fullscreenElement) { void document.exitFullscreen(); return; }
    if (pseudoFull) { setPseudoFull(false); return; }
    if (el.requestFullscreen) el.requestFullscreen().catch(() => setPseudoFull(true));
    else setPseudoFull(true);
  };
  useEffect(() => {
    const on = () => setFull(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  /* ── keyboard ─────────────────────────────────────────────────────────── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!view?.lesson || (e.target as HTMLElement)?.closest('input,textarea,select')) return;
      if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
      else if (e.key === 'ArrowRight' && phase !== 'title') go(i + 1);
      else if (e.key === 'ArrowLeft' && phase !== 'title') go(i - 1);
      else if (e.key === 'm') toggleMute();
      else if (e.key === 'c') setCc(!cc);
      else if (e.key === 'f') toggleFull();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const elapsed = useMemo(() => slides.slice(0, i).reduce((t, s) => t + estimateMs(s.say), 0) + (slide ? estimateMs(slide.say) * progress : 0), [slides, i, slide, progress]);
  const captions = useMemo(() => (slide ? chunk(slide.say) : []), [slide]);
  const caption = captions[Math.min(captions.length - 1, Math.floor(progress * captions.length))] || '';
  const brand = view?.brand || { base: '#0a1733', deep: '#5e0743', accent: '#ff7300' };
  const cc = ccChoice ?? (muted || unheard || voice !== 'server');
  const speaking = phase === 'playing' && !muted && !unheard && voice !== 'silent';
  const evidenceScore = typeof view?.evidence?.scorePct === 'number' ? Math.round(view.evidence.scorePct) : null;
  const isLead = Boolean(lead);
  const sceneFootage = (view?.footage || [])[phase === 'title' ? 0 : i] || null;
  const ctaHref = view?.cta?.href || `/quiz/${quizId}`;
  const ctaLabel = view?.cta?.label || `Start the ${n}-question test`;
  const skipHref = view?.skip?.href || `/quiz/${quizId}`;
  const skipLabel = view?.skip?.label || 'Skip to the test';

  return (
    <div className="vl-page">
      {/* What the student or lead sees is the academy, not the software behind it. */}
      <header className="vl-top">
        {view?.logo ? <img className="vl-logo" src={`${view.logo}?tone=white`} alt={academy || ''} /> : <b className="vl-academy">{academy || 'Your academy'}</b>}
        <span>{isLead ? 'Made for you' : 'Your personal lesson'}</span>
      </header>
      <main className="vl-main">
        {err && <div className="vl-card"><h1>We could not find this {isLead ? 'video' : 'lesson'}</h1><p>{err} If you opened this from an email, the link may be from a demo that has since been reset.</p></div>}
        {!view && !err && <div className="vl-card vl-loading"><span className="vl-spin" aria-hidden="true" />Loading your {isLead ? 'video' : 'lesson'}…</div>}
        {view && !view.lesson && <div className="vl-card"><h1>No video for this test</h1><p>Your study pack has everything you need.</p><a className="vl-btn vl-btn--cta" href={ctaHref}>Go to the test<ArrowRight size={16} /></a></div>}

        {view?.lesson && slide && (
          <>
            <div
              ref={playerRef}
              className={`vl-player${full ? ' is-full' : ''}${pseudoFull ? ' is-pseudo-full' : ''}`}
              style={{ ['--a' as string]: brand.accent, ['--a2' as string]: brand.accent, ['--base' as string]: brand.base, ['--deep' as string]: brand.deep }}
            >
              <div className={`vl-stage vl-bg--${phase === 'title' ? 'title' : phase === 'done' ? 'done' : slide.visual || 'concept'}${sceneFootage ? ' has-footage' : ''}`}>
                <Backdrop footage={sceneFootage} index={phase === 'title' ? 0 : i} playing={phase === 'playing' || phase === 'title'} light={phase !== 'title' && phase !== 'done' && slide.visual === 'photo'} />
                <LightLeak show={leakAt === i} />

                {phase === 'title' && (
                  <button type="button" className="vl-title" onClick={start} aria-label={`Play your ${minutes}-minute lesson`}>
                    <span className="vl-chip">Made for you · {view.module.code}</span>
                    <motion.h1 initial={reduced ? false : { opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.7, ease: [0.2, 1, 0.3, 1] }}>
                      Hey {first}
                    </motion.h1>
                    <motion.p initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.25, duration: 0.6 }}>
                      {tutor} made you a {minutes}-minute {isLead ? 'video' : 'lesson'} {isLead ? 'about' : 'on'} <b>{view.topic}</b>
                      {evidenceScore !== null ? <>, after your {evidenceScore}% on {view.module.code}.</> : '.'}
                    </motion.p>
                    <span className="vl-bigplay"><Play size={34} fill="currentColor" /></span>
                    <em>{isLead ? `Sound on · about ${minutes} minutes` : `Sound on · then a ${n}-question test`}</em>
                  </button>
                )}

                {(phase === 'playing' || phase === 'paused') && (
                  <>
                    <div className="vl-chapter"><b>{i + 1}/{slides.length}</b>{view.module.code}</div>
                    {/* Outgoing and incoming move together: the cut is the exit (no fade to nothing in between). */}
                    <AnimatePresence initial={false} custom={cutKind}>
                      <motion.div
                        key={i}
                        className={`vl-scene vl-scene--${slide.visual || 'concept'}`}
                        custom={cutKind}
                        variants={reduced ? undefined : cutVariants}
                        initial={reduced ? { opacity: 0 } : 'enter'}
                        animate={reduced ? { opacity: 1 } : 'center'}
                        exit={reduced ? { opacity: 0 } : 'exit'}
                        transition={reduced ? { duration: 0.2 } : undefined}
                      >
                        <Camera index={i} durMs={estimateMs(slide.say)} paused={phase === 'paused' || Boolean(reduced)}>
                          <Scene slide={slide} progress={progress} reduced={Boolean(reduced)} first={first} n={n} pass={pass} evidenceScore={evidenceScore} missed={view.noticed || view.evidence?.missedTopics || []} tutor={tutor} tiles={view.ctaTiles} kicker={view.ctaKicker} />
                        </Camera>
                      </motion.div>
                    </AnimatePresence>
                    <div className={`vl-presenter${speaking ? ' is-speaking' : ''}`}>
                      <span className="vl-avatar">{tutor.charAt(0)}</span>
                      <span className="vl-who"><b>{tutor}</b><small>{speaking ? 'Speaking' : phase === 'paused' ? 'Paused' : view.presenter?.label || 'Your tutor'}</small></span>
                      <span className="vl-wavebars" aria-hidden="true"><i /><i /><i /><i /><i /></span>
                    </div>
                    {cc && caption && <p className="vl-cc" aria-live="polite">{caption}</p>}
                    {unheard && phase === 'playing' && (
                      <button type="button" className="vl-unheard" onClick={() => playSlide(i, { muted: false, voice })}><Volume2 size={15} />Tap for sound</button>
                    )}
                    {phase === 'paused' && (
                      <button type="button" className="vl-pausedcover" onClick={resume} aria-label="Resume"><Play size={30} fill="currentColor" /></button>
                    )}
                  </>
                )}

                {phase === 'done' && (
                  <motion.div className="vl-end" initial={reduced ? false : { opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.5 }}>
                    <span className="vl-endicon"><Check size={30} strokeWidth={3} /></span>
                    <h2>{isLead ? `Thanks for watching, ${first}.` : `Nice work, ${first}.`}</h2>
                    {isLead
                      ? <p>{view.cta?.label === 'Find my tech fit' ? <>Find out which path fits you best: <b>6 quick questions</b>, no wrong answers.</> : <>When you are ready, the next step is easy, and a person helps you all the way.</>}</p>
                      : <p>Now show what you know: <b>{n} questions</b> on exactly this. Score {pass}% or more and your record updates straight away.</p>}
                    <div className="vl-endbtns">
                      <a className="vl-btn vl-btn--cta" href={ctaHref}>{ctaLabel}<ArrowRight size={16} /></a>
                      <button type="button" className="vl-btn vl-btn--ghost" onClick={start}><RotateCcw size={15} />Watch again</button>
                    </div>
                  </motion.div>
                )}
              </div>

              <div className="vl-controls">
                <button type="button" className="vl-ic" onClick={() => go(i - 1)} disabled={phase === 'title' || i === 0} aria-label="Previous scene"><SkipBack size={18} /></button>
                <button type="button" className="vl-ic vl-ic--main" onClick={phase === 'done' ? start : toggle} aria-label={phase === 'playing' ? 'Pause' : 'Play'}>
                  {phase === 'playing' ? <Pause size={20} fill="currentColor" /> : phase === 'done' ? <RotateCcw size={18} /> : <Play size={20} fill="currentColor" />}
                </button>
                <button type="button" className="vl-ic" onClick={() => go(i + 1)} disabled={phase === 'title' || i >= slides.length - 1} aria-label="Next scene"><SkipForward size={18} /></button>
                <div className="vl-segs" role="group" aria-label="Scenes">
                  {slides.map((s, k) => (
                    <button
                      key={k}
                      type="button"
                      className={`vl-seg${k < i || phase === 'done' ? ' is-done' : ''}${k === i && phase !== 'title' && phase !== 'done' ? ' is-now' : ''}`}
                      onClick={() => go(k)}
                      title={`${k + 1}. ${s.heading}`}
                      aria-label={`Scene ${k + 1}: ${s.heading}`}
                    >
                      <i style={k === i && phase !== 'title' && phase !== 'done' ? { width: `${progress * 100}%` } : undefined} />
                    </button>
                  ))}
                </div>
                <span className="vl-time">{fmt(phase === 'done' ? totalMs : elapsed)} / {fmt(totalMs)}</span>
                <button type="button" className="vl-ic" onClick={toggleMute} aria-label={muted ? 'Unmute' : 'Mute'} aria-pressed={muted}>{muted ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
                <button type="button" className={`vl-ic${musicOn ? '' : ' is-off'}`} onClick={toggleMusic} aria-label={musicOn ? 'Music off' : 'Music on'} aria-pressed={musicOn} title={musicOn ? 'Music: on' : 'Music: off'}><Music size={17} /></button>
                <button type="button" className="vl-ic" onClick={() => setCc(!cc)} aria-label="Captions" aria-pressed={cc}>{cc ? <Captions size={18} /> : <CaptionsOff size={18} />}</button>
                <button type="button" className="vl-ic" onClick={toggleFull} aria-label={full || pseudoFull ? 'Exit full screen' : 'Full screen'}>{full || pseudoFull ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
              </div>
            </div>

            <div className="vl-below">
              <div>
                <span className="vl-kicker">{view.module.code} · {view.module.title}</span>
                <h1>{view.lesson.title}</h1>
                <p>For {view.learner.name} · {slides.length} scenes · about {minutes} min · {voice === 'server' ? 'narrated' : voice === 'browser' ? 'narrated by your device' : 'captions only'}</p>
              </div>
              <a className="vl-btn vl-btn--outline" href={skipHref}>{skipLabel}<ArrowRight size={15} /></a>
            </div>
            <p className="vl-keys">Space play/pause · ← → scenes · M mute · C captions · F full screen</p>
          </>
        )}
      </main>
      {/* One persistent element: phones only let a tapped-to-start element keep playing. */}
      <audio ref={audioRef} preload="auto" playsInline hidden />
    </div>
  );
}
