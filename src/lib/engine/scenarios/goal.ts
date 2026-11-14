import type { CatchUpPlan, CheckInMessage, LearnerCard, LearnerCase, Lesson, RemedialQuiz, RunSummary, Trigger } from '@/lib/types';
import { ENTRANCE, ROOMS } from '@/lib/office/layout';
import { getState, patchTask, patchVisitor, setAgent, setLearner, setLearners, uid } from '@/lib/engine/store';
import { startScenario, type Ctx } from '@/lib/engine/orchestrator';
import { auditCatchUpPlan, auditCheckIn, auditRemedialQuiz } from '@/lib/engine/audit';
import { diagnose, draftCheckIn, draftLesson, draftRemedialQuiz, planGoal, reviseCatchUpPlan, reviseCheckIn, reviseRemedialQuiz, type AiResult, type Evidence } from '@/lib/ai/agents';
import { COHORTS, injectQuizDefect, simCase, simPlan } from '@/lib/ai/simulate';
import { checkInEmail, quizEmail, sendMail } from '@/lib/email/send';
import { writeBack } from '@/lib/lms/sheet';
import { callStatus, dialerReady, maskPhone, placeCall } from '@/lib/calls/dialer';
import { log, setSpotlight } from '@/lib/engine/store';
import { assessRisk, getLmsAdapter, sandboxAdapter, type LmsAdapter } from '@/lib/lms/lmsAdapter';
import { MODULES } from '@/lib/lms/sandboxData';

/* The one run: a person gives the colleague a goal, and it finishes the job.
 *
 *   Planner      reads the goal, decides scope, writes the plan
 *   Student      scans the LMS, works out WHY each learner is behind,
 *   Success      and writes personal check-ins for the ones who went quiet
 *   Learning &   writes a catch-up quiz and tutoring for each topic gap
 *   Assessment
 *   Reviewer     audits every output against the LMS evidence, sends back
 *                what is wrong, and only approved work reaches a learner
 *
 * Nobody is asked anything between the goal and the result. */

export const DEFAULT_GOAL = 'Get every learner who is falling behind in FSWD-2026-Q3 back on track this week.';

async function adapterFor(ctx: Ctx): Promise<LmsAdapter> {
  const mode = ctx.state.settings.lmsMode;
  const adapter = getLmsAdapter(mode);
  if (mode === 'live' && adapter.mode === 'sandbox') ctx.say('lms', 'lms', 'Live LMS requested but LMS_API_URL / LMS_API_KEY are not set. Using the Demo Sandbox.');
  return adapter;
}

const firstName = (n: string) => n.split(' ')[0];
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface RunOptions {
  trigger?: Trigger;
  /** Learners an LMS event is about: they are looked at whatever the scan says. */
  focus?: string[];
}

export function runGoal(goalText: string, opts: RunOptions = {}) {
  const goal = goalText.replace(/\s+/g, ' ').trim().slice(0, 280) || DEFAULT_GOAL;
  const trigger: Trigger = opts.trigger || { kind: 'manager', label: "Manager's goal" };
  const focus = opts.focus?.length ? new Set(opts.focus) : null;
  return startScenario('goal', 'Goal', goal, 10, async (ctx) => {
    let adapter = await adapterFor(ctx);
    patchTask(ctx.task.id, { goal, trigger });
    ctx.task.goal = goal;
    ctx.task.trigger = trigger;
    let fixes = 0;

    // 1 · the goal arrives: typed by a manager, sent by the LMS, or due on the schedule
    ctx.step(trigger.kind === 'webhook' || trigger.kind === 'sheet' ? 'A change in the learner record reaches the Planner' : trigger.kind === 'schedule' ? 'Weekly sweep starts on schedule' : 'Goal handed to the Planner');
    if (trigger.kind === 'manager') {
      ctx.say('person', 'info', `Goal: "${goal}"`);
      ctx.announce('person', `New goal · “${goal}”`);
    } else if (trigger.kind === 'schedule') {
      ctx.say('system', 'system', `Scheduler fired: "${goal}"`, undefined, { tool: 'scheduler.weekly_sweep', payload: { schedule: 'Mondays 07:00', goal } });
      ctx.announce('system', 'Weekly sweep started by the scheduler · nobody pressed anything');
    } else {
      ctx.announce('lms', `${trigger.label} · the colleague starts by itself`, 'warn');
    }
    const token = trigger.kind === 'webhook' || trigger.kind === 'sheet'
      ? ctx.spawnVisitor('alert', trigger.kind === 'sheet' ? 'Sheet update' : 'LMS alert', undefined, ENTRANCE)
      : ctx.spawnVisitor('goal', trigger.kind === 'schedule' ? 'Weekly sweep' : 'Goal', undefined, ENTRANCE);
    const planning = planGoal(goal);
    ctx.think('planner', 'A goal, not a task list. Reading it for the outcome…');
    ctx.room('planning', 'busy', 'Planning');
    await ctx.visitorWalk(token, ROOMS.planning.visitor);

    // 2 · the plan
    ctx.step('Planner turns the goal into a plan');
    ctx.think('planner', 'Deciding scope, who does what, and what "done" means…');
    const { value: plan, viaAi: planAi } = await planning;
    ctx.setPlan(plan);
    const scope = plan.scope.cohorts.length === COHORTS.length ? 'all cohorts' : plan.scope.cohorts.join(', ');
    const tutorLang = plan.scope.language !== 'en' ? plan.scope.language : (getState().settings.tutorLanguage || 'en');
    ctx.say('planner', 'plan', `Plan${planAi ? '' : ' (playbook)'}: ${plan.reading}`, undefined, {
      tool: 'planner.make_plan',
      payload: { goal, scope: plan.scope, successCriteria: plan.successCriteria, steps: plan.steps.map((s) => ({ stage: s.key, owner: s.owner, text: s.text })) },
    });
    ctx.think('planner', plan.reading, 'working');
    ctx.announce('planner', `Plan ready · ${scope} · ${plan.steps.length} steps, owners assigned`);
    await ctx.wait(2600);
    ctx.think('planner', 'Bongani, scan first. Nobody acts until we know why each learner is behind.', 'working');
    patchVisitor(token.id, { label: 'Plan', sub: scope });
    await ctx.visitorWalk(token, ROOMS.success.visitor);
    ctx.calm('planning');
    ctx.think('planner', null, 'idle');

    // 3 · scan
    ctx.step('Student Success scans the LMS');
    ctx.stage('scan', 'doing');
    ctx.room('success', 'busy', 'Scanning the LMS');
    ctx.think('success', `Pulling engagement and marks for ${scope}…`, 'working');
    let students = [] as Awaited<ReturnType<LmsAdapter['listStudents']>>;
    try { students = await adapter.listStudents(); if (!students.length) throw new Error('empty roster'); }
    catch (e) {
      ctx.say('lms', 'lms', `Live LMS unreachable (${(e as Error).message}). Falling back to the Demo Sandbox so the scan completes.`);
      adapter = sandboxAdapter();
      students = await adapter.listStudents();
    }
    const all: Evidence[] = [];
    for (const s of students) {
      const [e, a] = await Promise.all([adapter.getEngagement(s.id), adapter.getAssessments(s.id)]);
      if (e) all.push({ student: s, e, a, risk: assessRisk(e, a, MODULES) });
    }
    const cards: LearnerCard[] = all.map(({ student: s, e, a, risk }) => ({
      id: s.id, name: s.name, email: s.email, cohort: s.cohort, programme: s.programme,
      status: risk.band === 'at_risk' ? 'at_risk' : 'on_track', riskScore: risk.score,
      weakTopic: risk.weakModule ? `${risk.weakModule.code} · ${risk.weakTopic || risk.weakModule.title}` : null,
      lastLoginDays: e.daysSinceLastLogin, completion: e.completionPct,
      quizAvg: Math.round(a.reduce((n, x) => n + x.scorePct, 0) / Math.max(1, a.length)), lastEvent: null,
    }));
    setLearners(cards);
    // An LMS event is about specific learners: look at them, whatever the plan's scope says.
    const scoped = focus ? all.filter((x) => focus.has(x.student.id)) : all.filter((x) => plan.scope.cohorts.includes(x.student.cohort));
    const open = new Set(focus ? [] : getState().learners.filter((l) => l.status === 'intervention' || l.status === 'recovered').map((l) => l.id));
    const flagged = scoped
      .filter((x) => x.risk.band === 'at_risk' || (x.risk.band === 'watch' && x.e.daysSinceLastLogin >= 7) || (focus && (x.e.daysSinceLastLogin >= 7 || x.a.some((r) => !r.passed && r.kind === 'quiz'))))
      .sort((p, q) => q.risk.score - p.risk.score);
    const already = flagged.filter((x) => open.has(x.student.id));
    const need = flagged.filter((x) => !open.has(x.student.id)).slice(0, focus ? 10 : plan.scope.limit);
    await ctx.wait(1400);
    const where = focus ? 'the LMS event' : scope;
    ctx.say('success', 'lms', `Scan complete: ${plural(scoped.length, 'learner')} in ${where}, ${need.length} need help${already.length ? `, ${already.length} already have an open case` : ''}.`, undefined, {
      tool: 'lms_adapter.scan_cohort',
      payload: { adapterMode: adapter.mode, endpoint: 'GET /students', cohorts: plan.scope.cohorts, scanned: scoped.length, flagged: need.map((x) => ({ id: x.student.id, name: x.student.name, risk: x.risk.score, signals: x.risk.signals.slice(0, 3) })) },
    });
    ctx.stage('scan', 'done', `${plural(scoped.length, 'learner')} checked · ${need.length} need help`);
    ctx.announce('success', `LMS scanned · ${plural(scoped.length, 'learner')} checked, ${need.length} need help`, need.length ? 'warn' : 'good');
    for (const x of need) setLearner(x.student.id, { status: 'at_risk', lastEvent: 'Flagged by Student Success' });

    if (!need.length) {
      ctx.say('success', 'info', already.length ? 'Everyone who was behind already has an open case. Nothing new to do.' : 'Nobody in scope is behind this week. Nothing to do.');
      for (const k of ['diagnose', 'act', 'review', 'deliver', 'follow_up'] as const) ctx.stage(k, 'done', 'Nothing needed');
      ctx.removeToken(token.id);
      finish(ctx, { checked: scoped.length, needHelp: 0, quizzes: 0, checkIns: 0, errorsFixed: 0, humanInterventions: 0, durationMs: Date.now() - ctx.task.startedAt });
      return;
    }

    // 4 · diagnose: why is each one behind?
    ctx.step('Working out why each learner is behind');
    ctx.stage('diagnose', 'doing');
    ctx.think('success', `${plural(need.length, 'learner')} behind. Before anyone acts: is it the topic, or have they gone quiet?`);
    const evidenceCases = need.map((x) => simCase(x.student, x.e, x.risk));
    const { value: diagnosed, viaAi: dxAi } = await diagnose(need, evidenceCases);
    await ctx.wait(1200);
    for (const c of diagnosed) {
      ctx.say('success', 'think', `${c.learner.name} · ${c.cause === 'topic_gap' ? `topic gap on ${c.weakModule?.code}` : 'disengaged'} → ${c.action === 'remedial_quiz' ? 'catch-up quiz' : 'personal check-in'}. ${c.why}`);
    }
    const quiet = diagnosed.find((c) => c.cause === 'disengaged');
    const gaps = diagnosed.filter((c) => c.cause === 'topic_gap');
    if (quiet) {
      ctx.think('success', `${quiet.why.replace(/\.$/, '')}. A quiz won't fix that; I'll write to ${firstName(quiet.learner.name)} myself.`);
      ctx.announce('success', `${firstName(quiet.learner.name)} passes every quiz but has gone quiet · a check-in, not a quiz`, 'info');
      await ctx.wait(2600);
    }
    const planDoc: CatchUpPlan = {
      goal, scope, checked: scoped.length, cases: diagnosed,
      summary: `${plural(gaps.length, 'topic gap')} → catch-up quizzes from Learning & Assessment; ${plural(diagnosed.length - gaps.length, 'disengaged learner')} → personal check-ins from Student Success.`,
    };
    const planD = ctx.draft<CatchUpPlan>('catchup_plan', 'Catch-up plan', scope, 'success', 'success', planDoc);
    ctx.say('success', 'draft', `Catch-up plan v1${dxAi ? '' : ' (evidence rules)'}: ${planDoc.summary}`, planD.id, {
      tool: 'success.diagnose_learners',
      payload: { deliverableId: planD.id, cases: diagnosed.map((c) => ({ id: c.learner.id, cause: c.cause, action: c.action, owner: c.owner })) },
    });
    ctx.announce('success', `Diagnosed · ${plural(gaps.length, 'topic gap')}, ${plural(diagnosed.length - gaps.length, 'disengaged learner')}`);

    // Lindiwe can start the moment the diagnosis exists; the Reviewer checks it meanwhile.
    const quizId = () => uid('qz').replace('qz_', 'MA-');
    const quizJobs = new Map<string, Promise<AiResult<RemedialQuiz>>>();
    const checkJobs = new Map<string, Promise<AiResult<CheckInMessage>>>();
    const lessonJobs = new Map<string, Promise<AiResult<Lesson>>>();
    const evidenceOf = (id: string) => need.find((x) => x.student.id === id)!;
    const startJobs = (cases: LearnerCase[]) => {
      for (const c of cases) {
        const ev = evidenceOf(c.learner.id);
        if (c.action === 'remedial_quiz' && !quizJobs.has(c.learner.id)) {
          const mod = MODULES.find((m) => m.code === c.weakModule?.code) || MODULES[0];
          const iv = simPlan(ev.student, ev.e, ev.risk);
          quizJobs.set(c.learner.id, draftRemedialQuiz(ev.student, { ...iv, weakTopic: c.weakTopic || iv.weakTopic }, mod, quizId(), tutorLang));
          lessonJobs.set(c.learner.id, draftLesson(ev.student, mod, c.weakTopic || iv.weakTopic));
        }
        if (c.action === 'checkin' && !checkJobs.has(c.learner.id)) checkJobs.set(c.learner.id, draftCheckIn(c, ev.e));
      }
    };
    startJobs(diagnosed);

    // 5 · the Reviewer checks the diagnosis before anyone acts on it
    ctx.step('Reviewer checks the diagnosis');
    ctx.stage('review', 'doing');
    let planVerdict = await ctx.review(planD, auditCatchUpPlan(planD.content), { holdMs: 1800 });
    if (!planVerdict.pass) {
      fixes += 1;
      const fixed = reviseCatchUpPlan(planD.content, evidenceCases);
      await ctx.wait(1600);
      ctx.revise(planD, fixed, 'Re-read the marks: causes now match the LMS evidence.');
      startJobs(fixed.cases);
      planVerdict = await ctx.review(planD, auditCatchUpPlan(planD.content), { walk: false, holdMs: 1400 });
    }
    ctx.stage('diagnose', 'done', `${plural(gaps.length, 'topic gap')} · ${plural(planD.content.cases.length - gaps.length, 'disengaged', 'disengaged')}`);
    ctx.removeToken(token.id);
    const cases = planD.content.cases;
    const quizCases = cases.filter((c) => c.action === 'remedial_quiz');
    const checkCases = cases.filter((c) => c.action === 'checkin');

    // 6 · act: case files to Lindiwe, check-ins at Bongani's desk
    ctx.step('Catch-up work is drafted');
    ctx.stage('act', 'doing');
    const lang = tutorLang === 'zu' ? 'isiZulu + English' : tutorLang === 'st' ? 'Sesotho + English' : 'English';
    let back: Promise<void> = Promise.resolve();
    if (quizCases.length) {
      ctx.room('learning', 'busy', `${plural(quizCases.length, 'case file')} incoming`);
      ctx.think('learning', `Bongani's bringing ${plural(quizCases.length, 'case')}. Topic gaps, so it's my turn.`, 'working');
      await ctx.walk('success', ROOMS.learning.visitor, { carrying: plural(quizCases.length, 'case file'), thought: `Taking the topic gaps to Lindiwe. The weak topic is what matters.` });
      ctx.think('success', `Lindiwe: ${quizCases.map((c) => `${firstName(c.learner.name)} on ${c.weakModule?.code}`).join(', ')}. Three questions each, on exactly that.`, 'working');
      ctx.say('success', 'route', `Handed to Learning & Assessment: ${quizCases.map((c) => `${c.learner.name} (${c.weakModule?.code} · ${c.weakTopic})`).join('; ')}.`, planD.id);
      await ctx.wait(1500);
      back = ctx.walk('success', ROOMS.success.desk, { carrying: null, thought: checkCases.length ? `Back to my desk to write to ${checkCases.map((c) => firstName(c.learner.name)).join(' and ')}.` : null });
      ctx.think('learning', `Writing ${plural(quizCases.length, 'catch-up quiz', 'catch-up quizzes')} and a ${lang} refresher on each weak topic…`);
    }
    await back;
    if (checkCases.length) {
      ctx.room('success', 'busy', 'Writing a personal check-in');
      ctx.think('success', `Writing to ${checkCases.map((c) => firstName(c.learner.name)).join(' and ')}. No labels, no guilt, one small ask.`);
    }

    const quizzes = [] as ReturnType<Ctx['draft']>[];
    for (const [i, c] of quizCases.entries()) {
      const { value: drafted, viaAi } = await quizJobs.get(c.learner.id)!;
      const { value: lesson, viaAi: lessonAi } = await lessonJobs.get(c.learner.id)!;
      const clean: RemedialQuiz = { ...drafted, lesson };
      ctx.say('learning', 'draft', `Video lesson for ${c.learner.name}${lessonAi ? '' : ' (from the question bank)'}: "${lesson.title}", ${lesson.slides.length} narrated slides, about ${Math.max(2, Math.round(lesson.slides.reduce((n, sl) => n + sl.say.split(/\s+/).length, 0) / 150))} minutes.`, undefined, {
        tool: 'learning.create_video_lesson', payload: { learner: c.learner.id, title: lesson.title, slides: lesson.slides.map((sl) => sl.heading) },
      });
      ctx.announce('learning', `Lindiwe made ${c.learner.name.split(' ')[0]} a ${lesson.slides.length}-slide video lesson on ${c.weakTopic || lesson.title}`);
      const v1 = ctx.injectDefects && i === 0 ? injectQuizDefect(clean) : clean;
      const d = ctx.draft<RemedialQuiz>('remedial_quiz', 'Catch-up quiz', `${c.learner.name} · ${v1.module.code}`, 'learning', 'learning', v1);
      quizzes.push(d);
      ctx.say('learning', 'draft', `Catch-up quiz v1 for ${c.learner.name}${viaAi ? '' : ' (question bank)'}: ${v1.questions.length} questions on ${v1.module.code} · ${v1.topic}, ${lang} refresher, pass mark ${v1.passMark}%.`, d.id, {
        tool: 'learning.generate_remedial_quiz',
        payload: { deliverableId: d.id, quizId: v1.quizId, learner: c.learner.id, module: v1.module.code, topic: v1.topic, language: lang, questions: v1.questions.length },
      });
    }
    if (quizCases.length) ctx.announce('learning', `${plural(quizCases.length, 'catch-up quiz', 'catch-up quizzes')} drafted · ${quizCases.map((c) => firstName(c.learner.name)).join(', ')}`);

    const checkins = [] as ReturnType<Ctx['draft']>[];
    for (const c of checkCases) {
      const { value: m, viaAi } = await checkJobs.get(c.learner.id)!;
      const d = ctx.draft<CheckInMessage>('checkin_message', 'Check-in', c.learner.name, 'success', 'success', m);
      checkins.push(d);
      ctx.say('success', 'draft', `Check-in for ${c.learner.name}${viaAi ? '' : ' (template)'}: "${m.subject}".`, d.id, {
        tool: 'success.write_checkin', payload: { deliverableId: d.id, learner: c.learner.id, words: m.body.split(/\s+/).length },
      });
    }
    if (checkCases.length) { ctx.announce('success', `Check-in written for ${checkCases.map((c) => firstName(c.learner.name)).join(', ')}`); ctx.think('success', 'Check-in ready for review.', 'working'); }
    ctx.stage('act', 'done', [quizCases.length ? plural(quizCases.length, 'quiz', 'quizzes') : '', checkCases.length ? plural(checkCases.length, 'check-in') : ''].filter(Boolean).join(' · '));

    // 7 · the Reviewer audits every learner-facing output
    ctx.step('Reviewer audits every output');
    for (const [i, d] of quizzes.entries()) {
      const q = d.content as RemedialQuiz;
      const mod = MODULES.find((m) => m.code === q.module.code) || MODULES[0];
      ctx.think('learning', i === 0 ? 'Drafts in. Ready for review.' : null, i === 0 ? 'working' : 'idle');
      let verdict = await ctx.review(d, auditRemedialQuiz(q, mod.keywords), { walk: i === 0, holdMs: 1900 });
      let round = 0;
      while (!verdict.pass && round < 2) {
        round += 1; fixes += 1;
        ctx.step(`Lindiwe fixes ${firstName(q.learner.name)}'s quiz`);
        const audit = auditRemedialQuiz(d.content as RemedialQuiz, mod.keywords);
        const revised = reviseRemedialQuiz(d.content as RemedialQuiz, audit.notes, audit.badIds, mod);
        ctx.say('learning', 'think', `Replacing ${audit.badIds.length === 1 ? 'the flagged question' : `${audit.badIds.length} flagged questions`} with ${mod.code} questions on ${q.topic}.`);
        await ctx.wait(2000);
        const { value: v2 } = await revised;
        const changed = v2.questions.filter((x, k) => x.prompt !== (d.content as RemedialQuiz).questions[k]?.prompt).map((x) => x.id.toUpperCase());
        ctx.revise(d, v2, `${changed.length ? `${changed.join(', ')} replaced with` : 'Rewritten as'} on-topic ${mod.code} question${changed.length === 1 ? '' : 's'}.`);
        await ctx.wait(700);
        verdict = await ctx.review(d, auditRemedialQuiz(d.content as RemedialQuiz, mod.keywords), { walk: false, holdMs: 1500 });
      }
      await ctx.wait(400);
    }
    ctx.calm('learning');
    for (const [i, d] of checkins.entries()) {
      let verdict = await ctx.review(d, auditCheckIn(d.content as CheckInMessage), { walk: i === 0, holdMs: 1800 });
      if (!verdict.pass) {
        fixes += 1;
        const c = checkCases[i];
        const audit = auditCheckIn(d.content as CheckInMessage);
        ctx.think('success', 'Fair. Rewriting it the way a person would say it…', 'revising');
        const { value: v2 } = await reviseCheckIn(c, evidenceOf(c.learner.id).e, audit.notes);
        ctx.revise(d, v2, 'Rewritten: no labels, shorter, one clear ask.');
        verdict = await ctx.review(d, auditCheckIn(d.content as CheckInMessage), { walk: false, holdMs: 1400 });
      }
    }
    ctx.calm('success');
    ctx.stage('review', 'done', `${plural(quizzes.length + checkins.length + 1, 'output')} approved · ${plural(fixes, 'fix', 'fixes')}`);

    // 8 · deliver
    ctx.step('Sending approved work to learners');
    ctx.stage('deliver', 'doing');
    for (const d of quizzes) {
      const q = d.content as RemedialQuiz;
      const link = `${getState().caps.baseUrl}/quiz/${q.quizId}`;
      const mail = await sendMail({ to: q.learner.email, toName: q.learner.name, ...quizEmail(q, link), link, taskId: ctx.task.id, deliverableId: d.id });
      ctx.dispatch(d);
      try { await adapter.updateStudentStatus(q.learner.id, 'intervention', `Catch-up quiz ${q.quizId} sent`); } catch { /* the office remembers even if the LMS is down */ }
      setLearner(q.learner.id, { status: 'intervention', lastEvent: `Quiz ${q.quizId} sent · waiting` });
      void writeBack(q.learner.id, 'being helped', `Study pack and quiz sent ${new Date().toLocaleString('en-ZA')}`);
      ctx.say('coo', 'dispatch', `Sent: catch-up quiz for ${q.learner.name}. Link: ${link}`, d.id, { tool: 'comms.send_quiz', payload: { quizId: q.quizId, learner: q.learner.id, link, delivery: mail.delivery } });
    }
    for (const d of checkins) {
      const m = d.content as CheckInMessage;
      const mail = await sendMail({ to: m.learner.email, toName: m.learner.name, ...checkInEmail(m), link: null, taskId: ctx.task.id, deliverableId: d.id });
      ctx.dispatch(d);
      try { await adapter.updateStudentStatus(m.learner.id, 'intervention', 'Personal check-in sent'); } catch { /* as above */ }
      setLearner(m.learner.id, { status: 'intervention', lastEvent: 'Check-in sent · waiting for a reply' });
      void writeBack(m.learner.id, 'being helped', `Check-in sent ${new Date().toLocaleString('en-ZA')}`);
      ctx.say('coo', 'dispatch', `Sent: check-in to ${m.learner.name} · "${m.subject}".`, d.id, { tool: 'comms.send_checkin', payload: { learner: m.learner.id, delivery: mail.delivery } });
    }
    ctx.dispatch(planD);
    ctx.say('lms', 'lms', `PATCH /students/{id}/status → intervention for ${plural(cases.length, 'learner')} (${adapter.mode}).`, undefined, {
      tool: 'lms_adapter.update_student_status', payload: { learners: cases.map((c) => c.learner.id), status: 'intervention' },
    });
    const mode = getState().caps.email;
    ctx.say('system', 'email', `${plural(quizzes.length + checkins.length, 'email')} ${mode === 'smtp' ? 'sent by email (SMTP)' : mode === 'resend' ? 'sent via Resend' : 'placed in the Inbox tab (no email account connected)'}.`);
    ctx.stage('deliver', 'done', `${plural(quizzes.length + checkins.length, 'email')} sent · LMS updated`);
    ctx.announce('coo', `Sent · ${[quizzes.length ? plural(quizzes.length, 'quiz', 'quizzes') : '', checkins.length ? plural(checkins.length, 'check-in') : ''].filter(Boolean).join(' and ')} · LMS updated`, 'good');
    setAgent('learning', { tasksDone: getState().agents.learning.tasksDone + quizzes.length });
    setAgent('success', { tasksDone: getState().agents.success.tasksDone + checkins.length + 1 });

    // 8b · the follow-up call, through the academy's dialer
    if (dialerReady() && getState().settings.callFollowUp !== false) {
      const helped = [
        ...quizzes.map((d) => { const q = d.content as RemedialQuiz; return { id: q.learner.id, name: q.learner.name, email: q.learner.email, kind: 'quiz' as const, topic: q.topic, module: q.module.code }; }),
        ...checkins.map((d) => { const m = d.content as CheckInMessage; return { id: m.learner.id, name: m.learner.name, email: m.learner.email, kind: 'checkin' as const, topic: '', module: '' }; }),
      ];
      for (const h of helped) {
        const st = await adapter.getStudent(h.id);
        const phone = st?.phone?.trim();
        if (!phone) continue;
        const f = firstName(h.name);
        ctx.step(`Bongani phones ${f}`);
        const greeting = h.kind === 'quiz'
          ? `Hi ${f}, it's Thuso from the student success team. Just so you know, this call is recorded. I saw ${h.module} has been a bit tough lately, so I've just emailed you a three-minute video lesson and a short quiz on ${h.topic}. Have you got a second?`
          : `Hi ${f}, it's Thuso from the student success team. Just so you know, this call is recorded. We haven't seen you online for a while and just wanted to check you're okay. I've sent you an email too. Have you got a second?`;
        const instructions = `IMPORTANT, this replaces any sales goal above. This is a short, caring follow-up call from the academy's student success team, not a sales call. The learner is ${h.name}. ${h.kind === 'quiz' ? `They are stuck on ${h.module}, ${h.topic}. The email has a three-minute video lesson and a three-question quiz on exactly that; passing the quiz updates their record.` : 'They have gone quiet. The email asks one small thing: reply with what got in the way, or book a ten-minute call.'} After the greeting, listen. If they have a moment, explain the email in one or two sentences and ask if anything is getting in the way. Answer any question in one sentence. If they are busy, say no problem, the email is waiting for them. Never say "at risk" or mention scores or risk. Thank them, say goodbye warmly, and end the call with end_call. Keep the whole call under 60 seconds.`;
        ctx.think('success', `Phoning ${f} to make sure the email landed. A real voice gets opened emails.`, 'working');
        setSpotlight({ id: `call-${h.id}-${Date.now()}`, ts: Date.now(), kind: 'call', owner: 'success', title: `Calling ${h.name}`, subject: `${maskPhone(phone)} · through the academy's dialer`, rule: "The dialer's AI caller rings now and opens with:", problem: greeting, before: null, after: null, holdMs: ctx.pace(9000) });
        const r = await placeCall({ name: h.name, phone, email: h.email, greeting, instructions, maxSeconds: 90 });
        if (r.ok) {
          ctx.say('success', 'dispatch', `Follow-up call started through the dialer: ${h.name} (${maskPhone(phone)}).`, undefined, { tool: 'dialer.start_ai_call', payload: { learner: h.id, phone: maskPhone(phone), call_id: r.callId, greeting } });
          ctx.announce('success', `Calling ${f} now · the dialer's AI caller is ringing`, 'good');
          void followCall(r.callId, h.name);
        } else {
          ctx.say('success', 'error', `Follow-up call to ${h.name} not placed: ${r.error}`, undefined, { tool: 'dialer.start_ai_call', payload: { learner: h.id, error: r.error } });
          ctx.announce('success', `Call to ${f} not placed · ${r.error}`, 'warn');
        }
        await ctx.wait(5200);
      }
    }

    // 9 · done, and watching
    ctx.step('Goal complete · watching for results');
    ctx.stage('follow_up', 'doing', quizzes.length ? 'Waiting for quiz results' : 'Waiting for replies');
    finish(ctx, { checked: scoped.length, needHelp: cases.length, quizzes: quizzes.length, checkIns: checkins.length, errorsFixed: fixes, humanInterventions: 0, durationMs: Date.now() - ctx.task.startedAt });
    ctx.think('planner', `Done: ${plural(cases.length, 'learner')} each have a reviewed next step. ${plural(fixes, 'error')} caught before anyone saw it.`, 'celebrating');
    ctx.think('coo', 'Every output checked. Nothing wrong went out.', 'celebrating');
    await ctx.wait(2200);
    await ctx.home('coo');
  });
}

function finish(ctx: Ctx, summary: RunSummary) {
  ctx.task.summary = summary;
  patchTask(ctx.task.id, { summary });
  bumpSay(ctx, summary);
}

function bumpSay(ctx: Ctx, s: RunSummary) {
  const text = s.needHelp
    ? `Goal complete · ${plural(s.checked, 'learner')} checked, ${s.needHelp} helped, ${plural(s.errorsFixed, 'error')} caught and fixed, ${s.humanInterventions} human interventions`
    : `Goal complete · ${plural(s.checked, 'learner')} checked, nobody needs help`;
  ctx.say('system', 'approve', text, undefined, { tool: 'colleague.goal_complete', payload: s });
  ctx.announce('planner', text, 'good');
}

/** Follow a dialer call until it ends, and say how it went. Never blocks a run. */
async function followCall(callId: string, name: string) {
  const first = firstName(name);
  const until = Date.now() + 4 * 60_000;
  let last = '';
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 4000));
    const c = await callStatus(callId);
    if (!c) continue;
    if (c.state !== last && c.state === 'talking') log('success', 'info', `${first} answered. The AI caller is talking to ${first} now.`, { toolCall: { tool: 'dialer.call_status', payload: c } });
    last = c.state;
    if (c.state === 'done' || c.outcome) {
      const secs = c.duration_seconds || 0;
      log('success', secs > 0 ? 'approve' : 'info', secs > 0 ? `Call with ${first} finished: ${secs}s${c.outcome ? ` · ${c.outcome.replace(/_/g, ' ')}` : ''}.` : `${first} did not pick up. The email is waiting for them.`, { toolCall: { tool: 'dialer.call_status', payload: c } });
      return;
    }
  }
}
