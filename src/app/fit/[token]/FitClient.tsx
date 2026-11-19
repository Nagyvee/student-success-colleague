'use client';

import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowLeft, ArrowRight, Brain, Briefcase, ChartColumn, Code2, Coffee, Compass, Download, Heart, LayoutDashboard, Lightbulb, MessageCircle,
  Phone, Play, Puzzle, RotateCcw, Rocket, Search, Share2, ShieldCheck, Sparkles, Star, Target, Trophy, Users, Zap, type LucideIcon,
} from 'lucide-react';
import type { FitQuestion, FitTrack } from '@/lib/nurture/types';
import { drawScorecard } from './scorecard';
import '../fit.css';

/* The career-fit quiz a lead opens from their email.
 *
 * One question at a time, big tappable answers, no wrong ones. The result
 * says something true and kind about them, names the programme that fits,
 * shows how they matched every path, their strengths, the jobs the path
 * leads to and one free thing to try this week, and gives them a branded
 * scorecard to keep or share. The next step is their video, or "yes". */

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
export type Track = FitTrack & { strengths?: string[]; careers?: string[]; tryThis?: string };
interface View {
  first: string;
  academy: string;
  logo: string | null;
  site: string;
  brand: { base: string; deep: string; accent: string };
  quiz: { title: string; intro: string; questions: FitQuestion[]; tracks: Track[] };
  done: { track: string; programme: string; scores: Record<string, number> | null } | null;
  next: { apply: Link; call?: Link; video: Link; quiz: Link };
}
interface Result { track: Track; scores: Record<string, number> | null; next: View['next'] }

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
      <header className="fit-top">
        {view?.logo ? <img className="fit-logo" src={`${view.logo}?tone=white`} alt={view.academy} /> : <b>{view?.academy || ''}</b>}
        <span>Career-fit quiz</span>
      </header>
      <main className="fit-main">
        {err && <div className="fit-card"><h1>Something went wrong</h1><p>{err}</p></div>}
        {!view && !err && <div className="fit-card fit-loading"><span className="fit-spin" aria-hidden="true" />Loading your quiz…</div>}

        {view && !err && (
          <AnimatePresence mode="wait">
            {/* Result */}
            {result && (
              <motion.section key="result" className="fit-card fit-result" {...anim()}>
                <ResultCard view={view} track={result.track} scores={result.scores} next={result.next} reduced={Boolean(reduced)} />
              </motion.section>
            )}

            {/* Already done before: show it, offer a retake */}
            {!result && step === -1 && previous && (
              <motion.section key="prev" className="fit-card fit-result" {...anim()}>
                <ResultCard view={view} track={previous} scores={view.done?.scores || null} next={view.next} reduced={Boolean(reduced)} />
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
                <ul className="fit-gets" aria-label="What you get">
                  <li><Sparkles size={16} aria-hidden="true" /> Your tech personality</li>
                  <li><Target size={16} aria-hidden="true" /> The programme that fits you best</li>
                  <li><Download size={16} aria-hidden="true" /> A scorecard to keep and share</li>
                </ul>
                <button type="button" className="fit-btn" onClick={() => setStep(0)}>Let&apos;s go <ArrowRight size={17} /></button>
                <small>{qs.length} questions · about 2 minutes · no wrong answers</small>
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
                  {q.options.map((o, k) => (
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
                  ))}
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

function ResultCard({ view, track, scores, next, reduced }: { view: View; track: Track; scores: Record<string, number> | null; next: View['next']; reduced: boolean }) {
  const tracks = view.quiz.tracks;
  const total = view.quiz.questions.length;
  const full = tracks.find((t) => t.id === track.id) || track;
  const strengths = track.strengths || full.strengths || [];
  const careers = track.careers || full.careers || [];
  const tryThis = track.tryThis || full.tryThis || '';
  const [card, setCard] = useState<{ url: string; blob: Blob } | null>(null);
  const [cardErr, setCardErr] = useState(false);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.canShare === 'function' && typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  const fileName = `career-fit-scorecard-${view.first.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'me'}.png`;

  // The scorecard is drawn once the result is on screen (fonts and logo loaded first).
  useEffect(() => {
    let url = '';
    drawScorecard({ first: view.first, track: { ...track, strengths, careers, tryThis }, tracks, scores, total, academy: view.academy, site: view.site, logo: view.logo ? `${view.logo}?tone=white` : null })
      .then((blob) => { url = URL.createObjectURL(blob); setCard({ url, blob }); })
      .catch(() => setCardErr(true));
    return () => { if (url) URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.id]);

  async function share() {
    if (!card) return;
    try { await navigator.share({ files: [new File([card.blob], fileName, { type: 'image/png' })], title: 'My career-fit scorecard' }); } catch { /* closed */ }
  }

  return (
    <>
      <motion.span className="fit-badge" initial={reduced ? false : { scale: 0.4, rotate: -12, opacity: 0 }} animate={{ scale: 1, rotate: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 220, damping: 14 }}>
        <Ic name={track.icon} size={40} />
      </motion.span>
      <small className="fit-kicker">{view.first}, you are</small>
      <h1>{track.name}</h1>
      <p className="fit-tagline">{track.tagline}</p>
      <div className="fit-match">
        <span>Your best fit</span>
        <b>{track.programme}</b>
      </div>
      <p className="fit-why">{track.why}</p>

      {scores && (
        <div className="fit-section">
          <h3>How you matched every path</h3>
          <div className="fit-bars">
            {tracks.map((t) => {
              const pct = total ? Math.round(((scores[t.id] || 0) / total) * 100) : 0;
              return (
                <div key={t.id} className={`fit-bar${t.id === track.id ? ' top' : ''}`}>
                  <span>{t.programme}</span>
                  <i><motion.em initial={reduced ? false : { width: 0 }} animate={{ width: `${Math.max(4, pct)}%` }} transition={{ duration: 0.9, delay: 0.3 }} /></i>
                  <b>{pct}%</b>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {strengths.length > 0 && (
        <div className="fit-section">
          <h3>Your strengths</h3>
          <ul className="fit-chips">{strengths.map((s) => <li key={s}><Star size={13} aria-hidden="true" /> {s}</li>)}</ul>
        </div>
      )}
      {careers.length > 0 && (
        <div className="fit-section">
          <h3>Where {track.programme} can take you</h3>
          <ul className="fit-chips fit-chips--jobs">{careers.map((c) => <li key={c}><Briefcase size={13} aria-hidden="true" /> {c}</li>)}</ul>
        </div>
      )}
      {tryThis && (
        <div className="fit-try">
          <span aria-hidden="true"><Lightbulb size={18} /></span>
          <div><b>Try this week</b><p>{tryThis}</p></div>
        </div>
      )}

      <div className="fit-next">
        <a className="fit-btn" href={next.video.href}><Play size={16} fill="currentColor" /> Watch a video made for you</a>
        <a className="fit-btn fit-btn--ghost" href={next.apply.href}>{next.apply.label} <ArrowRight size={16} /></a>
      </div>
      {next.call && <a className="fit-link fit-call" href={next.call.href}><Phone size={14} /> Prefer to talk first? We&apos;ll call you</a>}

      <div className="fit-section fit-card-dl">
        <h3>Your scorecard</h3>
        {card ? (
          <a href={card.url} download={fileName} className="fit-card-preview" aria-label="Download your scorecard">
            <img src={card.url} alt={`${view.first}'s career-fit scorecard: ${track.name}, best fit ${track.programme}`} />
          </a>
        ) : !cardErr ? <span className="fit-card-wait"><span className="fit-spin" aria-hidden="true" /> Making your scorecard…</span> : null}
        {card && (
          <div className="fit-next">
            <a className="fit-btn fit-btn--ghost" href={card.url} download={fileName}><Download size={16} /> Download my scorecard</a>
            {canShare && <button type="button" className="fit-btn fit-btn--ghost" onClick={share}><Share2 size={16} /> Share</button>}
          </div>
        )}
      </div>
    </>
  );
}
