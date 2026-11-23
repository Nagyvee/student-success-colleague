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
  /** A department agent's own colour (the tutoring team uses its room colour). */
  color?: string;
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
  /** The department it belongs to: a department id, or a kind ("admissions") when the id is not known. */
  dept?: string;
}

export type DeliverableKind = 'catchup_plan' | 'remedial_quiz' | 'checkin_message' | 'agent_message';
export type DeliverableStatus = 'drafting' | 'draft' | 'under_review' | 'rejected' | 'revised' | 'approved' | 'awaiting_approval' | 'dispatched';

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

/** What started a run: a manager's goal, an LMS webhook, a workflow, a follow-up, or the schedule. */
export interface Trigger { kind: 'manager' | 'webhook' | 'schedule' | 'sheet' | 'workflow' | 'followup'; label: string }

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
  workflowId?: string | null;
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
  delivery: 'smtp' | 'simulated';
  /** Why it did not go, when sending was tried and failed. */
  error?: string | null;
  providerId: string | null;
  taskId: string;
  /** The department that sent it: a department id, or a kind ("admissions"). */
  dept?: string;
  deliverableId: string | null;
  replies?: Array<{ ts: number; from: string; text: string }>;
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

export interface SyncedLearnerGrade {
  id: string;
  title: string;
  courseName: string;
  scorePct: number;
  passMark: number;
  passed: boolean;
  feedback: string | null;
  missedQuestions: number;
  takenAt: string;
}

export interface SyncedLearnerCourse {
  id: number;
  code: string;
  name: string;
  progressPct: number | null;
  completedActivities: number;
  totalActivities: number;
}

export interface SyncedLearnerIncompleteActivity {
  name: string;
  type: string;
  course: string;
  dueAt?: string;
}

export interface SyncedLearnerRow {
  id: string;
  name: string;
  email: string;
  phone: string;
  cohort: string;
  programme?: string;
  module?: string | null;
  moduleTitle?: string;
  checkpoint: number | null;
  avgScore?: number | null;
  assessmentsCount?: number;
  recentGrades?: SyncedLearnerGrade[];
  completionPct?: number;
  completedActivities?: number;
  totalActivities?: number;
  courses?: SyncedLearnerCourse[];
  incompleteActivities?: SyncedLearnerIncompleteActivity[];
  /** The next assignment due (not submitted yet), from Moodle. */
  nextDue?: { name: string; course: string; dueAt: string } | null;
  /** Moodle groups (intakes) the student is in; empty when in none. */
  groups?: string[];
  daysSinceLogin: number | null;
  neverLoggedIn?: boolean;
  lastActivityAt?: string | null;
  missedClasses?: number;
  missedAssignments?: number;
  paymentStatus?: string;
  riskScore?: number;
  riskBand?: 'on_track' | 'watch' | 'at_risk';
  signals?: string[];
  weakTopic?: string | null;
  status: string;
  lastEvent: string | null;
  source?: string;
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
  /** Require human approval before sending outreach to learners. */
  requireApproval?: boolean;
  /** False (default): sync saves records quietly and agents run when clicked ("Coach" / "Run Flow"). True: auto-run on Moodle/Sheet changes. */
  autoRunMode?: boolean;
  /** False (default): Safe Test Mode — all emails/calls/WhatsApp/ManyChat are simulated in-app only; zero live external sends. */
  liveOutreachEnabled?: boolean;
}

export interface Capabilities {
  ai: { provider: 'anthropic' | 'openai' | 'simulation'; model: string };
  email: 'smtp' | 'simulated';
  liveOutreach?: boolean;
  /** The server's sending lock (SENDING_PAUSED): nothing leaves while it is on. */
  sendingPaused?: boolean;
  lmsLiveConfigured: boolean;
  moodleConfigured?: boolean;
  whatsappConfigured?: boolean;
  manychatConfigured?: boolean;
  postgresConfigured?: boolean;
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
  pendingOutreach?: PendingOutreach[];
  tenant?: TenantSummary | null;
}

export interface PendingOutreach {
  id: string;
  taskId: string;
  deliverableId: string;
  learnerId: string;
  learnerName: string;
  learnerEmail: string;
  cohort: string;
  kind: 'remedial_quiz' | 'checkin' | 'agent_message';
  /** For agent_message: the agent run that resumes once this is approved. */
  runId?: string;
  /** For agent_message: where it goes when approved. */
  channel?: MessageChannel;
  subject: string;
  previewText: string;
  link: string | null;
  moduleCode: string | null;
  topic: string | null;
  workflowId: string | null;
  workflowName: string;
  triggerKind: string;
  intervalHours: number;
  repeatForever: boolean;
  maxAttempts: number | null;
  createdAt: number;
  status: 'pending' | 'approved' | 'rejected';
  resolvedAt?: number;
}

export type OutreachChannel = 'email' | 'whatsapp' | 'manychat' | 'all';

export interface BuildingConfig {
  facadeStyle?: 'sculpted' | 'classic';
  logoUrl?: string;
  hideCanopyName?: boolean;
  brandColor?: string;
  activeFloorColor?: string;
  showBillboard?: boolean;
  billboardText?: string;
  billboardImageUrl?: string;
  videoUrl?: string;
  showTrees?: boolean;
  showBollards?: boolean;
  showRoofChillers?: boolean;
  showStreetLamps?: boolean;
}

export interface TenantIntegrations {
  lmsProvider: 'moodle' | 'webhook' | 'rest' | 'sandbox';
  moodleUrl?: string;
  moodleToken?: string;
  moodleCourseIds?: string;
  /** Per-course Moodle group IDs to sync; missing/empty means all groups in that course. */
  moodleCourseGroups?: Record<string, number[]>;
  lmsApiUrl?: string;
  lmsApiKey?: string;
  googleSheetUrl?: string;
  sheetWritebackUrl?: string;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  smtpPass?: string;
  emailFrom?: string;
  agentSenderName?: string;
  agentSenderTitle?: string;
  replyToEmail?: string;
  managerEmail?: string;
  whatsappUrl?: string;
  whatsappToken?: string;
  whatsappFrom?: string;
  manychatApiKey?: string;
  manychatFlowNs?: string;
  manychatTag?: string;
  manychatChannel?: 'whatsapp' | 'instagram' | 'messenger' | 'sms';
  /** WhatsApp follow-ups for leads: the ManyChat automations (approved templates), and the switch. */
  whatsappFollowups?: { on?: boolean; nudgeFlow?: string; videoFlow?: string; perDay?: number; addContacts?: boolean };
  defaultChannel?: OutreachChannel;
  tutorLanguage?: TutorLanguage;
  academyFocus?: string;
  requireApproval?: boolean;
  autoRunMode?: boolean;
  liveOutreachEnabled?: boolean;
  testRecipientEmail?: string;
  onboardingCompleted?: boolean;
  building?: BuildingConfig;
  /** Google Sheets (and webhook-fed lists) the agents read: the student tracker, fees, leads, prospects. */
  dataSources?: DataSource[];
  /** What every agent should know: programmes, fees, intakes, links, policies. */
  agentKnowledge?: string;
  /** Where leads apply (used by the admissions agents). */
  applyUrl?: string;
  /** Who gets each kind of escalation (comma-separated emails); unset kinds go to managerEmail. */
  escalations?: Partial<Record<'admissions' | 'support' | 'academic' | 'placement' | 'finance' | 'reports', string>>;
  /** The departments autopilot runs (empty: all). Other departments' agents run only when someone presses Run. */
  autopilotDepartments?: string[];
  /** Qualified leads go to the sales team: a Discord channel and the dialer. */
  handoff?: { discordWebhook?: string; dialerUrl?: string; dialerKey?: string; dialerOn?: boolean; reportOn?: boolean };
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  webhookSecret: string;
  requireApproval: boolean;
  liveOutreachEnabled?: boolean;
  onboardingCompleted?: boolean;
  building?: BuildingConfig;
}

export interface UserSummary {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'advisor';
  tenantId: string;
  createdAt: number;
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
  agentName?: string;
  officeName?: string;
  /** The email exactly as it will look (saved messages, vouchers, results), for the approval preview. */
  html?: string;
  /** A held email that is sent as it is when approved (no agent run behind it). */
  mail?: { to: string; toName: string; subject: string; html: string; text: string; link: string | null; fromName?: string; headers?: Record<string, string> };
  /** A saved message or voucher held for approval: sent (and booked) from the library when approved. */
  library?: { messageId?: string; voucherOfferId?: string; personalLine?: string; channel?: MessageChannel };
}

/** A narrated slide lesson: the "video" a learner watches before the quiz. */
/** How a lesson slide is staged in the video player.
 *  greeting · flow (things moving through stages) · branch (one thing, two outcomes) ·
 *  compare (mistake vs fix) · code (typed, a line highlighted) · analogy (everyday thing ≈ concept) ·
 *  big (one number or word) · recap · cta. 'concept' and 'steps' are kept for older lessons. */
export type SlideVisual = 'greeting' | 'flow' | 'branch' | 'compare' | 'code' | 'analogy' | 'big' | 'recap' | 'cta' | 'concept' | 'steps'
  /* A lead's programme video: a real photo, facts, a price card, the months ahead, the jobs it leads to. */
  | 'photo' | 'facts' | 'price' | 'timeline' | 'careers';
/** @deprecated Lessons use one brand accent now; kept so older lessons still load. */
export type SlideAccent = 'orange' | 'teal' | 'violet' | 'blue' | 'rose' | 'amber';
/** A thing on screen: an icon and a two- or three-word label. */
export interface SceneNode { label: string; icon?: string; note?: string; code?: string }
/** What a scene draws. The narration explains; the screen shows, with very few words. */
export interface LessonScene {
  /** flow: 3 to 5 stages, left to right. recap: the things to remember. */
  nodes?: SceneNode[];
  /** branch: one thing that ends one of two ways. */
  from?: SceneNode;
  yes?: SceneNode;
  no?: SceneNode;
  /** compare (left = the mistake, right = the fix) and analogy (left = everyday thing, right = the concept). */
  left?: SceneNode;
  right?: SceneNode;
  /** big: one number or short phrase, and a caption. code: the callout. */
  value?: string;
  caption?: string;
  /** code: the line numbers (1-based) the scene points at. */
  highlight?: number[];
  /** price: up to three prices ("Accredited", was "R 74 999", now "R 37 499", "paid in full by 15 Dec"). */
  rows?: { label: string; was?: string; now: string; note?: string }[];
  /** photo: a small line above the headline ("Our Rosebank hub"). */
  kicker?: string;
}
export interface LessonSlide { heading: string; points: string[]; code?: string; say: string; visual?: SlideVisual; accent?: SlideAccent; scene?: LessonScene }
export interface Lesson {
  title: string;
  slides: LessonSlide[];
  viaAi: boolean;
  /** The personal opening line ("Hey Nigel, how are you? I noticed…"). */
  greeting?: string;
  /** The tutor who "presents" the video (the Learning & Assessment agent). */
  tutorName?: string;
  academyName?: string;
  /** Length of the test the lesson leads into. */
  questionCount?: number;
  passMark?: number;
}

/** What the tutor noticed about the learner: the reason the lesson exists. */
export interface LessonEvidence {
  scorePct?: number | null;
  passMark?: number | null;
  assessmentTitle?: string | null;
  daysSinceLogin?: number | null;
  missedTopics?: string[];
  missedCount?: number;
}

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
  /** What was noticed about the learner when this pack was made. */
  evidence?: LessonEvidence | null;
  passMark: number;
  status: 'pending' | 'completed';
  result: QuizResult | null;
}

export type AuditVerdict = { pass: boolean; notes: string[] };

/* ── Workflows & persistent follow-ups ───────────────────────────────────── */

export interface MissedQuestion {
  prompt: string;
  givenAnswer?: string;
  correctAnswer?: string;
  topic?: string;
}

export type WorkflowTrigger =
  | 'quiz.failed'
  | 'attendance.missed'
  | 'assignment.missed'
  | 'payment.overdue'
  | 'invoice.unpaid'
  | 'login.gap'
  | 'webhook.custom'
  | 'whatsapp.inbound'
  | 'contact.created'
  | 'schedule'
  | 'manual';

export type WorkflowDomain = 'academy' | 'finance' | 'admissions' | 'support' | 'custom';

export type FlowNodeType =
  | 'trigger'
  | 'ai_task'
  | 'send_email'
  | 'send_whatsapp'
  | 'send_manychat'
  | 'ai_call'
  | 'followup'
  | 'wait'
  | 'condition'
  | 'audit'
  | 'http'
  | 'handoff'
  | 'tag'
  | 'end';

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  position: { x: number; y: number };
  data: {
    label: string;
    agent?: string;
    officeName?: string;
    config: Record<string, unknown>;
  };
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  label?: string;
}

/** A department is one floor of the building. */
export interface OfficeDef {
  id: string;
  name: string;
  short: string;
  domain: WorkflowDomain;
  purpose: string;
  slot: Dept;
  color: string;
  enabled: boolean;
  createdAt: number;
  /** Which department this is, so defaults and reports know what it does. */
  kind?: DepartmentKind;
  /** 1 is the ground floor. */
  floor?: number;
  /** An icon name from components/Icon. */
  icon?: string;
  /** What the department is responsible for, in a few short lines. */
  responsibilities?: string[];
}

export interface CustomAgentDef {
  id: string;
  name: string;
  title: string;
  officeId: string;
  slot: AgentId;
  persona: string;
  channels: OutreachChannel[];
  instructions: string;
  enabled: boolean;
  createdAt: number;
  /** The agent's job: the workflow it runs. */
  workflowId?: string;
  /** What this agent handles, in a few short lines. */
  responsibilities?: string[];
  color?: string;
}

export interface FlowRunStepLog {
  nodeId: string;
  label: string;
  status: 'ok' | 'fail' | 'info' | 'wait';
  detail: string;
  ts: number;
}

export interface FlowRunLog {
  id: string;
  workflowId: string;
  workflowName: string;
  officeName: string;
  targetName: string;
  targetEmail: string;
  status: 'running' | 'completed' | 'failed';
  currentNodeId: string | null;
  logs: FlowRunStepLog[];
  startedAt: number;
  endedAt: number | null;
}

export interface FollowUpCadence {
  enabled: boolean;
  intervalHours: number;
  repeatForever: boolean;
  maxAttempts: number | null;
}

export interface WorkflowDef {
  id: string;
  name: string;
  officeName: string;
  officeId?: string;
  agentId?: string;
  domain?: WorkflowDomain;
  description: string;
  enabled: boolean;
  trigger: WorkflowTrigger;
  threshold?: number;
  channel?: OutreachChannel;
  goalTemplate: string;
  instructions: string;
  followUpCadence: FollowUpCadence;
  nodes?: FlowNode[];
  edges?: FlowEdge[];
  runs: number;
  lastRunAt: number | null;
  createdAt: number;
  /** 2 = an agent workflow built from AI steps (the step builder). */
  version?: 2;
  departmentId?: string;
  /** When the agent starts. */
  agentTrigger?: AgentTrigger;
  /** What the agent does, top to bottom. */
  steps?: AgentStep[];
}

export interface FollowUpHistoryItem {
  ts: number;
  attempt: number;
  subject: string;
  note: string;
}

export interface FollowUpCase {
  id: string;
  learnerId: string;
  learnerName: string;
  learnerEmail: string;
  cohort: string;
  workflowId: string | null;
  workflowName: string;
  triggerKind: string;
  reason: string;
  link: string | null;
  moduleCode: string | null;
  topic: string | null;
  attempts: number;
  maxAttempts: number | null;
  intervalHours: number;
  repeatForever: boolean;
  nextDueAt: number;
  lastSentAt: number;
  status: 'active' | 'paused' | 'recovered' | 'resolved';
  history: FollowUpHistoryItem[];
}

/* ── Departments, agents and their AI workflows ──────────────────────────────
 *
 * The building has one floor per department. Each floor has a few agents, and
 * each agent has one job: a workflow of AI steps that starts on a trigger
 * (a new lead, a tracker row that changed, an LMS event, a schedule) and runs
 * for one record at a time, waiting for days when it needs to, until done. */

export type DepartmentKind = 'admissions' | 'b2b_sales' | 'student_success' | 'learning' | 'finance' | 'custom';

export type MessageChannel = 'email' | 'whatsapp' | 'email_whatsapp';

export type ConditionOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'empty' | 'not_empty' | 'days_until_lte' | 'days_since_gte';

/** A yes/no test on a record. Rule: a field compared with a value. AI: a question the agent answers from the record and history. */
export interface StepCondition {
  mode: 'rule' | 'ai';
  field?: string;
  op?: ConditionOp;
  value?: string;
  question?: string;
}

export type StepKind =
  | 'ai_message'     // the agent writes a personal message and sends it (email / WhatsApp)
  | 'send_library'   // send a saved, approved message from the library (no AI per person)
  | 'ai_video'       // a personal video for one lead: scenes made for them, then their programme's video
  | 'send_voucher'   // issue a voucher code (made by code from a template the team approved) and send it
  | 'take_over'      // this agent takes the person over: other agents in the department stop working on them
  | 'ai_lesson'      // personalised video lesson + N-question test, built by the tutoring team
  | 'ai_task'        // the agent works something out (qualify, research, summarise) and saves it on the record
  | 'condition'      // if / else, by rule or by the agent's judgement
  | 'wait'           // pause for hours or days, then carry on
  | 'repeat'         // follow up every N hours until a condition holds, at most N times
  | 'ai_call'        // a phone call through the dialer's AI caller
  | 'update_record'  // set a field / status on the record (and the sheet, if write-back is on)
  | 'notify_team'    // tell a person on the team, with the agent's summary
  | 'webhook'        // send the record to another system (CRM, ERP)
  | 'stop';

export interface AgentStep {
  id: string;
  kind: StepKind;
  /** Shown on the step card. */
  title: string;
  /** What the agent should do or write, in plain words. */
  instructions?: string;
  /** ai_message */
  channel?: MessageChannel;
  subject?: string;
  /** ai_message: the reviewer checks the draft before it goes. */
  review?: boolean;
  /** send_library: one specific saved message, or the best unsent one of this stage. */
  messageId?: string;
  stage?: 'welcome' | 'learn' | 'trust' | 'offer' | 'decide' | 'reengage' | 'ongoing';
  /** send_library: add one AI-written sentence from what they wrote on the form. */
  personalLine?: boolean;
  /** send_voucher: one voucher offer (empty = the best active one for them). */
  voucherOfferId?: string;
  /** repeat: a reply stops the loop (default). False: the loop pauses while they are talking, then carries on. */
  stopOnReply?: boolean;
  /** ai_lesson */
  questionCount?: number;
  passMark?: number;
  /** ai_task: the record field the result is saved to (e.g. lead_score, research_brief). */
  saveAs?: string;
  /** condition / repeat (repeat stops when this holds) */
  condition?: StepCondition;
  yes?: AgentStep[];
  no?: AgentStep[];
  /** wait: how long. repeat: how often. */
  hours?: number;
  /** repeat: at most this many rounds. */
  maxTimes?: number;
  /** repeat: what each round does. */
  steps?: AgentStep[];
  /** update_record */
  setField?: string;
  setValue?: string;
  /** notify_team: who (defaults to the manager email). */
  notifyEmail?: string;
  /** webhook */
  url?: string;
}

export type AgentTriggerKind =
  | 'record.added'    // a new row / record in a data source (a new lead, a new invoice)
  | 'record.changed'  // a field changed on a record (a score, a payment status)
  | 'record.match'    // checked on a schedule: every record that matches the rules (due in 3 days, overdue)
  | 'lead.created'    // a lead from ads / a form, through the leads webhook
  | 'lms.event'       // an LMS event (quiz failed, login gap, missed classes)
  | 'reply.received'  // a contact replied by email
  | 'schedule'        // a regular job (a weekly report)
  | 'manual';         // only when someone presses Run

export interface AgentTrigger {
  kind: AgentTriggerKind;
  /** The data source it watches (record.* triggers; optional for lead.created). */
  sourceId?: string;
  /** record.changed: the field that must change (empty = any). */
  field?: string;
  /** Only records where all of these hold. */
  match?: StepCondition[];
  /** lms.event */
  lmsEvent?: WorkflowTrigger;
  /** schedule / record.match: when to check. */
  schedule?: { every: 'hour' | 'day' | 'week'; hour?: number; weekday?: number };
  /** Do not start again for the same record within this many hours (default 72). */
  cooldownHours?: number;
}

/* ── Data sources and records ─────────────────────────────────────────────── */

export type DataSourceKind = 'students' | 'finance' | 'leads' | 'prospects' | 'custom';

/** Fields the agents understand, whatever the sheet calls its columns. */
export type RecordField =
  | 'id' | 'name' | 'first_name' | 'last_name' | 'email' | 'phone' | 'status'
  | 'programme' | 'cohort' | 'company' | 'source' | 'interest' | 'notes' | 'owner'
  | 'amount_due' | 'amount_paid' | 'total_fee' | 'due_date' | 'invoice_number' | 'payment_status' | 'last_payment_date';

export interface DataSource {
  id: string;
  name: string;
  kind: DataSourceKind;
  /** A Google Sheets link (any tab, shared "Anyone with the link: Viewer"), or empty for a list fed by webhook. */
  url: string;
  /** 'dialer': the leads the dialer holds for Thuso (tabs marked "Thuso nurtures these leads first"), read
   *  through its API instead of a sheet. Thuso nurtures them and releases each one it qualifies. */
  provider?: 'sheet' | 'dialer';
  departmentId?: string;
  /** Our field → the sheet's column header. Filled automatically, editable. */
  mapping: Partial<Record<RecordField, string>>;
  /** More tabs of the same list, each with its own columns (e.g. Meta ads, TikTok, WhatsApp leads). Read with `url`;
   *  a person on several tabs is one record. */
  tabs?: { url: string; label?: string; mapping?: Partial<Record<RecordField, string>> }[];
  /** Tab links whose first read is done: a newly added tab's rows are imported quietly, not treated as new. */
  baselined?: string[];
  enabled: boolean;
  createdAt: number;
  lastReadAt?: number | null;
  lastError?: string | null;
  rows?: number;
  columns?: string[];
}

export interface DataRecord {
  /** Stable key: email, else id, else row number. */
  key: string;
  sourceId: string;
  name: string;
  email: string;
  phone: string;
  /** Mapped fields plus every column (header in snake_case) and agent-written fields. */
  fields: Record<string, string>;
  firstSeenAt: number;
  updatedAt: number;
}

/* ── Agent runs ───────────────────────────────────────────────────────────── */

export type AgentRunStatus = 'running' | 'waiting' | 'awaiting_approval' | 'completed' | 'stopped' | 'failed';

export interface AgentRunLog {
  ts: number;
  stepId: string | null;
  title: string;
  status: 'ok' | 'info' | 'wait' | 'fail' | 'skip';
  detail: string;
  /** A message the agent wrote, kept for the run view. */
  output?: string;
}

export interface AgentRun {
  id: string;
  workflowId: string;
  workflowName: string;
  agentId: string | null;
  agentName: string;
  departmentId: string | null;
  departmentName: string;
  /** Who the run is about. fields: a snapshot for records that live outside a data source (an LMS learner). */
  record: { key: string; sourceId: string | null; name: string; email: string; phone: string; fields?: Record<string, string> };
  trigger: string;
  status: AgentRunStatus;
  /** The step to run next (null = finished). */
  cursor: string | null;
  /** repeat step id → rounds done. */
  rounds: Record<string, number>;
  /** When a waiting run continues. */
  resumeAt: number | null;
  /** The steps as they were when the run started. */
  steps: AgentStep[];
  /** What earlier steps produced: the last message, task results. */
  vars: Record<string, string>;
  logs: AgentRunLog[];
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
}
