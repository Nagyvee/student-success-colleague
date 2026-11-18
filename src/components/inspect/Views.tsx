'use client';

import { useState } from 'react';
import type { CatchUpPlan, CheckInMessage, RemedialQuiz } from '@/lib/types';
import { LOCALIZED_BANK } from '@/lib/ai/simulate';
import Icon from '@/components/Icon';
import QuizPlayer, { type PlayResult } from '@/components/QuizPlayer';
import { useQr } from '@/components/side/InboxPanel';

export function CatchUpView({ plan }: { plan: CatchUpPlan }) {
  const gaps = plan.cases.filter((c) => c.cause === 'topic_gap').length;
  return (
    <div className="doc">
      <div className="doc-hero">
        <span className="mini">Catch-up plan · {plan.scope}</span>
        <h3>{plan.cases.length} of {plan.checked} learners need help</h3>
        <p>{plan.summary}</p>
      </div>
      <div className="kv">
        <div><span className="mini">Goal</span><b>{plan.goal}</b></div>
        <div><span className="mini">Topic gaps</span><b>{gaps} · catch-up quiz</b></div>
        <div><span className="mini">Disengaged</span><b>{plan.cases.length - gaps} · personal check-in</b></div>
      </div>
      <table className="plan-t">
        <thead><tr><th>Learner</th><th>Why they are behind</th><th>Action</th></tr></thead>
        <tbody>
          {plan.cases.map((c) => (
            <tr key={c.learner.id}>
              <td style={{ whiteSpace: 'nowrap' }}><b>{c.learner.name}</b><br /><span className="dim" style={{ fontSize: 12 }}>risk {c.riskScore}/100</span></td>
              <td>
                <span className={`badge ${c.cause === 'topic_gap' ? 'badge-warn' : 'badge-soft'}`} style={{ marginBottom: 4 }}>{c.cause === 'topic_gap' ? `Topic gap · ${c.weakModule?.code}` : 'Disengaged'}</span>
                <div style={{ fontSize: 13 }}>{c.why}</div>
                <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>{c.signals.slice(0, 3).join(' · ')}</div>
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>{c.action === 'remedial_quiz' ? 'Catch-up quiz' : 'Check-in'}<br /><span className="dim" style={{ fontSize: 12 }}>{c.owner === 'learning' ? 'Lindiwe' : 'Bongani'}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CheckInView({ m }: { m: CheckInMessage }) {
  if (m.html) {
    // A saved message, voucher or result: shown exactly as it lands in their inbox.
    return (
      <div className="doc">
        <div className="doc-hero">
          <span className="mini">{m.library?.voucherOfferId ? 'Voucher email' : m.library ? 'Saved message' : 'Email'} · to {m.learner.name}{m.learner.email ? ` (${m.learner.email})` : ''}</span>
          <h3>{m.subject}</h3>
        </div>
        <iframe title={`Email to ${m.learner.name}`} srcDoc={m.html} sandbox="" style={{ width: '100%', height: 560, border: '1px solid var(--line, #e2e8f0)', borderRadius: 12, background: '#fff' }} />
        {m.library?.voucherOfferId && <div className="doc-callout"><b>The voucher code</b> is made when you approve, so a rejected voucher never exists.</div>}
      </div>
    );
  }
  const paragraphs = m.body
    .split(/\n{2,}|\r?\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <div className="doc">
      <div className="doc-hero">
        <span className="mini">Personal check-in · to {m.learner.name}</span>
        <h3>{m.subject}</h3>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {(paragraphs.length ? paragraphs : [m.body]).map((p, i) => (
          <p key={i} style={{ fontSize: 15, lineHeight: 1.7, margin: 0, whiteSpace: 'pre-wrap' }}>
            {p}
          </p>
        ))}
      </div>
      <div className="doc-callout is-cta"><b>One small thing:</b> {m.ask}</div>
    </div>
  );
}

export function QuizView({ quiz, baseUrl, dispatched }: { quiz: RemedialQuiz; baseUrl: string; dispatched: boolean }) {
  const link = `${baseUrl}/quiz/${quiz.quizId}`;
  const qr = useQr(dispatched ? link : null);
  const initial: PlayResult | null = quiz.result ? { ...quiz.result, questions: quiz.questions } : null;
  const [langView, setLangView] = useState<'en' | 'zu' | 'st' | 'bi'>(quiz.localizedSummary ? 'bi' : 'en');
  const fallbackTranslations = quiz.allTranslations || LOCALIZED_BANK[quiz.module.code] || LOCALIZED_BANK['JS-07'];
  const activeLoc = langView === 'zu'
    ? fallbackTranslations.zu
    : langView === 'st'
      ? fallbackTranslations.st
      : quiz.localizedSummary || fallbackTranslations.zu;

  return (
    <div className="doc">
      <div className="doc-hero" style={{ display: 'grid', gridTemplateColumns: qr ? '1fr auto' : '1fr', gap: 16, alignItems: 'center' }}>
        <div>
          <span className="mini">Mastery test · {quiz.module.code}</span>
          <h3>{quiz.learner.name} · {quiz.topic}</h3>
          <p>{quiz.questions.length} questions · pass mark {quiz.passMark}% · {quiz.status === 'completed' ? `completed, ${quiz.result?.pct}%` : dispatched ? 'awaiting the learner' : 'not yet dispatched'}</p>
          {dispatched && <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
            <a className="btn btn-cta btn-sm" href={link} target="_blank" rel="noreferrer"><Icon name="external" size={13} />Open the student link</a>
            <span className="dim" style={{ fontSize: 12, alignSelf: 'center' }}>{link}</span>
          </div>}
        </div>
        {qr && <span className="mail-qr" style={{ width: 96, height: 96 }}><img src={qr} alt="QR code for the quiz" /></span>}
      </div>
      <div className="qp-sum">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
          <h2 style={{ margin: 0 }}><Icon name="idea" size={13} />Tutoring summary the learner reads first</h2>
          <div className="seg" role="group" aria-label="Tutor explanation language">
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
            <ul>{quiz.keyPoints.map((k) => <li key={k}><Icon name="check" size={13} />{k}</li>)}</ul>
          </div>
        )}
        {(langView === 'zu' || langView === 'st' || langView === 'bi') && activeLoc && (
          <div style={langView === 'bi' ? { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--line)' } : undefined}>
            <span className="mini" style={{ display: 'block', marginBottom: 4, color: 'var(--accent)' }}>{activeLoc.label} (Local SA Language Breakdown)</span>
            <p>{activeLoc.summary}</p>
            <ul>{activeLoc.keyPoints.map((k) => <li key={k}><Icon name="check" size={13} />{k}</li>)}</ul>
          </div>
        )}
      </div>
      <div>
        <h4><Icon name="play" size={13} />{quiz.status === 'completed' ? 'The learner’s answers' : 'Preview · play it through'}</h4>
        <QuizPlayer
          questions={quiz.questions}
          passMark={quiz.passMark}
          initialResult={initial}
          submitLabel="Grade this preview"
          note={quiz.status === 'completed' ? 'Score synced to the LMS and Student Success notified.' : undefined}
          onSubmit={async (answers) => {
            const score = quiz.questions.reduce((n, q, i) => n + (answers[i] === q.answerIndex ? 1 : 0), 0);
            const pct = Math.round((score / quiz.questions.length) * 100);
            return { score, total: quiz.questions.length, pct, passed: pct >= quiz.passMark, answers, questions: quiz.questions };
          }}
        />
        {quiz.status !== 'completed' && <p className="hint dim" style={{ fontSize: 12, marginTop: 10 }}>This preview grades locally and changes nothing. The learner’s own submission on the student link is what syncs to the LMS.</p>}
      </div>
    </div>
  );
}
