'use client';

import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import Icon from './Icon';

/* The test a learner actually clicks through.
 *
 * Two layouts. "stepper" is the learner's page: one question at a time, a
 * progress bar, back and next, a review screen before submitting, and a
 * results screen with every explanation. "list" is the staff inspector: all
 * questions at once, graded locally. Both work for any number of questions. */

export interface PlayableQuestion { id: string; prompt: string; options: string[]; topicTag?: string; answerIndex?: number; explanation?: string }
export interface PlayResult { score: number; total: number; pct: number; passed: boolean; answers: number[]; questions: PlayableQuestion[] }

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

/** A question prompt with `inline code` and fenced-off code lines kept readable. */
export function RichText({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);
  return (
    <>
      {blocks.map((b, k) => {
        const looksCode = b.includes('\n') || /^[\s]*(const|let|var|function|SELECT|import|def |console\.|<\w)/.test(b);
        if (looksCode && k > 0) return <pre key={k} className="mt-code">{b}</pre>;
        const parts = b.split(/(`[^`]+`)/g);
        return (
          <span key={k} className="mt-p">
            {parts.map((p, j) => (p.startsWith('`') && p.endsWith('`') && p.length > 2 ? <code key={j}>{p.slice(1, -1)}</code> : <Fragment key={j}>{p}</Fragment>))}
          </span>
        );
      })}
    </>
  );
}

export default function QuizPlayer({
  questions, passMark, initialResult = null, onSubmit, submitLabel = 'Submit answers', note,
  variant = 'list', lessonHref, learnerFirst,
}: {
  questions: PlayableQuestion[]; passMark: number; initialResult?: PlayResult | null;
  onSubmit: (answers: number[]) => Promise<PlayResult>; submitLabel?: string; note?: string;
  variant?: 'list' | 'stepper'; lessonHref?: string; learnerFirst?: string;
}) {
  if (variant === 'stepper') {
    return <Stepper questions={questions} passMark={passMark} initialResult={initialResult} onSubmit={onSubmit} submitLabel={submitLabel} note={note} lessonHref={lessonHref} learnerFirst={learnerFirst} />;
  }
  return <ListQuiz questions={questions} passMark={passMark} initialResult={initialResult} onSubmit={onSubmit} submitLabel={submitLabel} note={note} />;
}

/* ── the learner's stepper ─────────────────────────────────────────────── */

function Stepper({ questions, passMark, initialResult, onSubmit, submitLabel, note, lessonHref, learnerFirst }: {
  questions: PlayableQuestion[]; passMark: number; initialResult: PlayResult | null;
  onSubmit: (answers: number[]) => Promise<PlayResult>; submitLabel: string; note?: string; lessonHref?: string; learnerFirst?: string;
}) {
  const n = questions.length;
  const [answers, setAnswers] = useState<number[]>(initialResult?.answers || Array(n).fill(-1));
  const [cur, setCur] = useState<number | 'review'>(0);
  const [result, setResult] = useState<PlayResult | null>(initialResult);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answered = answers.filter((a) => a >= 0).length;
  const complete = answered === n;

  const choose = useCallback((qi: number, oi: number) => {
    if (result || busy) return;
    const wasBlank = answers[qi] < 0;
    setAnswers((a) => a.map((x, i) => (i === qi ? oi : x)));
    // Move on by itself the first time a question is answered; changing an answer stays put.
    if (wasBlank) setTimeout(() => setCur((c) => (c === qi ? (qi + 1 < n ? qi + 1 : 'review') : c)), 380);
  }, [answers, busy, n, result]);

  async function submit() {
    if (!complete) return;
    setBusy(true); setErr(null);
    try { setResult(await onSubmit(answers)); window.scrollTo({ top: 0, behavior: 'smooth' }); }
    catch (e) { setErr((e as Error).message || 'Could not submit. Check your connection and try again.'); }
    finally { setBusy(false); }
  }

  useEffect(() => {
    if (result) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest('input,textarea,select')) return;
      if (cur === 'review') {
        if (e.key === 'ArrowLeft') setCur(n - 1);
        if (e.key === 'Enter' && complete) void submit();
        return;
      }
      const q = questions[cur];
      const k = e.key.toLowerCase();
      const byNum = Number(k) - 1;
      const byLetter = LETTERS.map((l) => l.toLowerCase()).indexOf(k);
      const idx = byNum >= 0 && byNum < q.options.length ? byNum : byLetter >= 0 && byLetter < q.options.length ? byLetter : -1;
      if (idx >= 0) { e.preventDefault(); choose(cur, idx); }
      else if ((e.key === 'Enter' || e.key === 'ArrowRight') && answers[cur] >= 0) setCur(cur + 1 < n ? cur + 1 : 'review');
      else if (e.key === 'ArrowLeft' && cur > 0) setCur(cur - 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (result) return <Results result={result} passMark={passMark} note={note} lessonHref={lessonHref} learnerFirst={learnerFirst} />;

  const pct = Math.round((answered / Math.max(1, n)) * 100);
  return (
    <section className="mt-shell" aria-label="Your test">
      <div className="mt-progress">
        <div className="mt-progress-top">
          <b>{cur === 'review' ? 'Review your answers' : `Question ${cur + 1} of ${n}`}</b>
          <span>{answered}/{n} answered</span>
        </div>
        <div className="mt-bar" role="progressbar" aria-valuemin={0} aria-valuemax={n} aria-valuenow={answered}><i style={{ width: `${pct}%` }} /></div>
        <div className="mt-dots">
          {questions.map((q, k) => (
            <button key={q.id} type="button" className={`mt-dot${answers[k] >= 0 ? ' is-done' : ''}${cur === k ? ' is-now' : ''}`} onClick={() => setCur(k)} aria-label={`Question ${k + 1}${answers[k] >= 0 ? ', answered' : ''}`}>{k + 1}</button>
          ))}
          <button type="button" className={`mt-dot mt-dot--review${cur === 'review' ? ' is-now' : ''}`} onClick={() => setCur('review')} aria-label="Review answers"><Icon name="list" size={13} /></button>
        </div>
      </div>

      {cur !== 'review' ? (
        <div className="mt-card" key={questions[cur].id}>
          {questions[cur].topicTag && <span className="mt-tag">{questions[cur].topicTag}</span>}
          <h2 className="mt-prompt"><RichText text={questions[cur].prompt} /></h2>
          <div className="mt-opts" role="radiogroup" aria-label={`Question ${cur + 1}`}>
            {questions[cur].options.map((o, oi) => (
              <button
                key={oi}
                type="button"
                role="radio"
                aria-checked={answers[cur] === oi}
                className={`mt-opt${answers[cur] === oi ? ' is-on' : ''}`}
                onClick={() => choose(cur as number, oi)}
              >
                <i>{LETTERS[oi]}</i>
                <span><RichText text={o} /></span>
              </button>
            ))}
          </div>
          <div className="mt-nav">
            <button type="button" className="mt-btn mt-btn--ghost" onClick={() => setCur(Math.max(0, (cur as number) - 1))} disabled={cur === 0}><Icon name="arrowLeft" size={15} />Back</button>
            <span className="mt-hint">Tip: press 1 to {questions[cur].options.length} to choose</span>
            <button type="button" className="mt-btn mt-btn--primary" onClick={() => setCur((cur as number) + 1 < n ? (cur as number) + 1 : 'review')} disabled={answers[cur] < 0}>
              {(cur as number) + 1 < n ? 'Next' : 'Review'}<Icon name="arrowRight" size={15} />
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-card mt-review">
          <h2>{complete ? `All ${n} answered. Ready?` : `${n - answered} still to answer`}</h2>
          <p>{complete ? `Check anything you are unsure about, then submit. Pass mark is ${passMark}%, and grading is instant.` : 'Tap a number to jump back to it.'}</p>
          <div className="mt-grid">
            {questions.map((q, k) => (
              <button key={q.id} type="button" className={`mt-cell${answers[k] >= 0 ? ' is-done' : ''}`} onClick={() => setCur(k)}>
                <b>{k + 1}</b><span>{answers[k] >= 0 ? `Answer ${LETTERS[answers[k]]}` : 'Not answered'}</span>
              </button>
            ))}
          </div>
          <div className="mt-nav">
            <button type="button" className="mt-btn mt-btn--ghost" onClick={() => setCur(n - 1)}><Icon name="arrowLeft" size={15} />Back</button>
            <button type="button" className="mt-btn mt-btn--cta" disabled={!complete || busy} onClick={submit}>
              {busy ? <Icon name="spinner" size={16} className="spin" /> : <Icon name="send" size={16} />}{submitLabel}
            </button>
          </div>
          {err && <p className="mt-err" role="alert">{err}</p>}
        </div>
      )}
    </section>
  );
}

function Results({ result, passMark, note, lessonHref, learnerFirst }: { result: PlayResult; passMark: number; note?: string; lessonHref?: string; learnerFirst?: string }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const missed = useMemo(() => result.questions.map((q, i) => ({ q, i, chosen: result.answers[i] })).filter((x) => typeof x.q.answerIndex === 'number' && x.chosen !== x.q.answerIndex), [result]);
  const who = learnerFirst ? `, ${learnerFirst}` : '';
  return (
    <section className="mt-shell" aria-label="Your result">
      <div className={`mt-result${result.passed ? ' is-pass' : ' is-fail'}`}>
        <svg className="mt-ring" viewBox="0 0 110 110" aria-hidden="true">
          <circle cx="55" cy="55" r={r} className="mt-ring-bg" />
          <circle cx="55" cy="55" r={r} className="mt-ring-fg" strokeDasharray={`${(result.pct / 100) * c} ${c}`} />
          <text x="55" y="53" textAnchor="middle" className="mt-ring-pct">{result.pct}%</text>
          <text x="55" y="72" textAnchor="middle" className="mt-ring-sub">{result.score} of {result.total}</text>
        </svg>
        <div className="mt-result-body">
          {result.passed ? (
            <>
              <h2>You passed{who}! That topic is yours now.</h2>
              <p>{result.pct}% against a {passMark}% pass mark.</p>
              <span className="mt-status"><Icon name="badgeCheck" size={15} />Status updated: On Track</span>
            </>
          ) : (
            <>
              <h2>Not yet{who}, and that is fine.</h2>
              <p>{result.pct}% against a {passMark}% pass mark. This shows us exactly where to help, and we will.</p>
              <ul className="mt-next">
                {lessonHref && <li><Icon name="play" size={14} /><a href={lessonHref}>Rewatch your lesson</a>, starting with what you missed</li>}
                <li><Icon name="book" size={14} />Read the {missed.length} explanation{missed.length === 1 ? '' : 's'} below</li>
                <li><Icon name="users" size={14} />Your tutor will set up a 20-minute catch-up. Reply to the email with a time that suits you</li>
              </ul>
            </>
          )}
          {note && <div className="mt-sync"><Icon name="ok" size={14} />{note}</div>}
        </div>
        {result.passed && <div className="mt-confetti" aria-hidden="true">{Array.from({ length: 14 }, (_, k) => <i key={k} />)}</div>}
      </div>

      <div className="mt-answers">
        <h3>Every question, explained</h3>
        {result.questions.map((q, i) => {
          const chosen = result.answers[i];
          const known = typeof q.answerIndex === 'number';
          const right = known && chosen === q.answerIndex;
          return (
            <details key={q.id} className={`mt-ans${known ? (right ? ' is-right' : ' is-wrong') : ''}`} open={known && !right}>
              <summary>
                <span className="mt-ans-mark">{known ? (right ? <Icon name="check" size={13} strokeWidth={3} /> : <Icon name="x" size={13} strokeWidth={3} />) : i + 1}</span>
                <span className="mt-ans-q"><RichText text={q.prompt.split('\n')[0]} /></span>
              </summary>
              <div className="mt-ans-body">
                {q.prompt.includes('\n') && <div className="mt-prompt-full"><RichText text={q.prompt} /></div>}
                {chosen >= 0 && <p><small>Your answer</small>{LETTERS[chosen]}. <RichText text={q.options[chosen] || ''} /></p>}
                {known && !right && <p><small>Correct answer</small>{LETTERS[q.answerIndex as number]}. <RichText text={q.options[q.answerIndex as number] || ''} /></p>}
                {q.explanation && <p className="mt-why"><RichText text={q.explanation} /></p>}
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

/* ── the staff inspector: every question at once ───────────────────────── */

function ListQuiz({ questions, passMark, initialResult, onSubmit, submitLabel, note }: {
  questions: PlayableQuestion[]; passMark: number; initialResult: PlayResult | null;
  onSubmit: (answers: number[]) => Promise<PlayResult>; submitLabel: string; note?: string;
}) {
  const [answers, setAnswers] = useState<number[]>(initialResult?.answers || Array(questions.length).fill(-1));
  const [result, setResult] = useState<PlayResult | null>(initialResult);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const qs = result?.questions || questions;
  const complete = answers.every((a) => a >= 0);

  async function submit() {
    setBusy(true); setErr(null);
    try { setResult(await onSubmit(answers)); }
    catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <div className="quiz">
      {result && (
        <div className={`qresult${result.passed ? '' : ' is-fail'}`}>
          <div className="qscore">{result.score}<small>/{result.total}</small></div>
          <div>
            <b style={{ fontSize: 15 }}>{result.passed ? 'Passed. That topic is yours now.' : 'Not yet, and that is fine.'}</b>
            <p>{result.passed
              ? `${result.pct}% against a ${passMark}% pass mark. Read the explanations below anyway: they are where the understanding sticks.`
              : `${result.pct}% against a ${passMark}% pass mark. Your tutor is booking a 20-minute 1:1 on exactly this topic. Read the explanations below first.`}</p>
            {note && <div className="qsync"><Icon name="badgeCheck" size={14} />{note}</div>}
          </div>
        </div>
      )}
      {qs.map((q, qi) => {
        const chosen = answers[qi];
        const graded = result && typeof q.answerIndex === 'number';
        const right = graded && chosen === q.answerIndex;
        return (
          <div key={q.id} className={`qcard${graded ? (right ? ' is-right' : ' is-wrong') : ''}`}>
            <div className="qhead">
              <b>{q.prompt}</b>
              <span className="qnum">{qi + 1}</span>
            </div>
            {q.topicTag && <div className="mini" style={{ marginBottom: 8 }}>{q.topicTag}</div>}
            <div className="opts" role="radiogroup" aria-label={`Question ${qi + 1}`}>
              {q.options.map((o, oi) => {
                const cls = ['opt'];
                if (!graded && chosen === oi) cls.push('on');
                if (graded && oi === q.answerIndex) cls.push('is-correct');
                if (graded && chosen === oi && oi !== q.answerIndex) cls.push('is-chosen-wrong');
                return (
                  <button key={oi} type="button" role="radio" aria-checked={chosen === oi} className={cls.join(' ')} disabled={Boolean(result) || busy}
                    onClick={() => setAnswers((a) => a.map((x, i) => (i === qi ? oi : x)))}>
                    <i>{graded && oi === q.answerIndex ? <Icon name="check" size={11} strokeWidth={3} /> : graded && chosen === oi ? <Icon name="x" size={11} strokeWidth={3} /> : LETTERS[oi]}</i>
                    <span>{o}</span>
                  </button>
                );
              })}
            </div>
            {graded && q.explanation && <p className="qexp"><b>{right ? 'Correct. ' : 'The answer is ' + LETTERS[q.answerIndex as number] + '. '}</b>{q.explanation}</p>}
          </div>
        );
      })}
      {!result && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-cta btn-lg" disabled={!complete || busy} onClick={submit}>
            {busy ? <Icon name="spinner" size={16} className="spin" /> : <Icon name="send" size={16} />}{submitLabel}
          </button>
          <span className="dim" style={{ fontSize: 12.5 }}>{complete ? `Pass mark ${passMark}%. Grading is instant.` : `${answers.filter((a) => a >= 0).length} of ${questions.length} answered`}</span>
          {err && <span style={{ color: 'var(--bad-ink)', fontSize: 12.5, fontWeight: 600 }}>{err}</span>}
        </div>
      )}
    </div>
  );
}
