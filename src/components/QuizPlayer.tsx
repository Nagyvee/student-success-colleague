'use client';

import { useState } from 'react';
import Icon from './Icon';

/* The quiz a learner actually clicks through.
 *
 * The same component plays in the inspector (answers known, graded locally)
 * and on the student page (answers unknown, graded by the server). */

export interface PlayableQuestion { id: string; prompt: string; options: string[]; topicTag?: string; answerIndex?: number; explanation?: string }
export interface PlayResult { score: number; total: number; pct: number; passed: boolean; answers: number[]; questions: PlayableQuestion[] }

const LETTERS = ['A', 'B', 'C', 'D', 'E'];

export default function QuizPlayer({ questions, passMark, initialResult = null, onSubmit, submitLabel = 'Submit answers', note }: {
  questions: PlayableQuestion[]; passMark: number; initialResult?: PlayResult | null;
  onSubmit: (answers: number[]) => Promise<PlayResult>; submitLabel?: string; note?: string;
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
