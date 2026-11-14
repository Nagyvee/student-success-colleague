/* Student Success Colleague · the shapes every layer shares.
 *
 * The office is one world object. The engine mutates it on the server, the
 * stream sends it whole to every open screen, and the floorplan draws it.
 * Positions are percentages of the floor, so one layout fits every screen. */

export type Dept = 'planning' | 'success' | 'learning' | 'review';
export type AgentId = 'planner' | 'success' | 'learning' | 'coo';
export type ScenarioId = 'goal';
export type TutorLanguage = 'en' | 'zu' | 'st';

export interface Point { x: number; y: number }

export type AgentStatus = 'idle' | 'thinking' | 'working' | 'walking' | 'reviewing' | 'revising' | 'celebrating';

export interface AgentState {
  id: AgentId;
  name: string;
  title: string;
  dept: Dept;
  pos: Point;
  home: Point;
  /** Waypoints of the walk in progress, first one being where it started. */
  path: Point[] | null;
  walkMs: number;
  status: AgentStatus;
  thought: string | null;
  /** What the agent is carrying across the floor: a case file, a plan. */
  carrying: string | null;
  tasksDone: number;
}

export type VisitorKind = 'goal' | 'alert' | 'packet';
export interface Visitor {
  id: string;
  label: string;
  sub?: string;
  kind: VisitorKind;
  pos: Point;
  path: Point[] | null;
  walkMs: number;
  leaving?: boolean;
}

export type RoomMood = 'calm' | 'busy' | 'scan' | 'amber' | 'green';
export interface RoomState { mood: RoomMood; caption: string | null }

export type FeedLevel =
  | 'system' | 'think' | 'info' | 'route' | 'plan' | 'draft' | 'audit'
  | 'error' | 'fix' | 'approve' | 'dispatch' | 'lms' | 'email' | 'score';

export type FeedActor = AgentId | 'system' | 'lms' | 'student' | 'person';

export type HeadlineTone = 'info' | 'good' | 'warn' | 'bad';

/** One beat of the story, shown large over the floor so a room can follow it. */
export interface Headline { id: string; ts: number; actor: FeedActor; text: string; tone: HeadlineTone }

export interface ToolCallLog {
  tool: string;
  payload: unknown;
}

export interface FeedEntry {
  id: string;
  ts: number;
  actor: FeedActor;
  level: FeedLevel;
  text: string;
  taskId?: string;
  deliverableId?: string;
  toolCall?: ToolCallLog;
}

export type DeliverableKind = 'catchup_plan' | 'remedial_quiz' | 'checkin_message';
export type DeliverableStatus = 'drafting' | 'draft' | 'under_review' | 'rejected' | 'revised' | 'approved' | 'dispatched';

export interface AuditEntry {
  ts: number;
  by: AgentId;
  verdict: 'submitted' | 'pass' | 'fail' | 'revised';
  version: number;
  notes: string[];
}

export interface Deliverable<T = unknown> {
  id: string;
  taskId: string;
  kind: DeliverableKind;
  title: string;
  subject: string;
  owner: AgentId;
  dept: Dept;
  version: number;
  status: DeliverableStatus;
  content: T;
  previous: T | null;
  audit: AuditEntry[];
  createdAt: number;
  updatedAt: number;
}

/* ── The goal and the plan ────────────────────────────────────────────────── */

/** The stages every plan is built from. The Planner decides scope, order of
 *  priority and what each stage must achieve; the engine runs each stage. */
export type StageKey = 'scan' | 'diagnose' | 'act' | 'review' | 'deliver' | 'follow_up';

export interface PlanStep {
  key: StageKey;
  owner: AgentId;
  text: string;
  status: 'todo' | 'doing' | 'done';
  /** What actually happened, filled in as the step finishes. */
  result?: string;
}

export interface GoalPlan {
  goal: string;
  /** The Planner's reading of the goal, first person, one or two sentences. */
  reading: string;
  scope: { cohorts: string[]; limit: number; language: TutorLanguage };
  successCriteria: string;
  steps: PlanStep[];
  viaAi: boolean;
}

export interface RunSummary {
  checked: number;
  needHelp: number;
  quizzes: number;
  checkIns: number;
  errorsFixed: number;
  humanInterventions: number;
  durationMs: number;
}

/** What started a run: a manager's goal, an LMS webhook, or the schedule. */
export interface Trigger { kind: 'manager' | 'webhook' | 'schedule' | 'sheet'; label: string }

/** The moment the Reviewer stops the line, held on screen long enough to read. */
export interface Spotlight {
  id: string;
  ts: number;
  kind: 'caught' | 'fixed' | 'call' | 'passed' | 'failed';
  /** Next steps, for a quiz result card. */
  steps?: string[];
  owner: AgentId;
  title: string;
  subject: string;
  rule: string;
  problem: string;
  before: string | null;
  after: string | null;
  holdMs: number;
}

export interface Automation {
  webhookPath: string;
  lastEvent: { at: number; event: string; learner: string; detail: string } | null;
  events: number;
  schedule: { enabled: boolean; label: string; nextAt: number | null; lastAt: number | null };
  queued: number;
  sheet: { connected: boolean; url: string | null; rows: number; lastReadAt: number | null; lastError: string | null; lastChangeAt: number | null };
  writeBack: boolean;
}

export interface Task {
  id: string;
  scenario: ScenarioId;
  title: string;
  subject: string;
  status: 'running' | 'done' | 'failed';
  step: number;
  totalSteps: number;
  stepLabel: string;
  startedAt: number;
  endedAt: number | null;
  deliverableIds: string[];
  corrections: number;
  goal?: string;
  plan?: GoalPlan | null;
  summary?: RunSummary | null;
  trigger?: Trigger;
}

export interface InboxMail {
  id: string;
  ts: number;
  to: string;
  toName: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  link: string | null;
  delivery: 'smtp' | 'resend' | 'simulated';
  providerId: string | null;
  taskId: string;
  deliverableId: string | null;
}

export type LearnerStatus = 'on_track' | 'at_risk' | 'intervention' | 'recovered';

export interface LearnerCard {
  id: string;
  name: string;
  email: string;
  cohort: string;
  programme: string;
  status: LearnerStatus;
  riskScore: number;
  weakTopic: string | null;
  lastLoginDays: number;
  completion: number;
  quizAvg: number;
  lastEvent: string | null;
}

export interface Settings {
  /** The demo plants one realistic defect in the first quiz so the audience
   *  always sees the Reviewer catch it. Off, the Reviewer still audits every draft. */
  injectDefects: boolean;
  lmsMode: 'sandbox' | 'live';
  speed: 'normal' | 'fast';
  tutorLanguage?: TutorLanguage;
  /** The weekly sweep: every Monday at 07:00, all cohorts. */
  scheduleEnabled?: boolean;
  /** After the email, the dialer's AI caller phones the learner. */
  callFollowUp?: boolean;
}

export interface Capabilities {
  ai: { provider: 'anthropic' | 'openai' | 'simulation'; model: string };
  email: 'smtp' | 'resend' | 'simulated';
  lmsLiveConfigured: boolean;
  baseUrl: string;
  dialer: boolean;
}

export interface Metrics {
  processed: number;
  approved: number;
  corrections: number;
  dispatched: number;
  quizzesCompleted: number;
  aiCalls: number;
}

export interface WorldState {
  version: number;
  startedAt: number;
  busy: ScenarioId | null;
  agents: Record<AgentId, AgentState>;
  visitors: Visitor[];
  rooms: Record<Dept, RoomState>;
  feed: FeedEntry[];
  headlines: Headline[];
  tasks: Task[];
  deliverables: Deliverable[];
  inbox: InboxMail[];
  learners: LearnerCard[];
  metrics: Metrics;
  settings: Settings;
  caps: Capabilities;
  spotlight?: Spotlight | null;
  automation?: Automation;
}

/* ── Deliverable payloads ─────────────────────────────────────────────────── */

/** Why a learner is behind, which decides what the colleague does about it. */
export type Cause = 'topic_gap' | 'disengaged';

export interface LearnerCase {
  learner: { id: string; name: string; email: string; cohort: string; programme: string };
  riskScore: number;
  signals: string[];
  cause: Cause;
  /** One sentence: why the evidence points at this cause. */
  why: string;
  action: 'remedial_quiz' | 'checkin';
  owner: AgentId;
  weakModule: { code: string; title: string } | null;
  weakTopic: string | null;
}

export interface CatchUpPlan {
  goal: string;
  scope: string;
  checked: number;
  cases: LearnerCase[];
  summary: string;
}

/** Kept for the quiz drafter: the single-learner view of a case. */
export interface InterventionPlan {
  learner: { id: string; name: string; email: string; cohort: string; programme: string };
  riskScore: number;
  signals: string[];
  weakModule: { code: string; title: string };
  weakTopic: string;
  topicKeywords: string[];
  summary: string;
  actions: { when: string; action: string; owner: string }[];
}

export interface CheckInMessage {
  learner: { id: string; name: string; email: string };
  subject: string;
  body: string;
  /** The one small thing we ask the learner to do. */
  ask: string;
}

/** A narrated slide lesson: the "video" a learner watches before the quiz. */
export interface LessonSlide { heading: string; points: string[]; code?: string; say: string }
export interface Lesson { title: string; slides: LessonSlide[]; viaAi: boolean }

export interface QuizQuestion {
  id: string;
  prompt: string;
  options: string[];
  answerIndex: number;
  explanation: string;
  topicTag: string;
}

export interface QuizResult {
  score: number;
  total: number;
  pct: number;
  answers: number[];
  submittedAt: number;
  passed: boolean;
}

export interface LocalizedTutoring {
  language: 'zu' | 'st';
  label: string;
  summary: string;
  keyPoints: string[];
}

export interface RemedialQuiz {
  quizId: string;
  learner: { id: string; name: string; email: string };
  module: { code: string; title: string };
  topic: string;
  topicKeywords: string[];
  tutoringSummary: string;
  keyPoints: string[];
  localizedSummary?: LocalizedTutoring | null;
  allTranslations?: Record<'zu' | 'st', LocalizedTutoring>;
  questions: QuizQuestion[];
  /** The study pack: real pages to read and a video to watch on the weak topic. */
  resources?: { label: string; url: string; kind: 'read' | 'watch' }[];
  lesson?: Lesson | null;
  passMark: number;
  status: 'pending' | 'completed';
  result: QuizResult | null;
}

export type AuditVerdict = { pass: boolean; notes: string[] };
