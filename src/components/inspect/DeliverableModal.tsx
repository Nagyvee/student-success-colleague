'use client';

import { useState } from 'react';
import type { CatchUpPlan, CheckInMessage, Deliverable, RemedialQuiz, WorldState } from '@/lib/types';
import { AGENT_BY_ID } from '@/lib/office/layout';
import Icon from '@/components/Icon';
import { KIND_ICON, KIND_LABEL, StatusBadge } from '@/components/side/DeliverablesPanel';
import { CatchUpView, CheckInView, QuizView } from './Views';

/* The finished artifact, as the audience would see it: the plan, the
 * check-in or the quiz you can actually click through, with the Reviewer's
 * audit trail and the version it sent back beside it. */

type Tab = 'doc' | 'trail' | 'diff';

export default function DeliverableModal({ deliverable: d, state, onClose }: { deliverable: Deliverable; state: WorldState; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('doc');
  const owner = AGENT_BY_ID[d.owner];
  const fails = d.audit.filter((a) => a.verdict === 'fail').length;
  return (
    <div className="gate" onClick={onClose}>
      <div className="gate-card" role="dialog" aria-modal="true" aria-labelledby="dl-title" onClick={(e) => e.stopPropagation()}>
        <div className="gate-head">
          <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start', minWidth: 0 }}>
            <span style={{ color: 'var(--accent)', marginTop: 2 }}><Icon name={KIND_ICON[d.kind]} size={26} strokeWidth={1.7} /></span>
            <div style={{ minWidth: 0 }}>
              <h2 id="dl-title">{KIND_LABEL[d.kind]} · {d.subject}</h2>
              <p className="gate-sub">
                <StatusBadge status={d.status} />
                <span>v{d.version}</span>
                <span>· by {owner.name}, {owner.title.split('·')[0].trim()}</span>
                {fails > 0 && <span>· {fails} correction{fails === 1 ? '' : 's'} by the Reviewer</span>}
                <span>· {new Date(d.updatedAt).toLocaleString('en-ZA', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</span>
              </p>
            </div>
          </div>
          <button type="button" className="iconbtn" onClick={onClose} aria-label="Close"><Icon name="x" size={18} /></button>
        </div>
        <div className="gate-tabwrap">
          <div className="gate-tabs">
            <button type="button" className={tab === 'doc' ? 'on' : ''} onClick={() => setTab('doc')}><Icon name="file" size={13} />Deliverable</button>
            <button type="button" className={tab === 'trail' ? 'on' : ''} onClick={() => setTab('trail')}><Icon name="shield" size={13} />Review trail<span className="badge badge-mute" style={{ marginLeft: 2 }}>{d.audit.length}</span></button>
            {d.previous != null && <button type="button" className={tab === 'diff' ? 'on' : ''} onClick={() => setTab('diff')}><Icon name="layers" size={13} />What changed</button>}
          </div>
        </div>
        <div className="gate-body">
          {tab === 'doc' && <Doc d={d} baseUrl={state.caps.baseUrl} />}
          {tab === 'trail' && <Trail d={d} />}
          {tab === 'diff' && <Diff d={d} />}
        </div>
      </div>
    </div>
  );
}

function Doc({ d, baseUrl }: { d: Deliverable; baseUrl: string }) {
  switch (d.kind) {
    case 'catchup_plan': return <CatchUpView plan={d.content as CatchUpPlan} />;
    case 'checkin_message':
    case 'agent_message': return <CheckInView m={d.content as CheckInMessage} />;
    case 'remedial_quiz': return <QuizView quiz={d.content as RemedialQuiz} baseUrl={baseUrl} dispatched={d.status === 'dispatched'} />;
  }
}

function Trail({ d }: { d: Deliverable }) {
  const icon = { submitted: 'file', pass: 'badgeCheck', fail: 'warn', revised: 'wrench' } as const;
  const label = { submitted: 'Draft submitted', pass: 'Review passed', fail: 'Review failed · sent back', revised: 'Revised and resubmitted' };
  return (
    <div className="trail">
      {d.audit.map((a, i) => {
        const by = AGENT_BY_ID[a.by];
        return (
          <div key={i} className="trail-item">
            <span className={`trail-ico is-${a.verdict}`}><Icon name={icon[a.verdict]} size={18} /></span>
            <div className="trail-body">
              <b>{label[a.verdict]} · v{a.version}</b>
              <span>{by.name}, {by.title.split('·')[0].trim()} · {new Date(a.ts).toLocaleTimeString('en-ZA')}</span>
              {a.notes.length > 0 && <ul>{a.notes.map((n, j) => <li key={j}>{n}</li>)}</ul>}
            </div>
          </div>
        );
      })}
      {d.status === 'dispatched' && (
        <div className="trail-item">
          <span className="trail-ico is-pass"><Icon name="send" size={18} /></span>
          <div className="trail-body"><b>Sent</b><span>The approved version reached the learner.</span></div>
        </div>
      )}
    </div>
  );
}

function Diff({ d }: { d: Deliverable }) {
  if (d.kind === 'remedial_quiz') {
    const prev = d.previous as RemedialQuiz; const cur = d.content as RemedialQuiz;
    return (
      <div className="doc">
        {cur.questions.map((q, i) => {
          const old = prev.questions[i];
          if (!old || old.prompt === q.prompt) return null;
          return (
            <div key={q.id} className="diff">
              <div className="is-old"><span className="mini" style={{ color: 'var(--bad-ink)' }}>Rejected · Q{i + 1} · {old.topicTag}</span><b style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{old.prompt}</b></div>
              <div className="is-new"><span className="mini" style={{ color: 'var(--good-ink)' }}>Approved · Q{i + 1} · {q.topicTag}</span><b style={{ fontSize: 13.5, whiteSpace: 'pre-wrap' }}>{q.prompt}</b></div>
            </div>
          );
        })}
      </div>
    );
  }
  if (d.kind === 'checkin_message' || d.kind === 'agent_message') {
    const prev = d.previous as CheckInMessage; const cur = d.content as CheckInMessage;
    return (
      <div className="diff">
        <div className="is-old"><span className="mini" style={{ color: 'var(--bad-ink)' }}>Rejected · v{d.version - 1}</span><p style={{ fontSize: 13.5, margin: 0 }}>{prev.body}</p></div>
        <div className="is-new"><span className="mini" style={{ color: 'var(--good-ink)' }}>Approved · v{d.version}</span><p style={{ fontSize: 13.5, margin: 0 }}>{cur.body}</p></div>
      </div>
    );
  }
  if (d.kind === 'catchup_plan') {
    const prev = d.previous as CatchUpPlan; const cur = d.content as CatchUpPlan;
    return (
      <div className="diff">
        <div className="is-old"><span className="mini" style={{ color: 'var(--bad-ink)' }}>Rejected · v{d.version - 1}</span><ul className="chk">{prev.cases.map((c) => <li key={c.learner.id}>{c.learner.name} · {c.cause.replace('_', ' ')}</li>)}</ul></div>
        <div className="is-new"><span className="mini" style={{ color: 'var(--good-ink)' }}>Approved · v{d.version}</span><ul className="chk">{cur.cases.map((c) => <li key={c.learner.id}>{c.learner.name} · {c.cause.replace('_', ' ')}</li>)}</ul></div>
      </div>
    );
  }
  return <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{JSON.stringify(d.previous, null, 2)}</pre>;
}
