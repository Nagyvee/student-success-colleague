'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { Lesson } from '@/lib/types';
import Logo from '@/components/Logo';
import Icon from '@/components/Icon';

/* The 3-minute lesson, played like a video.
 *
 * Lindiwe wrote the slides and the narration for this one learner; the
 * browser reads the narration aloud (Web Speech), the slide's points appear as
 * it speaks, captions run underneath, and the bar shows how far along it is.
 * No speech voice on the device? It still plays, timed from the words, with
 * captions. At the end: straight into the quiz. */

interface View { learner: { name: string }; module: { code: string; title: string }; topic: string; lesson: Lesson | null }

const wordsMs = (t: string) => Math.max(3500, t.split(/\s+/).length * 380);

export default function LessonPlayer({ quizId }: { quizId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [i, setI] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [done, setDone] = useState(false);
  const [shown, setShown] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voice = useRef<SpeechSynthesisVoice | null>(null);

  useEffect(() => {
    fetch(`/api/quiz/${encodeURIComponent(quizId)}`, { cache: 'no-store' })
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error || 'Not found'); setView(d as View); })
      .catch((e) => setErr((e as Error).message));
  }, [quizId]);

  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    const pick = () => {
      const vs = window.speechSynthesis.getVoices();
      voice.current = vs.find((v) => /en-ZA/i.test(v.lang)) || vs.find((v) => /en-GB/i.test(v.lang) && /female|natural|google/i.test(v.name)) || vs.find((v) => /^en/i.test(v.lang)) || null;
    };
    pick();
    window.speechSynthesis.onvoiceschanged = pick;
    return () => { window.speechSynthesis.cancel(); };
  }, []);

  const slides = view?.lesson?.slides || [];
  const slide = slides[i];

  const stop = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
  }, []);

  const next = useCallback(() => {
    stop();
    setShown(0);
    setI((n) => { if (n + 1 >= slides.length) { setDone(true); setPlaying(false); return n; } return n + 1; });
  }, [slides.length, stop]);

  // Speak the current slide; reveal its points while it speaks; move on when it ends.
  useEffect(() => {
    if (!playing || !slide) return;
    const reveal = setInterval(() => setShown((n) => Math.min(slide.points.length + (slide.code ? 1 : 0), n + 1)), 1600);
    const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;
    if (canSpeak) {
      const u = new SpeechSynthesisUtterance(slide.say);
      if (voice.current) u.voice = voice.current;
      u.rate = 0.98;
      u.onend = () => { timer.current = setTimeout(next, 700); };
      u.onerror = () => { timer.current = setTimeout(next, wordsMs(slide.say)); };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    } else {
      timer.current = setTimeout(next, wordsMs(slide.say));
    }
    return () => { clearInterval(reveal); if (timer.current) clearTimeout(timer.current); };
  }, [playing, slide, next]);

  const play = () => { setStarted(true); setDone(false); setPlaying(true); };
  const pause = () => { stop(); setPlaying(false); };
  const go = (delta: number | 'start') => { stop(); setShown(0); setDone(false); setI((n) => (delta === 'start' ? 0 : Math.max(0, Math.min(slides.length - 1, n + delta)))); };

  const first = view?.learner.name.split(' ')[0];
  const minutes = Math.max(2, Math.round(slides.reduce((n, s) => n + s.say.split(/\s+/).length, 0) / 150));

  return (
    <div className="lp">
      <header className="lp-top">
        <Logo size="sm" />
        <span>Your lesson</span>
      </header>
      <main className="lp-main">
        {err && <div className="lp-card"><h1>We could not find this lesson</h1><p>{err}</p></div>}
        {!view && !err && <div className="lp-card"><p>Loading your lesson…</p></div>}
        {view && !view.lesson && <div className="lp-card"><h1>No lesson for this quiz</h1><Link className="btn btn-cta" href={`/quiz/${quizId}`}>Go to the quiz</Link></div>}
        {view?.lesson && slide && (
          <>
            <div className="lp-head">
              <span className="lp-badge">{view.module.code} · {view.module.title}</span>
              <h1>{view.lesson.title}</h1>
              <span className="lp-meta">For {view.learner.name} · {slides.length} slides · about {minutes} min</span>
            </div>
            <div className={`lp-stage${playing ? ' is-playing' : ''}`}>
              {!started ? (
                <button type="button" className="lp-start" onClick={play}>
                  <span className="lp-play"><Icon name="play" size={34} /></span>
                  <b>Play your {minutes}-minute lesson</b>
                  <em>{first}, turn your sound on</em>
                </button>
              ) : done ? (
                <div className="lp-end">
                  <Icon name="badgeCheck" size={40} />
                  <b>Nice work, {first}.</b>
                  <p>Now show what you know: 3 questions on exactly this.</p>
                  <Link className="btn btn-cta" href={`/quiz/${quizId}`}><Icon name="play" size={14} />Take the quiz</Link>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => { go('start'); play(); }}>Watch again</button>
                </div>
              ) : (
                <div key={i} className="lp-slide">
                  <span className="lp-n">{i + 1} / {slides.length}</span>
                  <h2>{slide.heading}</h2>
                  <ul>{slide.points.map((p, k) => <li key={k} className={k < shown ? 'on' : ''}>{p}</li>)}</ul>
                  {slide.code && <pre className={shown > slide.points.length - 1 ? 'on' : ''}>{slide.code}</pre>}
                </div>
              )}
            </div>
            {started && !done && <p className="lp-cap" aria-live="polite">{slide.say}</p>}
            <div className="lp-bar" aria-hidden="true">{slides.map((_, k) => <i key={k} className={k < i || done ? 'done' : k === i && started ? 'now' : ''} />)}</div>
            <div className="lp-ctrl">
              <button type="button" className="iconbtn" onClick={() => go(-1)} disabled={i === 0} aria-label="Previous slide"><Icon name="arrowLeft" size={16} /></button>
              {playing ? <button type="button" className="btn btn-outline btn-sm" onClick={pause}><Icon name="pause" size={14} />Pause</button>
                : <button type="button" className="btn btn-cta btn-sm" onClick={play}><Icon name="play" size={14} />{started ? 'Resume' : 'Play'}</button>}
              <button type="button" className="iconbtn" onClick={() => go(1)} disabled={i >= slides.length - 1} aria-label="Next slide"><Icon name="arrowRight" size={16} /></button>
              <Link className="lp-skip" href={`/quiz/${quizId}`}>Skip to the quiz</Link>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
