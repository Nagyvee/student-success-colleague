'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowLeft, ArrowRight, Brain, ChartColumn, Code2, Coffee, Compass, Heart, LayoutDashboard, Lightbulb, MessageCircle,
  Play, Puzzle, RotateCcw, Rocket, Search, ShieldCheck, Star, Target, Trophy, Users, Zap, type LucideIcon,
} from 'lucide-react';
import type { FitQuestion, FitTrack } from '@/lib/nurture/types';
import '../fit.css';

/* The career-fit quiz a lead opens from their email.
 *
 * One question at a time, big tappable answers, no wrong ones. The result
 * says something true and kind about them, names the programme that fits,
 * and offers the next step (their personal video, or applying). */

const ICON: Record<string, LucideIcon> = {
  code: Code2, chart: ChartColumn, shield: ShieldCheck, brain: Brain, sparkles: Star, star: Star, rocket: Rocket, search: Search, users: Users,
  puzzle: Puzzle, zap: Zap, trophy: Trophy, coffee: Coffee, lightbulb: Lightbulb, target: Target, heart: Heart, compass: Compass,
  layout: LayoutDashboard, message: MessageCircle,
};
const Ic = ({ name, size = 22 }: { name: string; size?: number }) => {
  const C = ICON[name] || Compass;
  return <C size={size} strokeWidth={2} aria-hidden="true" />;
};

interface Link { href: string; label: string }
interface View {
  first: string;
  academy: string;
  brand: { base: string; deep: string; accent: string };
  quiz: { title: string; intro: string; questions: FitQuestion[]; tracks: FitTrack[] };
  done: { track: string; programme: string } | null;
  next: { apply: Link; video: Link; quiz: Link };
}
interface Result { track: FitTrack; scores: Record<string, number>; next: View['next'] }

export default function FitClient({ token }: { token: string }) {
  const reduced = useReducedMotion();
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [step, setStep] = useState(-1); // -1 intro, 0..n-1 questions
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<Result | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch(`/api/nurture/public?fit=1&t=${encodeURIComponent(token)}`, { cache: 'no-store' })
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Not found'); setView(d as View); })
      .catch((e) => setErr((e as Error).message));
  }, [token]);

  const qs = view?.quiz.questions || [];
  const q = step >= 0 ? qs[step] : null;
  const previous = useMemo(() => {
    if (!view?.done) return null;
    return view.quiz.tracks.find((t) => t.name === view.done!.track) || null;
  }, [view]);

  async function choose(qid: string, idx: number) {
    const next = { ...answers, [qid]: idx };
    setAnswers(next);
    if (step + 1 < qs.length) { setTimeout(() => setStep(step + 1), reduced ? 0 : 220); return; }
    setSaving(true);
    try {
      const r = await fetch('/api/nurture/public', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: token, answers: next }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not save');
      setResult({ track: d.track, scores: d.scores, next: d.next });
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const brand = view?.brand || { base: '#0a1733', deep: '#5e0743', accent: '#ff7300' };
  const style = { ['--base' as string]: brand.base, ['--deep' as string]: brand.deep, ['--a' as string]: brand.accent };
  const anim = () => ({
    initial: reduced ? { opacity: 0 } : { opacity: 0, y: 18 },
    animate: { opacity: 1, y: 0 },
    exit: reduced ? { opacity: 0 } : { opacity: 0, y: -12 },
    transition: { duration: reduced ? 0.15 : 0.4, ease: [0.2, 1, 0.3, 1] as [number, number, number, number] },
  });

  return (
    <div className="fit-page" style={style}>
      <header className="fit-top"><b>{view?.academy || ''}</b><span>Career-fit quiz</span></header>
      <main className="fit-main">
        {err && <div className="fit-card"><h1>Something went wrong</h1><p>{err}</p></div>}
        {!view && !err && <div className="fit-card fit-loading"><span className="fit-spin" aria-hidden="true" />Loading your quiz…</div>}

        {view && !err && (
          <AnimatePresence mode="wait">
            {/* Result */}
            {result && (
              <motion.section key="result" className="fit-card fit-result" {...anim()}>
                <ResultCard first={view.first} track={result.track} tracks={view.quiz.tracks} scores={result.scores} total={qs.length} next={result.next} reduced={Boolean(reduced)} />
              </motion.section>
            )}

            {/* Already done before: show it, offer a retake */}
            {!result && step === -1 && previous && (
              <motion.section key="prev" className="fit-card fit-result" {...anim()}>
                <ResultCard first={view.first} track={previous} tracks={view.quiz.tracks} scores={null} total={qs.length} next={view.next} reduced={Boolean(reduced)} />
                <button type="button" className="fit-link" onClick={() => { setAnswers({}); setStep(0); }}><RotateCcw size={14} /> Take it again</button>
              </motion.section>
            )}

            {/* Intro */}
            {!result && step === -1 && !previous && (
              <motion.section key="intro" className="fit-card fit-intro" {...anim()}>
                <div className="fit-orbit" aria-hidden="true">
                  {view.quiz.tracks.slice(0, 4).map((t, k) => (
                    <motion.span key={t.id} className={`fit-orb fit-orb--${k}`} initial={reduced ? false : { scale: 0, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.15 + k * 0.12, type: 'spring', stiffness: 260, damping: 18 }}>
                      <Ic name={t.icon} size={22} />
                    </motion.span>
                  ))}
                </div>
                <h1>Hey {view.first}</h1>
                <h2>{view.quiz.title}</h2>
                <p>{view.quiz.intro || `${qs.length} quick questions, no wrong answers.`}</p>
                <button type="button" className="fit-btn" onClick={() => setStep(0)}>Let&apos;s go <ArrowRight size={17} /></button>
                <small>{qs.length} questions · about 2 minutes</small>
              </motion.section>
            )}

            {/* A question */}
            {!result && q && (
              <motion.section key={q.id} className="fit-card fit-q" {...anim()}>
                <div className="fit-progress" aria-label={`Question ${step + 1} of ${qs.length}`}>
                  {qs.map((x, k) => <i key={x.id} className={k < step ? 'done' : k === step ? 'now' : ''} />)}
                </div>
                <span className="fit-qicon"><Ic name={q.icon} size={26} /></span>
                <h2>{q.prompt}</h2>
                <div className="fit-options">
                  {q.options.map((o, k) => {
                    return (
                      <motion.button
                        key={k}
                        type="button"
                        className={`fit-opt${answers[q.id] === k ? ' on' : ''}`}
                        onClick={() => choose(q.id, k)}
                        disabled={saving}
                        initial={reduced ? false : { opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: reduced ? 0 : 0.05 + k * 0.06 }}
                      >
                        <span className="fit-opt-ic">{String.fromCharCode(65 + k)}</span>
                        <span>{o.label}</span>
                      </motion.button>
                    );
                  })}
                </div>
                <div className="fit-qfoot">
                  <button type="button" className="fit-link" onClick={() => setStep(step - 1)} disabled={saving}><ArrowLeft size={14} /> Back</button>
                  <span>{saving ? 'Working out your path…' : `${step + 1} of ${qs.length}`}</span>
                </div>
              </motion.section>
            )}
          </AnimatePresence>
        )}
      </main>
    </div>
  );
}

function ResultCard({ first, track, tracks, scores, total, next, reduced }: { first: string; track: FitTrack; tracks: FitTrack[]; scores: Record<string, number> | null; total: number; next: View['next']; reduced: boolean }) {
  return (
    <>
      <motion.span className="fit-badge" initial={reduced ? false : { scale: 0.4, rotate: -12, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 220, damping: 14 }}>
        <Ic name={track.icon} size={40} />
      </motion.span>
      <small className="fit-kicker">{first}, you are</small>
      <h1>{track.name}</h1>
      <p className="fit-tagline">{track.tagline}</p>
      <div className="fit-match">
        <span>Your best fit</span>
        <b>{track.programme}</b>
      </div>
      <p className="fit-why">{track.why}</p>
      {scores && (
        <div className="fit-bars">
          {tracks.map((t) => {
            const pct = total ? Math.round(((scores[t.id] || 0) / total) * 100) : 0;
            return (
              <div key={t.id} className={`fit-bar${t.id === track.id ? ' top' : ''}`}>
                <span>{t.name}</span>
                <i><motion.em initial={reduced ? false : { width: 0 }} animate={{ width: `${Math.max(4, pct)}%` }} transition={{ duration: 0.9, delay: 0.3 }} /></i>
                <b>{pct}%</b>
              </div>
            );
          })}
        </div>
      )}
      <div className="fit-next">
        <a className="fit-btn" href={next.video.href}><Play size={16} fill="currentColor" /> Watch a video made for you</a>
        <a className="fit-btn fit-btn--ghost" href={next.apply.href}>{next.apply.label} <ArrowRight size={16} /></a>
      </div>
    </>
  );
}
