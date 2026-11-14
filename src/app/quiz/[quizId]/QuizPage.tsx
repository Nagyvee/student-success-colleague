'use client';

import { useEffect, useState } from 'react';
import Logo from '@/components/Logo';
import Icon from '@/components/Icon';
import QuizPlayer, { type PlayResult, type PlayableQuestion } from '@/components/QuizPlayer';
import { post } from '@/hooks/useOfficeStream';

/* The student's page. Phone first, no sign-in, nothing to install:
 * read the refresher, answer three questions, see the result at once. */

interface LocalizedTutoring { language: 'zu' | 'st'; label: string; summary: string; keyPoints: string[] }

interface PublicQuiz {
  quizId: string; status: 'pending' | 'completed'; dispatched: boolean;
  learner: { name: string }; module: { code: string; title: string }; topic: string;
  tutoringSummary: string; keyPoints: string[];
  localizedSummary?: LocalizedTutoring | null;
  allTranslations?: Record<'zu' | 'st', LocalizedTutoring>;
  passMark: number; questions: PlayableQuestion[];
  resources?: { label: string; url: string; kind: 'read' | 'watch' }[];
  lesson?: { title: string; slides: unknown[] } | null;
  result: { score: number; total: number; pct: number; passed: boolean; answers: number[] } | null;
}

export default function QuizPage({ quizId }: { quizId: string }) {
  const [quiz, setQuiz] = useState<PublicQuiz | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [langView, setLangView] = useState<'en' | 'zu' | 'st' | 'bi'>('en');

  useEffect(() => {
    fetch(`/api/quiz/${encodeURIComponent(quizId)}`, { cache: 'no-store' })
      .then(async (r) => {
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Not found');
        const q = d as PublicQuiz;
        setQuiz(q);
        if (q.localizedSummary) setLangView('bi');
      })
      .catch((e) => setErr((e as Error).message));
  }, [quizId]);

  const activeLoc = langView === 'zu'
    ? quiz?.allTranslations?.zu
    : langView === 'st'
      ? quiz?.allTranslations?.st
      : quiz?.localizedSummary || quiz?.allTranslations?.zu;

  const first = quiz?.learner.name.split(' ')[0];
  const initial: PlayResult | null = quiz?.result ? { ...quiz.result, questions: quiz.questions } : null;

  return (
    <div className="qp">
      <header className="qp-top">
        <Logo word="Thuso" size="sm" />
        <span className="mini" style={{ color: 'rgba(255,255,255,.7)' }}>Your study pack</span>
      </header>
      <main className="qp-wrap">
        {err && <div className="qp-hero"><h1>We could not find that quiz</h1><p>{err} If you reached this from an email, the link may have been for a demo session that has since been reset.</p></div>}
        {!quiz && !err && <div className="qp-hero"><p className="dim">Loading your quiz…</p></div>}
        {quiz && (
          <>
            <section className="qp-hero">
              <div className="qp-chips">
                <span className="badge badge-soft">{quiz.module.code}</span>
                <span className="badge badge-cta">{quiz.topic}</span>
                <span className="badge badge-mute">{quiz.questions.length} questions · about 5 minutes</span>
              </div>
              <h1>{first}, this one topic is standing between you and the rest of {quiz.module.code}.</h1>
              {quiz.lesson && <p style={{ margin: '0 0 10px' }}><a className="btn btn-cta btn-sm" href={`/learn/${quizId}`}><Icon name="play" size={13} />Watch your lesson first ({quiz.lesson.slides.length} slides)</a></p>}
              <p>Your tutor wrote a two-minute refresher on <b>{quiz.topic}</b> and three questions on exactly that. Pass mark is {quiz.passMark}%. Your learner record updates the moment you submit.</p>
            </section>
            <section className="qp-sum">
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                <h2 style={{ margin: 0 }}><Icon name="idea" size={13} />Two-minute refresher · {quiz.module.title}</h2>
                <div className="seg" role="group" aria-label="Choose explanation language">
                  <button type="button" className={langView === 'en' ? 'on' : ''} onClick={() => setLangView('en')}>English</button>
                  <button type="button" className={langView === 'zu' ? 'on' : ''} onClick={() => setLangView('zu')}>isiZulu</button>
                  <button type="button" className={langView === 'st' ? 'on' : ''} onClick={() => setLangView('st')}>Sesotho</button>
                  <button type="button" className={langView === 'bi' ? 'on' : ''} onClick={() => setLangView('bi')}>Side-by-side</button>
                </div>
              </div>
              {(langView === 'en' || langView === 'bi') && (
                <div>
                  {langView === 'bi' && <span className="mini" style={{ display: 'block', marginBottom: 4 }}>English</span>}
                  <p>{quiz.tutoringSummary}</p>
                  <ul>{quiz.keyPoints.map((k) => <li key={k}><Icon name="check" size={14} />{k}</li>)}</ul>
                </div>
              )}
              {(langView === 'zu' || langView === 'st' || langView === 'bi') && activeLoc && (
                <div style={langView === 'bi' ? { marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line)' } : undefined}>
                  <span className="mini" style={{ display: 'block', marginBottom: 4, color: 'var(--accent)' }}>{activeLoc.label} · Home-Language Refresher</span>
                  <p>{activeLoc.summary}</p>
                  <ul>{activeLoc.keyPoints.map((k) => <li key={k}><Icon name="check" size={14} />{k}</li>)}</ul>
                </div>
              )}
            </section>
            {quiz.resources && quiz.resources.length > 0 && (
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
              questions={quiz.questions}
              passMark={quiz.passMark}
              initialResult={initial}
              submitLabel="Submit my answers"
              note="Your score has been synced to the LMS and your Student Success agent has been told."
              onSubmit={async (answers) => {
                const d = (await post(`/api/quiz/${encodeURIComponent(quizId)}/submit`, { answers })) as PublicQuiz;
                return { ...(d.result as NonNullable<PublicQuiz['result']>), questions: d.questions };
              }}
            />
            <p className="qp-foot">the academy · The Home of Global Talent · This link is personal to {quiz.learner.name}.</p>
          </>
        )}
      </main>
    </div>
  );
}
