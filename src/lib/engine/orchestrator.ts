import type {
  AgentId, AuditVerdict, Deliverable, DeliverableKind, Dept, FeedActor, FeedLevel, GoalPlan, HeadlineTone, PlanStep, Point, RoomMood, ScenarioId, StageKey, Task, ToolCallLog, Visitor, VisitorKind,
} from '@/lib/types';
import { ROOMS, route, walkDuration } from '@/lib/office/layout';
import {
  announce, bump, getState, log, patchTask, patchVisitor, removeVisitor, setAgent, setBusy, setRoom, setSpotlight, uid, upsertDeliverable, upsertTask, upsertVisitor,
} from './store';
import type { CatchUpPlan, CheckInMessage, RemedialQuiz } from '@/lib/types';
import { writeApproval, writeCritique } from '@/lib/ai/agents';

/* The engine.
 *
 * A scenario is a script of beats. The Ctx gives each beat the verbs it
 * needs: walk, think, say, draft, review, revise, dispatch. Timing lives
 * here: a walk takes as long as its path, a review pauses long enough to be
 * seen, and the model is asked for words while the avatar is still walking,
 * so the office never waits on the network with nothing moving. */

/** The first sentence of a note, short enough for a caption. */
function firstSentence(t: string) {
  const one = t.split(/(?<=\.)\s/)[0].replace(/\.$/, '');
  return one.length > 96 ? `${one.slice(0, 93).trimEnd()}…` : one;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Ctx {
  constructor(public task: Task) {}

  get state() { return getState(); }
  get speed() { return getState().settings.speed; }
  get injectDefects() { return getState().settings.injectDefects; }

  /** Stage pace is deliberately unhurried: a room has to be able to follow it. */
  pace(ms: number) { return Math.round(this.speed === 'fast' ? ms * 0.45 : ms * 1.3); }
  wait(ms: number) { return sleep(this.pace(ms)); }

  step(label: string) {
    this.task.step += 1;
    if (this.task.step > this.task.totalSteps) this.task.totalSteps = this.task.step;
    this.task.stepLabel = label;
    patchTask(this.task.id, { step: this.task.step, totalSteps: this.task.totalSteps, stepLabel: label });
  }

  /** Publish the Planner's plan on the task, so every screen can show it. */
  setPlan(plan: GoalPlan) {
    this.task.plan = plan;
    patchTask(this.task.id, { plan });
  }

  /** Move a plan stage along: todo → doing → done, with what actually happened. */
  stage(key: StageKey, status: PlanStep['status'], result?: string) {
    const plan = this.task.plan;
    if (!plan) return;
    plan.steps = plan.steps.map((s) => (s.key === key ? { ...s, status, ...(result ? { result } : {}) } : s));
    patchTask(this.task.id, { plan: { ...plan, steps: plan.steps } });
  }

  /** A beat of the story, large on the floor. */
  announce(actor: FeedActor, text: string, tone: HeadlineTone = 'info') { announce(actor, text, tone); }

  say(actor: FeedActor, level: FeedLevel, text: string, deliverableId?: string, toolCall?: ToolCallLog) {
    log(actor, level, text, { taskId: this.task.id, deliverableId, toolCall });
  }

  think(id: AgentId, thought: string | null, status: 'thinking' | 'working' | 'idle' | 'reviewing' | 'revising' | 'celebrating' = 'thinking') {
    setAgent(id, { thought, status });
  }

  async walk(id: AgentId, dest: Point, opts: { carrying?: string | null; thought?: string | null } = {}) {
    const a = this.state.agents[id];
    const path = route(a.pos, dest);
    const ms = walkDuration(path, this.speed);
    setAgent(id, { path, walkMs: ms, pos: dest, status: 'walking', carrying: opts.carrying ?? a.carrying, thought: opts.thought === undefined ? null : opts.thought });
    await sleep(ms + 60);
    setAgent(id, { path: null, walkMs: 0, status: 'idle' });
  }

  async home(id: AgentId) {
    const a = this.state.agents[id];
    if (Math.abs(a.pos.x - a.home.x) < 0.5 && Math.abs(a.pos.y - a.home.y) < 0.5) { setAgent(id, { status: 'idle', thought: null, carrying: null, path: null }); return; }
    await this.walk(id, a.home, { carrying: null, thought: null });
    setAgent(id, { thought: null, carrying: null });
  }

  spawnVisitor(kind: VisitorKind, label: string, sub: string | undefined, at: Point): Visitor {
    const v: Visitor = { id: uid('v'), kind, label, sub, pos: at, path: null, walkMs: 0 };
    upsertVisitor(v);
    return v;
  }

  async visitorWalk(v: Visitor, dest: Point) {
    const cur = this.state.visitors.find((x) => x.id === v.id) || v;
    const path = route(cur.pos, dest);
    const ms = walkDuration(path, this.speed);
    patchVisitor(v.id, { path, walkMs: ms, pos: dest });
    await sleep(ms + 60);
    patchVisitor(v.id, { path: null, walkMs: 0 });
  }

  async visitorLeave(v: Visitor, dest: Point) {
    patchVisitor(v.id, { leaving: true });
    await this.visitorWalk(v, dest);
    removeVisitor(v.id);
  }

  room(dept: Dept, mood: RoomMood, caption: string | null = null) { setRoom(dept, mood, caption); }

  /** A packet or alert token has served its purpose. */
  removeToken(id: string) { removeVisitor(id); }

  /* ── Deliverables ─────────────────────────────────────────────────────── */

  draft<T>(kind: DeliverableKind, title: string, subject: string, owner: AgentId, dept: Dept, content: T): Deliverable<T> {
    const d: Deliverable<T> = {
      id: uid('d'), taskId: this.task.id, kind, title, subject, owner, dept, version: 1, status: 'draft',
      content, previous: null, audit: [{ ts: Date.now(), by: owner, verdict: 'submitted', version: 1, notes: [] }],
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    upsertDeliverable(d);
    return d;
  }

  save<T>(d: Deliverable<T>) { upsertDeliverable(d); return d; }

  /** The Reviewer audits a draft where it stands. Returns the verdict and its words. */
  async review<T>(d: Deliverable<T>, verdict: AuditVerdict, opts: { walk?: boolean; holdMs?: number } = {}) {
    const room = ROOMS[d.dept];
    // Ask for the words now, so they are ready when the scan finishes.
    const words = verdict.pass ? writeApproval(d.kind, d.subject, d.content) : writeCritique(d.kind, d.subject, verdict.notes, d.content);
    if (opts.walk !== false) await this.walk('coo', room.review, { carrying: 'Audit clipboard', thought: `Off to ${room.short}: ${d.title} v${d.version} is in.` });
    this.room(d.dept, 'scan', `Reviewing output · ${d.title} v${d.version}`);
    this.think('coo', `Auditing ${d.title} v${d.version} against the rubric…`, 'reviewing');
    d.status = 'under_review';
    this.save(d);
    this.say('coo', 'audit', `Critical review in progress: ${d.title} v${d.version} (${d.subject}).`, d.id);
    this.announce('coo', `Reviewer is checking the ${d.title.toLowerCase()} · ${d.subject}`);
    await this.wait(opts.holdMs ?? 2200);
    const { value: text, viaAi } = await words;
    if (!verdict.pass) {
      d.status = 'rejected';
      d.audit.push({ ts: Date.now(), by: 'coo', verdict: 'fail', version: d.version, notes: verdict.notes });
      this.save(d);
      const badge = d.kind === 'remedial_quiz'
        ? 'A question is off the learner\'s weak topic — revising'
        : d.kind === 'catchup_plan'
          ? 'A diagnosis does not match the LMS marks — revising'
          : `${firstSentence(verdict.notes[0] || 'Critique raised')} — revising`;
      this.room(d.dept, 'amber', `Review: ${badge}`);
      this.think('coo', text, 'reviewing');
      this.announce('coo', `Sent back: ${badge}`, 'bad');
      this.say('coo', 'error', `ERROR SPOTTED in ${d.title} v${d.version}: ${verdict.notes[0]}${verdict.notes.length > 1 ? ` (+${verdict.notes.length - 1} more)` : ''}`, d.id, {
        tool: 'coo.audit_deliverable',
        payload: { deliverableId: d.id, kind: d.kind, version: d.version, dept: d.dept, verdict: 'fail', flaggedIssues: verdict.notes },
      });
      this.say('coo', 'audit', `Critique${viaAi ? '' : ' (rubric)'}: ${text}`, d.id);
      this.task.corrections += 1;
      patchTask(this.task.id, { corrections: this.task.corrections });
      bump('corrections');
      // Stop the line: the mistake is held on screen long enough for a room to read it.
      setSpotlight(caught(d, verdict, this.pace(7000)));
      this.think(d.owner, 'Revising now. Taking the critique line by line…', 'revising');
      await this.wait(5200);
    } else {
      d.status = 'approved';
      d.audit.push({ ts: Date.now(), by: 'coo', verdict: 'pass', version: d.version, notes: [text] });
      this.save(d);
      this.room(d.dept, 'green', `Approved · ${d.title} v${d.version}`);
      this.think('coo', `Approved. ${text}`, 'reviewing');
      this.announce('coo', `${d.title} v${d.version} approved by the Reviewer`, 'good');
      this.say('coo', 'approve', `AUDIT PASSED: ${d.title} v${d.version} approved. ${text}`, d.id, {
        tool: 'coo.audit_deliverable',
        payload: { deliverableId: d.id, kind: d.kind, version: d.version, dept: d.dept, verdict: 'pass', approvedAt: new Date().toISOString() },
      });
      bump('approved');
      if (d.version > 1 && d.previous != null) {
        setSpotlight(fixed(d, this.pace(6000)));
        await this.wait(3600);
      }
      await this.wait(1400);
    }
    return { pass: verdict.pass, text };
  }

  /** The owner resubmits. The new version replaces the old and keeps it for the trail. */
  revise<T>(d: Deliverable<T>, content: T, note: string) {
    d.previous = d.content;
    d.content = content;
    d.version += 1;
    d.status = 'revised';
    d.audit.push({ ts: Date.now(), by: d.owner, verdict: 'revised', version: d.version, notes: [note] });
    this.save(d);
    this.room(d.dept, 'busy', `Revised · ${d.title} v${d.version} resubmitted`);
    this.think(d.owner, `Resubmitted v${d.version}. ${note}`, 'working');
    this.announce(d.owner, `${d.title} corrected · v${d.version} resubmitted for audit`, 'warn');
    this.say(d.owner, 'fix', `Self-correction: ${d.title} v${d.version} resubmitted. ${note}`, d.id, {
      tool: `${d.owner}.revise_deliverable`,
      payload: { deliverableId: d.id, version: d.version, changesApplied: note },
    });
    return d;
  }

  dispatch<T>(d: Deliverable<T>) {
    d.status = 'dispatched';
    this.save(d);
    bump('dispatched');
  }

  calm(dept: Dept) { this.room(dept, 'calm', null); }
}

/* ── Running ──────────────────────────────────────────────────────────────── */

export type Script = (ctx: Ctx) => Promise<void>;

export function startScenario(id: ScenarioId, title: string, subject: string, totalSteps: number, script: Script): Task | null {
  const s = getState();
  if (s.busy) return null;
  const task: Task = {
    id: uid('t'), scenario: id, title, subject, status: 'running', step: 0, totalSteps, stepLabel: 'Starting',
    startedAt: Date.now(), endedAt: null, deliverableIds: [], corrections: 0,
  };
  setBusy(id);
  upsertTask(task);
  const ctx = new Ctx(task);
  void (async () => {
    try {
      await script(ctx);
      patchTask(task.id, { status: 'done', endedAt: Date.now(), step: task.totalSteps, stepLabel: 'Complete' });
      bump('processed');
    } catch (e) {
      console.error('[student-success] scenario failed', e);
      log('system', 'error', `The ${title} run stopped: ${(e as Error)?.message || 'unknown error'}. Agents returning to their desks.`, { taskId: task.id });
      patchTask(task.id, { status: 'failed', endedAt: Date.now(), stepLabel: 'Stopped' });
    } finally {
      await settle(ctx);
      setBusy(null);
    }
  })();
  return task;
}

/** Everyone back at their desk, every room calm, every visitor gone. */
async function settle(ctx: Ctx) {
  const s = getState();
  for (const v of s.visitors) removeVisitor(v.id);
  for (const dept of Object.keys(ROOMS) as Dept[]) ctx.calm(dept);
  const ids = Object.keys(s.agents) as AgentId[];
  await Promise.all(ids.map((id) => ctx.home(id)));
  for (const id of ids) setAgent(id, { status: 'idle', thought: null, carrying: null, path: null });
}

/* ── The spotlight: what the Reviewer caught, and how it was fixed ─────────── */

const clip = (t: string, n = 170) => { const x = t.replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x; };

function caught<T>(d: Deliverable<T>, verdict: AuditVerdict, holdMs: number) {
  const bad = (verdict as AuditVerdict & { badIds?: string[] }).badIds || [];
  let rule = 'Every output must pass the Reviewer\'s checks before a learner sees it';
  let before: string | null = null;
  if (d.kind === 'remedial_quiz') {
    const q = d.content as unknown as RemedialQuiz;
    rule = `Every question must test the learner's weak topic: ${q.module.code} · ${q.topic}`;
    const hit = q.questions.find((x) => bad.includes(x.id));
    before = hit ? `Q${q.questions.indexOf(hit) + 1}: ${clip(hit.prompt, 140)}` : null;
  } else if (d.kind === 'catchup_plan') {
    rule = 'Every diagnosis must match the learner\'s marks in the LMS';
    const p = d.content as unknown as CatchUpPlan;
    const c = p.cases.find((x) => verdict.notes[0]?.includes(x.learner.name.split(' ')[0]));
    before = c ? `${c.learner.name}: ${c.cause === 'topic_gap' ? 'topic gap' : 'disengaged'} → ${c.action === 'remedial_quiz' ? 'catch-up quiz' : 'check-in'}` : null;
  } else if (d.kind === 'checkin_message') {
    rule = 'A check-in must sound like a person: no labels, under 140 words, one small ask';
    before = clip((d.content as unknown as CheckInMessage).body, 140);
  }
  return { id: uid('sp'), ts: Date.now(), kind: 'caught' as const, owner: d.owner, title: d.title, subject: d.subject, rule, problem: clip(verdict.notes[0] || 'Failed review', 200), before, after: null, holdMs };
}

function fixed<T>(d: Deliverable<T>, holdMs: number) {
  let before: string | null = null;
  let after: string | null = null;
  if (d.kind === 'remedial_quiz') {
    const prev = d.previous as unknown as RemedialQuiz; const cur = d.content as unknown as RemedialQuiz;
    const i = cur.questions.findIndex((q, k) => q.prompt !== prev.questions[k]?.prompt);
    if (i >= 0) { before = `Q${i + 1}: ${clip(prev.questions[i].prompt, 140)}`; after = `Q${i + 1}: ${clip(cur.questions[i].prompt, 140)}`; }
  } else if (d.kind === 'checkin_message') {
    before = clip((d.previous as unknown as CheckInMessage).body, 120); after = clip((d.content as unknown as CheckInMessage).body, 120);
  } else if (d.kind === 'catchup_plan') {
    const prev = d.previous as unknown as CatchUpPlan; const cur = d.content as unknown as CatchUpPlan;
    const c = cur.cases.find((x, k) => x.cause !== prev.cases[k]?.cause);
    const o = c ? prev.cases.find((x) => x.learner.id === c.learner.id) : null;
    if (c && o) { before = `${o.learner.name}: ${o.cause === 'topic_gap' ? 'topic gap' : 'disengaged'}`; after = `${c.learner.name}: ${c.cause === 'topic_gap' ? 'topic gap' : 'disengaged'}`; }
  }
  return { id: uid('sp'), ts: Date.now(), kind: 'fixed' as const, owner: d.owner, title: d.title, subject: d.subject, rule: 'Re-checked against the same rule', problem: `Version ${d.version} passed every check`, before, after, holdMs };
}
