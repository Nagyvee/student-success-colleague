'use client';

import { useEffect, useState } from 'react';
import Icon from '@/components/Icon';
import QuizPlayer, { type PlayResult, type PlayableQuestion } from '@/components/QuizPlayer';
import { post } from '@/hooks/useOfficeStream';
import '../../lesson.css';

/* The learner's page. Phone first, no sign-in, nothing to install:
 * watch the personal lesson, read the refresher, take the mastery test one
 * question at a time, and see the result (and the record update) at once. */

interface LocalizedTutoring { language: 'zu' | 'st'; label: string; summary: string; keyPoints: string[] }

interface PublicQuiz {
  quizId: string; status: 'pending' | 'completed'; dispatched: boolean;
  learner: { name: string }; module: { code: string; title: string }; topic: string;
  tutoringSummary: string; keyPoints: string[];
  localizedSummary?: LocalizedTutoring | null;
  allTranslations?: Record<'zu' | 'st', LocalizedTutoring> | null;
  passMark: number; questions: PlayableQuestion[];
  resources?: { label: string; url: string; kind: 'read' | 'watch' }[];
  lesson?: { title: string; slides: { say: string }[]; tutorName?: string } | null;
  academyName?: string;
  logo?: string | null;
  evidence?: { scorePct: number | null; missedTopics: string[] } | null;
  result: { score: number; total: number; pct: number; passed: boolean; answers: number[] } | null;
}

export default function QuizPage({ quizId }: { quizId: string }) {
  const [quiz, setQuiz] = useState<PublicQuiz | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [langView, setLangView] = useState<'en' | 'zu' | 'st' | 'bi'>('en');
  const [showRefresher, setShowRefresher] = useState(true);

  useEffect(() => {
    fetch(`/api/quiz/${encodeURIComponent(quizId)}`, { cache: 'no-store' })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Not found');
        const q = d as PublicQuiz;
        setQuiz(q);
        if (q.localizedSummary) setLangView('bi');
        if (q.status === 'completed') setShowRefresher(false);
      })
      .catch((e) => setErr((e as Error).message));
  }, [quizId]);

  const hasTranslations = Boolean(quiz?.allTranslations?.zu || quiz?.allTranslations?.st || quiz?.localizedSummary);
  const activeLoc = langView === 'zu'
    ? quiz?.allTranslations?.zu
    : langView === 'st'
      ? quiz?.allTranslations?.st
      : quiz?.localizedSummary || quiz?.allTranslations?.zu;

  const first = quiz?.learner.name.split(' ')[0];
  const n = quiz?.questions.length || 0;
  const mins = Math.max(3, Math.round(n * 0.75));
  const lessonMins = quiz?.lesson ? Math.max(2, Math.round(quiz.lesson.slides.reduce((t, s) => t + s.say.split(/\s+/).length, 0) / 150)) : 0;
  const initial: PlayResult | null = quiz?.result ? { ...quiz.result, questions: quiz.questions } : null;
  const academy = quiz?.academyName || 'the academy';

  return (
    <div className="qp mt-page">
      <header className="qp-top">
        {quiz?.logo ? <img className="vl-logo" src={`${quiz.logo}?tone=white`} alt={quiz.academyName || ''} /> : <b className="vl-academy">{quiz?.academyName || 'Your academy'}</b>}
        <span className="mini" style={{ color: 'rgba(255,255,255,.7)' }}>Your study pack</span>
      </header>
      <main className="qp-wrap">
        {err && <div className="qp-hero"><h1>We could not find that test</h1><p>{err} If you reached this from an email, the link may have been for a demo session that has since been reset.</p></div>}
        {!quiz && !err && <div className="qp-hero"><p className="dim">Loading your test…</p></div>}
        {quiz && (
          <>
            <section className="qp-hero mt-hero">
              <div className="qp-chips">
                <span className="badge badge-soft">{quiz.module.code}</span>
                <span className="badge badge-cta">{quiz.topic}</span>
                <span className="badge badge-mute">{n} questions · about {mins} minutes</span>
              </div>
              <h1>{quiz.status === 'completed'
                ? `${first}, here is how you did on ${quiz.topic}.`
                : `${first}, ${n} questions stand between you and the rest of ${quiz.module.code}.`}</h1>
              <p>Everything here is on <b>{quiz.topic}</b>{typeof quiz.evidence?.scorePct === 'number' ? `, the part of your last ${quiz.module.code} checkpoint (${Math.round(quiz.evidence.scorePct)}%) that needs one more look` : ''}. Pass mark is {quiz.passMark}%. Your learner record updates the moment you submit.</p>
            </section>

            {quiz.lesson && quiz.status !== 'completed' && (
              <a className="mt-lessoncard" href={`/learn/${quizId}`}>
                <span className="mt-lessonthumb" aria-hidden="true"><b>Hey {first}</b><i><Icon name="play" size={22} /></i></span>
                <span className="mt-lessontext">
                  <small>Start here · {lessonMins}-minute video</small>
                  <b>Watch your personal lesson first</b>
                  <span>{quiz.lesson.tutorName || 'Your tutor'} recorded it for you on exactly this topic. Sound on.</span>
                </span>
                <Icon name="arrowRight" size={18} />
              </a>
            )}

            <section className="qp-sum">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: showRefresher ? 10 : 0 }}>
                <h2 style={{ margin: 0 }}><Icon name="idea" size={13} />Two-minute refresher · {quiz.module.title}</h2>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  {showRefresher && hasTranslations && (
                    <div className="seg" role="group" aria-label="Choose explanation language">
                      <button type="button" className={langView === 'en' ? 'on' : ''} onClick={() => setLangView('en')}>English</button>
                      {quiz.allTranslations?.zu && <button type="button" className={langView === 'zu' ? 'on' : ''} onClick={() => setLangView('zu')}>isiZulu</button>}
                      {quiz.allTranslations?.st && <button type="button" className={langView === 'st' ? 'on' : ''} onClick={() => setLangView('st')}>Sesotho</button>}
                      <button type="button" className={langView === 'bi' ? 'on' : ''} onClick={() => setLangView('bi')}>Side-by-side</button>
                    </div>
                  )}
                  <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowRefresher((v) => !v)} aria-expanded={showRefresher}>{showRefresher ? 'Hide' : 'Show'}</button>
                </div>
              </div>
              {showRefresher && (langView === 'en' || langView === 'bi' || !hasTranslations) && (
                <div>
                  {langView === 'bi' && hasTranslations && <span className="mini" style={{ display: 'block', marginBottom: 4 }}>English</span>}
                  <p>{quiz.tutoringSummary}</p>
                  <ul>{quiz.keyPoints.map((k) => <li key={k}><Icon name="check" size={14} />{k}</li>)}</ul>
                </div>
              )}
              {showRefresher && hasTranslations && (langView === 'zu' || langView === 'st' || langView === 'bi') && activeLoc && (
                <div style={langView === 'bi' ? { marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' } : undefined}>
                  <span className="mini" style={{ display: 'block', marginBottom: 4, color: 'var(--accent)' }}>{activeLoc.label} · Home-language refresher</span>
                  <p>{activeLoc.summary}</p>
                  <ul>{activeLoc.keyPoints.map((k) => <li key={k}><Icon name="check" size={14} />{k}</li>)}</ul>
                </div>
              )}
            </section>

            {quiz.resources && quiz.resources.length > 0 && quiz.status !== 'completed' && (
              <section className="qp-sum">
                <h2 style={{ margin: '0 0 10px' }}><Icon name="play" size={13} />Watch and read</h2>
                <ul>
                  {quiz.resources.map((r) => (
                    <li key={r.url}><Icon name={r.kind === 'watch' ? 'play' : 'book'} size={14} /><a href={r.url} target="_blank" rel="noreferrer" style={{ color: 'var(--ink)', fontWeight: 600 }}>{r.label}</a></li>
                  ))}
                </ul>
              </section>
            )}

            <QuizPlayer
              variant="stepper"
              questions={quiz.questions}
              passMark={quiz.passMark}
              initialResult={initial}
              learnerFirst={first}
              lessonHref={quiz.lesson ? `/learn/${quizId}` : undefined}
              submitLabel="Submit my answers"
              note="Your score is saved to your learner record and your tutor has been told."
              onSubmit={async (answers) => {
                const d = (await post(`/api/quiz/${encodeURIComponent(quizId)}/submit`, { answers })) as PublicQuiz;
                return { ...(d.result as NonNullable<PublicQuiz['result']>), questions: d.questions };
              }}
            />
            <p className="qp-foot">{academy} · This link is personal to {quiz.learner.name}.</p>
          </>
        )}
      </main>
    </div>
  );
}
