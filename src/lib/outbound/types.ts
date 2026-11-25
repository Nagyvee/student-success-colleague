/* B2B outbound: Thuso finds companies that look like our ideal ones, people
 * choose, and Thuso starts the conversation. Shared types (server and page). */

export type Stage = 'found' | 'approved' | 'contacted' | 'talking' | 'qualified' | 'call_booked' | 'won' | 'lost' | 'rejected';

/** The pipeline, in order. (Rejected companies are kept, so they are never found again.) */
export const PIPELINE: { id: Stage; label: string; hint: string }[] = [
  { id: 'found', label: 'Found', hint: 'Waiting for a yes or no' },
  { id: 'approved', label: 'Approved', hint: 'First email being checked' },
  { id: 'contacted', label: 'Contacted', hint: 'Asked once, waiting' },
  { id: 'talking', label: 'Talking', hint: 'They said yes or asked something' },
  { id: 'qualified', label: 'Qualified', hint: 'Ready for a call' },
  { id: 'call_booked', label: 'Call booked', hint: 'With the team' },
  { id: 'won', label: 'Won', hint: 'A client' },
  { id: 'lost', label: 'Lost', hint: 'No, or no answer' },
];

export const STAGE_LABEL: Record<Stage, string> = { ...Object.fromEntries(PIPELINE.map((s) => [s.id, s.label])), rejected: 'Not for us' } as Record<Stage, string>;

/** Why a company is not for us: Thuso looks for fewer like it. */
export const REJECT_REASONS = ['Too big', 'Too small', 'Wrong sector', 'Wrong place', 'Already talking to them', 'Not a real fit'] as const;

/** Something true about a company, and the page that says it. `sign`: which sign that it may need us it shows, when it shows one. */
export interface Fact { text: string; url: string; sign?: string }

/** "160+ (global, five offices)" as people read it: "160+ people". Without a number it says nothing. */
export function peopleOf(size: string): string {
  const t = size.split(/[(;]/)[0].trim();
  return !/\d/.test(t) ? '' : /people|staff|employees|experts|specialists|consultants|engineers/i.test(t) ? t : `${t} people`;
}

/** Is it one to choose from: on a day's list and good enough (or added by a person)? */
export const onList = (c: { listedOn: string; score: number; from: string }, min: number) => Boolean(c.listedOn) && (c.from === 'manual' || c.score >= min);

export interface Contact { name: string; role: string; email: string; phone: string; /** The page the address was read on. */ source: string }

export interface Message {
  id: string;
  who: 'us' | 'them';
  kind: 'first' | 'reply' | 'nurture' | 'in';
  subject: string;
  text: string;
  at: number;
  /** draft: a person checks it. ready: goes when it is due. sent, failed: what happened. */
  status: 'draft' | 'ready' | 'sent' | 'failed' | 'in';
  messageId?: string;
  error?: string;
  /** Magnets this message hands over. */
  magnets?: string[];
  by?: string;
}

/** What a company told us, read from its replies. */
export interface Qualified { need?: string; people?: string; budget?: string; timing?: string; decider?: string }

export interface Company {
  id: string;
  name: string;
  domain: string;
  website: string;
  what: string;
  sector: string;
  city: string;
  province: string;
  /** Employees, as the source says it ("about 80"), and the number used to compare. */
  size: string;
  employees: number | null;
  facts: Fact[];
  /** Why it fits us, in a line each. */
  fit: string[];
  concerns: string;
  /** What we would sell it, and what we would open with. */
  service: string;
  magnetId: string;
  /** Ideal companies it looks like. */
  like: string[];
  contact: Contact;
  score: number;
  scoreWhy: string;
  stage: Stage;
  from: 'research' | 'ideal' | 'manual';
  foundAt: number;
  /** The day it was on the daily list (YYYY-MM-DD), or ''. */
  listedOn: string;
  decidedAt?: number;
  decidedBy?: string;
  rejectReason?: string;
  lostReason?: string;
  /** POPIA: asked once; yes lets us keep writing; no means never again. */
  consent: 'none' | 'asked' | 'yes' | 'no';
  contactedAt?: number;
  lastAt?: number;
  qualifiedAt?: number;
  toldAt?: number;
  callAt?: string;
  value?: string;
  owner?: string;
  notes: string;
  said: Qualified;
  summary: string;
  nurtured: number;
  thread: Message[];
  updatedAt: number;
}

/** One of our ideal companies. `pattern`: learn from it, never contact it (the team may be talking to it already). `research`: it may be researched and contacted too. */
export interface IdealCompany { id: string; name: string; domain: string; sector: string; size: string; province: string; note: string; use: 'pattern' | 'research' }

/** Something free we can give. `open`: what the first email offers. `yes`: sent once they are interested. */
export interface Magnet { id: string; name: string; about: string; link: string; when: 'open' | 'yes'; on: boolean }

export interface OutboundSettings {
  researchOn: boolean;
  perDay: number;
  showPerDay: number;
  /** A company is only put on the list with this score or more. */
  minScore: number;
  hour: number;
  budgetUsd: number;
  about: string;
  services: string;
  ideal: string;
  /** The pattern Thuso read from the ideal companies (it can be edited). */
  profile: string;
  searchIdeas: string[];
  /** What shows a company may need us now (one per line). */
  signals: string;
  /** How we speak, and to whom about what. */
  rules: string;
  /** Words no email may have, one per line; "92% only with reported" allows one only beside the other. */
  never: string;
  sectors: string;
  provinces: string;
  sizeMin: number;
  sizeMax: number;
  avoid: string;
  writer: 'haiku' | 'sonnet';
  discordWebhook: string;
  sendingOn: boolean;
  checkFirst: boolean;
  checkReplies: boolean;
  sendPerDay: number;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  imapHost: string;
  fromName: string;
  fromTitle: string;
  bookingLink: string;
  address: string;
  callsWith: string;
  magnets: Magnet[];
}

export interface Candidate { name: string; website: string; domain: string; why: string; url: string; from: 'research' | 'ideal'; /** The sign it was found for. */ sign?: string }

export interface RunState {
  /** The day the numbers are for (YYYY-MM-DD, South African time). */
  day: string;
  researched: number;
  kept: number;
  /** Good companies someone asked for on top of the daily ones ("Find 5 now"), and how many more may be looked at to find them. */
  extra: number;
  looks?: number;
  /** "Find 5 now" stops when the month's spending reaches this (US dollars). */
  stopAt?: number;
  done: boolean;
  /** Rounds in a row that found nobody new. */
  dry: number;
  posted: boolean;
  angle: number;
  doing: string;
  lastError: string;
  lastErrorAt: number;
  lastSendAt: number;
  /** The mailbox refused: nothing is sent before this. */
  pausedUntil?: number;
  sentDay: string;
  sentToday: number;
  mail: { uidValidity: string; lastUid: number; lastCheck: number | null; lastError: string };
}

/** What the AI was asked for: to find names, to read about a company, to write. */
export type AskKind = 'find' | 'read' | 'write';

export interface Spend { month: string; usd: number; searches: number; calls: number; companies: number; days: Record<string, number>; kinds?: Partial<Record<AskKind, { usd: number; calls: number }>> }
