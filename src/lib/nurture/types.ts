import type { LessonSlide, MessageChannel, StepCondition } from '@/lib/types';

/* Lead nurturing: the shapes shared by the server and the Nurture page.
 *
 * The idea in one line: write once, send to many. Messages are written (by a
 * person or by AI) once, checked once, approved once, and then sent to every
 * lead that fits, with their name and programme merged in and every link
 * tracked. AI writes for one person only when that person has earned it (a
 * hot lead), which keeps the cost per lead close to zero. */

/** Where a lead is in their decision, and what a message is for. */
export type NurtureStage = 'welcome' | 'learn' | 'trust' | 'offer' | 'decide' | 'reengage';
export const NURTURE_STAGES: NurtureStage[] = ['welcome', 'learn', 'trust', 'offer', 'decide', 'reengage'];
export const STAGE_LABEL: Record<NurtureStage, string> = {
  welcome: 'Welcome',
  learn: 'Learn (value)',
  trust: 'Trust (proof)',
  offer: 'Offer',
  decide: 'Decide (apply)',
  reengage: 'Re-engage',
};

export type Audience = 'everyone' | 'parents' | 'school_leavers' | 'career_changers' | 'working';
export const AUDIENCES: Audience[] = ['everyone', 'parents', 'school_leavers', 'career_changers', 'working'];
export const AUDIENCE_LABEL: Record<Audience, string> = {
  everyone: 'Everyone',
  parents: 'Parents',
  school_leavers: 'School leavers',
  career_changers: 'Career changers',
  working: 'Working people',
};

/** How engaged a lead is, from what they opened, clicked, watched and answered. */
export type Engagement = 'cold' | 'warm' | 'hot';

/* ── The content bank ─────────────────────────────────────────────────────── */

export type ResourceKind = 'pdf' | 'video' | 'link' | 'note' | 'faq';

export interface NurtureResource {
  id: string;
  kind: ResourceKind;
  title: string;
  /** A link (YouTube, an article, a page on our site). */
  url?: string;
  /** An uploaded file (a PDF guide), served through a tracked link. */
  fileId?: string;
  fileName?: string;
  size?: number;
  /** One or two sentences: what it is and who it helps. Written once, when added. */
  summary: string;
  /** One line an email can use to introduce it. */
  hook: string;
  audience: Audience[];
  /** Programmes it fits (empty = any). */
  programmes: string[];
  stage: NurtureStage | 'any';
  /** What the agents may quote: a note, FAQs (from WhatsApp), the gist of a PDF. */
  text?: string;
  /** A picture for the email card (a YouTube thumbnail). */
  thumb?: string;
  origin: 'upload' | 'youtube' | 'whatsapp' | 'manual' | 'website';
  enabled: boolean;
  /** 'ai' when the model read it; 'basic' when only the title was used. */
  digest: 'ai' | 'basic';
  createdAt: number;
  updatedAt: number;
  stats: { sent: number; clicks: number };
}

/* ── The message library ──────────────────────────────────────────────────── */

/** Where the main button in a message goes. */
export type CtaTarget = 'enrol' | 'call' | 'apply' | 'quiz' | 'video' | 'resource' | 'reply' | 'url';
export const CTA_LABEL: Record<CtaTarget, string> = {
  enrol: 'Yes, I want to enrol (a Student Advisor calls them)',
  call: 'Call me (a Student Advisor calls them)',
  apply: 'Start the application',
  quiz: 'Career-fit quiz',
  video: 'Their personal programme video',
  resource: 'A resource from the bank',
  reply: 'Reply to the email',
  url: 'A link',
};

export interface NurtureMessage {
  id: string;
  /** Internal name ("Welcome + parents' guide"). */
  name: string;
  stage: NurtureStage;
  audience: Audience;
  /** Only for leads interested in this programme (empty = everyone). */
  programme: string;
  /** Only for leads who pay this way (empty = everyone). A lead whose answer is unknown still gets it. */
  funding?: ('self' | 'family' | 'loan' | 'employer' | 'undecided')[];
  channel: MessageChannel;
  /** With merge fields: {{first_name}}, {{programme}}, {{academy}}, {{sender}}. */
  subject: string;
  body: string;
  /** The WhatsApp version (short). Made from the body when empty. */
  waBody?: string;
  cta: { target: CtaTarget; label: string; resourceId?: string; url?: string };
  /** Resources shown as cards under the message. */
  resourceIds: string[];
  /** A voucher this message gives: each lead gets their own code (made by code, not AI). */
  voucherOfferId?: string;
  /** Can go again with a different guide or video each time (the 'something useful' message). */
  repeatable?: boolean;
  status: 'draft' | 'approved' | 'archived';
  /** An offer that ends: not sent after this. */
  expiresAt: number | null;
  origin: 'ai' | 'person' | 'starter';
  /** The reviewer's rules, run once when it is saved. */
  check: { pass: boolean; notes: string[] };
  approvedBy?: string;
  approvedAt?: number;
  createdAt: number;
  updatedAt: number;
  stats: { sent: number; opened: number; clicked: number };
}

/* ── Campaigns: one saved message to a group, now or later ────────────────── */

export interface NurtureCampaign {
  id: string;
  name: string;
  messageId: string;
  sourceId: string;
  /** Who gets it: all of these must hold. */
  segment: StepCondition[];
  sendAt: number;
  status: 'scheduled' | 'sending' | 'done' | 'cancelled';
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  /** Record keys still to send. */
  queue: string[];
  createdAt: number;
  createdBy: string;
  finishedAt: number | null;
}

/* ── The career-fit quiz (one per academy, made once) ─────────────────────── */

export interface FitTrack {
  id: string;
  /** "The Builder" */
  name: string;
  /** The programme it leads to. */
  programme: string;
  tagline: string;
  /** Why it fits, in two sentences, spoken to the lead. */
  why: string;
  icon: string;
}

export interface FitQuestion {
  id: string;
  prompt: string;
  icon: string;
  options: { label: string; track: string }[];
}

export interface FitQuiz {
  title: string;
  intro: string;
  tracks: FitTrack[];
  questions: FitQuestion[];
  viaAi: boolean;
  createdAt: number;
}

/* ── Programme videos (one per programme, personalised when played) ───────── */

export interface ProgrammeVideo {
  id: string;
  programme: string;
  title: string;
  /** Slides 1..n (the greeting is made per lead when it plays). */
  slides: LessonSlide[];
  tutorName: string;
  viaAi: boolean;
  createdAt: number;
  views: number;
  /** The script mentions an offer that ends on this day: the video is rewritten after it. */
  validUntil?: number | null;
  /** The price scene for viewers who need a student loan (offers do not apply to them): it replaces "price" for them. */
  loanPrice?: LessonSlide | null;
}

/* ── Counters: how much of the nurturing AI actually wrote ────────────────── */

export interface NurtureStats {
  /** Saved messages sent (no AI). */
  librarySends: number;
  /** Messages AI wrote for one lead (hot leads). */
  aiSends: number;
  /** One AI sentence added to a saved message (from what they wrote on the form). */
  aiLines: number;
  /** AI calls spent writing or digesting for the library and bank (once each). */
  aiBuilds: number;
  opens: number;
  clicks: number;
  quizzes: number;
  videoViews: number;
  optOuts: number;
}

/** What a tracked link carries (signed, so nobody can forge one). */
/* ── Vouchers: templates the team approves, codes made by code ─────────────── */

export interface VoucherOffer {
  id: string;
  /** "Quiz thank-you", "Black Friday" */
  name: string;
  /** Rand off, or a percentage off. */
  kind: 'amount' | 'percent';
  value: number;
  /** "the registration fee", "your first month's fees" */
  appliesTo: string;
  /** Ends on a date (a promotion), or N days after it is given (a personal voucher). */
  expiry: { kind: 'date'; date: number } | { kind: 'days'; days: number };
  /** May be passed on to a friend (who then comes in as a lead). */
  shareable: boolean;
  /** Code prefix, e.g. MEL or BF. */
  prefix: string;
  /** The email that carries it (merge fields: first_name, voucher_code, voucher_value, voucher_expires, voucher_for). */
  subject: string;
  body: string;
  /** Only active offers are given out. */
  status: 'draft' | 'active' | 'paused';
  /** At most this many codes (empty = no limit). */
  maxIssued: number | null;
  approvedBy?: string;
  createdAt: number;
  updatedAt: number;
  stats: { issued: number; redeemed: number; shared: number };
}

export interface Voucher {
  code: string;
  offerId: string;
  sourceId: string;
  leadKey: string;
  leadName: string;
  issuedAt: number;
  expiresAt: number;
  status: 'issued' | 'redeemed' | 'cancelled';
  redeemedAt?: number;
  redeemedBy?: string;
  /** Friends who claimed it through the share link (lead keys). */
  referred: string[];
  /** Given to a team member's sample lead: never counted. */
  preview?: boolean;
}

/* ── Footage and music for the videos ─────────────────────────────────────── */

/** What a clip shows, so each scene gets fitting footage (the team picks; photos are tagged by AI once). */
export const FOOTAGE_TAGS = ['welcome', 'team', 'students', 'classroom', 'coding', 'laptop', 'campus', 'celebration', 'graduation', 'city', 'office', 'data', 'security', 'ai'] as const;

export interface MediaItem {
  id: string;
  kind: 'video' | 'photo' | 'music';
  fileId: string;
  title: string;
  tags: string[];
  description: string;
  mime: string;
  size: number;
  enabled: boolean;
  createdAt: number;
}

export interface TrackPayload {
  /** tenant */
  t: string;
  /** source id */
  s: string;
  /** record key */
  k: string;
  /** message id (or 'run' for an agent-written one) */
  m: string;
  /** what the link opens */
  x: CtaTarget | 'open' | 'unsub' | 'res';
  /** resource id */
  r?: string;
  /** a plain link */
  u?: string;
}
