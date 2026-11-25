import { tenantDoc } from '@/lib/engine/tenantDoc';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { log as storeLog } from '@/lib/engine/store';
import type { Candidate, Company, IdealCompany, Magnet, OutboundSettings, RunState, Spend, Stage } from './types';

/* Where B2B outbound keeps its things, per workspace: the companies (its own
 * CRM), our ideal companies, the settings, and what the research has cost. */

export const log: typeof storeLog = (actor, level, text, extra = {}) => storeLog(actor, level, text, { dept: 'b2b_sales', ...extra });

export const nid = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/* ── Settings ─────────────────────────────────────────────────────────────── */

const MAGNETS = (): Magnet[] => [
  { id: 'mg_report', name: 'The free report', about: '', link: '', when: 'open', on: true },
  { id: 'mg_toolkit', name: 'The toolkit', about: '', link: '', when: 'yes', on: true },
  { id: 'mg_12h', name: 'The 12H calculator', about: 'Shows a company what it could claim back for a learnership. The answer also tells us how many people they have in mind.', link: '', when: 'yes', on: true },
];

export const defaults = (): OutboundSettings => ({
  researchOn: false, perDay: 20, showPerDay: 10, hour: 7, budgetUsd: 50,
  about: '', services: '', ideal: '', profile: '', searchIdeas: [], signals: '', rules: '', never: '', sectors: '', provinces: '', sizeMin: 20, sizeMax: 200, avoid: '',
  writer: 'haiku', discordWebhook: '',
  sendingOn: false, checkFirst: true, checkReplies: true, sendPerDay: 5,
  smtpHost: '', smtpPort: 465, smtpUser: '', smtpPass: '', imapHost: '', fromName: '', fromTitle: '', bookingLink: '', address: '', callsWith: '',
  magnets: MAGNETS(),
});

const settingsDoc = tenantDoc<OutboundSettings>('outbound-settings', defaults);

export function settings(tenantId = currentTenantId()): OutboundSettings {
  const s = settingsDoc.get(tenantId);
  for (const [k, v] of Object.entries(defaults())) if ((s as unknown as Record<string, unknown>)[k] === undefined) (s as unknown as Record<string, unknown>)[k] = v;
  return s;
}

const mask = (v: string) => (v ? `••••${v.slice(-4)}` : '');

/** The settings a browser may see: no password, no webhook. */
export function publicSettings(tenantId = currentTenantId()): OutboundSettings {
  const s = settings(tenantId);
  return { ...s, smtpPass: mask(s.smtpPass), discordWebhook: mask(s.discordWebhook) };
}

const text = (v: unknown, old: string, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : old);
const num = (v: unknown, old: number, min: number, max: number) => { const n = Number(v); return v !== undefined && v !== '' && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : old; };
const bool = (v: unknown, old: boolean) => (typeof v === 'boolean' ? v : old);
/** A secret that was not retyped ("••••1234") is kept; an empty one is cleared. */
const secret = (v: unknown, old: string) => (typeof v !== 'string' || v.startsWith('••••') ? old : v.trim().slice(0, 400));
export const httpLink = (v: unknown): string => { try { const u = new URL(String(v || '').trim()); return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString().slice(0, 500) : ''; } catch { return ''; } };

export function saveSettings(p: Partial<Record<keyof OutboundSettings, unknown>>, tenantId = currentTenantId()): OutboundSettings {
  const s = settings(tenantId);
  const magnets = Array.isArray(p.magnets)
    ? (p.magnets as Partial<Magnet>[]).slice(0, 12).map((m) => ({ id: String(m.id || nid('mg')).slice(0, 40), name: text(m.name, '', 80), about: text(m.about, '', 400), link: httpLink(m.link), when: m.when === 'open' ? 'open' as const : 'yes' as const, on: m.on !== false })).filter((m) => m.name)
    : s.magnets;
  const next: OutboundSettings = {
    researchOn: bool(p.researchOn, s.researchOn), perDay: num(p.perDay, s.perDay, 1, 40), showPerDay: num(p.showPerDay, s.showPerDay, 1, 40), hour: num(p.hour, s.hour, 5, 16), budgetUsd: num(p.budgetUsd, s.budgetUsd, 1, 1000),
    about: text(p.about, s.about, 3000), services: text(p.services, s.services, 3000), ideal: text(p.ideal, s.ideal, 3000), profile: text(p.profile, s.profile, 4000),
    searchIdeas: Array.isArray(p.searchIdeas) ? p.searchIdeas.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, 160)).filter(Boolean).slice(0, 30) : s.searchIdeas,
    signals: text(p.signals, s.signals, 2000), rules: text(p.rules, s.rules, 4000), never: text(p.never, s.never, 2000),
    sectors: text(p.sectors, s.sectors, 600), provinces: text(p.provinces, s.provinces, 300), sizeMin: num(p.sizeMin, s.sizeMin, 1, 100000), sizeMax: num(p.sizeMax, s.sizeMax, 2, 1000000), avoid: text(p.avoid, s.avoid, 20000),
    writer: p.writer === 'sonnet' || p.writer === 'haiku' ? p.writer : s.writer,
    discordWebhook: secret(p.discordWebhook, s.discordWebhook),
    sendingOn: bool(p.sendingOn, s.sendingOn), checkFirst: bool(p.checkFirst, s.checkFirst), checkReplies: bool(p.checkReplies, s.checkReplies), sendPerDay: num(p.sendPerDay, s.sendPerDay, 1, 40),
    smtpHost: text(p.smtpHost, s.smtpHost, 120), smtpPort: num(p.smtpPort, s.smtpPort, 1, 65535), smtpUser: text(p.smtpUser, s.smtpUser, 160), smtpPass: secret(p.smtpPass, s.smtpPass), imapHost: text(p.imapHost, s.imapHost, 120),
    fromName: text(p.fromName, s.fromName, 80), fromTitle: text(p.fromTitle, s.fromTitle, 100), bookingLink: p.bookingLink !== undefined ? httpLink(p.bookingLink) : s.bookingLink, address: text(p.address, s.address, 300), callsWith: text(p.callsWith, s.callsWith, 120),
    magnets,
  };
  if (next.sizeMax < next.sizeMin) next.sizeMax = next.sizeMin;
  settingsDoc.set(next, tenantId);
  return next;
}

/** What is still missing before Thuso may search (it would not know what to look for). */
export function missingForResearch(s: OutboundSettings): string[] {
  return [
    !s.services.trim() ? 'what we sell' : '',
    !s.ideal.trim() && !s.profile.trim() ? 'what an ideal company looks like (or your list of ideal companies)' : '',
  ].filter(Boolean);
}

/** What is still missing before Thuso may write to anyone. */
export function missingForSending(s: OutboundSettings): string[] {
  return [
    !s.smtpHost || !s.smtpUser || !s.smtpPass ? 'the outreach mailbox' : '',
    !s.fromName.trim() ? 'who the emails are from' : '',
    !s.address.trim() ? 'our address (every email must say who sent it)' : '',
    !s.magnets.some((m) => m.on && m.when === 'open') ? 'something to offer in the first email' : '',
    !s.bookingLink ? 'the booking link' : '',
  ].filter(Boolean);
}

/* ── Companies ────────────────────────────────────────────────────────────── */

const companyDoc = tenantDoc<Record<string, Company>>('outbound-companies', () => ({}));
const idealDoc = tenantDoc<IdealCompany[]>('outbound-ideal', () => []);
const poolDoc = tenantDoc<Candidate[]>('outbound-pool', () => []);

export const companies = (tenantId = currentTenantId()): Company[] => Object.values(companyDoc.get(tenantId));
export const getCompany = (id: string, tenantId = currentTenantId()): Company | null => companyDoc.get(tenantId)[id] || null;
export function saveCompany(c: Company, tenantId = currentTenantId()): Company {
  c.updatedAt = Date.now();
  companyDoc.get(tenantId)[c.id] = c;
  companyDoc.save(tenantId);
  return c;
}
export const ideals = (tenantId = currentTenantId()): IdealCompany[] => idealDoc.get(tenantId);
export function saveIdeals(list: IdealCompany[], tenantId = currentTenantId()) { idealDoc.set(list.slice(0, 1000), tenantId); }
export const pool = (tenantId = currentTenantId()): Candidate[] => poolDoc.get(tenantId);
export function savePool(list: Candidate[], tenantId = currentTenantId()) { poolDoc.set(list.slice(0, 200), tenantId); }

/** A blank company, filled in by whoever found it. */
export function blankCompany(o: Partial<Company> & { name: string }): Company {
  return {
    id: nid('co'), domain: '', website: '', what: '', sector: '', city: '', province: '', size: '', employees: null, facts: [], fit: [], concerns: '', service: '', magnetId: '', like: [],
    contact: { name: '', role: '', email: '', phone: '', source: '' }, score: 0, scoreWhy: '', stage: 'found', from: 'research', foundAt: Date.now(), listedOn: '', consent: 'none', notes: '', said: {}, summary: '', nurtured: 0, thread: [], updatedAt: Date.now(), ...o,
  };
}

export function setStage(c: Company, stage: Stage, extra: Partial<Company> = {}): Company {
  Object.assign(c, extra, { stage });
  return saveCompany(c);
}

/* ── Same company, however it is written ──────────────────────────────────── */

/** "https://www.Acme.co.za/about" → "acme.co.za"; '' when it is not an address. */
export function domainOf(v: string | undefined): string {
  const t = String(v || '').trim().toLowerCase();
  if (!t) return '';
  try {
    const host = new URL(/^[a-z]+:\/\//.test(t) ? t : `https://${t}`).hostname.replace(/^www\./, '');
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : '';
  } catch { return ''; }
}

/** "Acme Holdings (Pty) Ltd" → "acme holdings". */
export const nameKey = (v: string) => v.toLowerCase().replace(/\(.*?\)/g, ' ').replace(/\b(pty|ltd|limited|proprietary|cc|inc|npc|soc|group of companies)\b\.?/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();

// Words that do not tell one company from another.
const FILLER = /\b(group|holdings?|sa|south africa|southern africa|africa|international|operations|corporation|corporate|company|the)\b/g;
const core = (v: string) => nameKey(v).replace(FILLER, ' ').replace(/\s+/g, ' ').trim() || nameKey(v);
// Too ordinary to be a company by itself ("Super Group" is not every "Super …").
const ORDINARY = new Set(['super', 'first', 'premier', 'standard', 'capital', 'national', 'african', 'global', 'united', 'general', 'metro', 'pioneer', 'liquid', 'harmony', 'builders', 'merchants']);

/** The names a company goes by: "Massmart (Walmart SA - Game/Makro)" is Massmart, Walmart, Game and Makro. */
export function nameForms(v: string): { main: string[]; also: string[] } {
  const main = v.replace(/\(.*?\)/g, ' ').split(/\s+\/\s+/).map(core).filter((x) => x.length > 1);
  const also = [...v.matchAll(/\(([^)]*)\)/g)].flatMap((m) => m[1].replace(/\b(incl(uding)?|formerly|previously|now|part of|parent|trading as|rebranded|subsidiary|franchise)\b\.?/gi, ' ').split(/\s+-\s+|[,/;&+]/)).map(core).filter((x) => x.length > 1 && !/^(group|and)$/.test(x));
  return { main, also };
}

/** The same company, or a part of the same group: "Shoprite" and "Shoprite Holdings", "Discovery Health" and
 *  "Discovery Group", "FNB" and "FirstRand (FNB, RMB)". Rather one too many than one wrongly written to. */
export function sameGroup(a: string, b: string): boolean {
  const x = nameForms(a), y = nameForms(b);
  const all = (f: typeof x) => [...f.main, ...f.also];
  if (all(x).some((n) => all(y).includes(n))) return true;
  const within = (short: string, long: string) => short.length >= 5 && !ORDINARY.has(short) && long.startsWith(`${short} `);
  return x.main.some((m) => all(y).some((n) => within(m, n) || within(n, m))) || y.main.some((m) => x.also.some((n) => within(m, n) || within(n, m)));
}

// Directories, job boards and social networks: never the company's own site.
const NOT_THEIR_SITE = /(^|\.)(linkedin|facebook|instagram|twitter|x|youtube|tiktok|wikipedia|indeed|pnet|careers24|careerjunction|glassdoor|gumtree|yellowpages|brabys|cylex|bizcommunity|news24|iol|dailymaverick|moneyweb|itweb|crunchbase|zoominfo|rocketreach|apollo|dnb|google|bing|yep|snupit|whoswho|sacci|gov|google)\.(com|co\.za|org|net|za|gov\.za|org\.za)$/;
export const theirOwnSite = (domain: string) => Boolean(domain) && !NOT_THEIR_SITE.test(domain) && !/\.gov\.za$/.test(domain);

/** The lines of "never contact", as domains and names. */
export function avoidList(s: OutboundSettings): { domains: Set<string>; names: Set<string> } {
  const domains = new Set<string>();
  const names = new Set<string>();
  for (const line of s.avoid.split(/[\n;]+/)) for (const part of line.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const d = domainOf(t.includes('@') ? t.split('@')[1] : t);
    if (d && /\./.test(t)) domains.add(d); else if (nameKey(t)) names.add(nameKey(t));
  }
  return { domains, names };
}

/** Why a company must not be researched or written to, or ''. Checked again at every step. */
export function blockedReason(o: { name: string; domain: string }, tenantId = currentTenantId(), exceptId = ''): string {
  const s = settings(tenantId);
  const avoid = avoidList(s);
  const key = nameKey(o.name);
  if ((o.domain && avoid.domains.has(o.domain)) || (key && (avoid.names.has(key) || [...avoid.names].some((n) => sameGroup(n, o.name))))) return 'on the never-contact list';
  // One of our ideal companies by its own name or website: what it is marked as. Otherwise anything of the same
  // group is left alone as well.
  const list = ideals(tenantId);
  const ideal = list.find((x) => (o.domain && x.domain === o.domain) || (key && nameKey(x.name) === key));
  if (ideal) { if (ideal.use === 'pattern') return 'one of our ideal companies marked "learn from it only"'; } else {
    const kin = key ? list.find((x) => x.use === 'pattern' && sameGroup(x.name, o.name)) : undefined;
    if (kin) return `part of ${kin.name}, which is marked "learn from it only"`;
  }
  const twin = companies(tenantId).find((c) => c.id !== exceptId && ((o.domain && c.domain === o.domain) || (key && nameKey(c.name) === key)));
  if (twin) return `already here (${twin.name})`;
  return '';
}

/* ── The day's run, and what it cost ──────────────────────────────────────── */

const SAST_MS = 2 * 3_600_000; // South Africa: UTC+2 all year
export const sastDay = (now = Date.now()) => new Date(now + SAST_MS).toISOString().slice(0, 10);
export const sastHour = (now = Date.now()) => new Date(now + SAST_MS).getUTCHours() + new Date(now + SAST_MS).getUTCMinutes() / 60;
export const isWeekday = (now = Date.now()) => { const d = new Date(now + SAST_MS).getUTCDay(); return d !== 0 && d !== 6; };

const blankRun = (): RunState => ({ day: '', researched: 0, kept: 0, extra: 0, done: false, dry: 0, posted: false, angle: 0, doing: '', lastError: '', lastErrorAt: 0, lastSendAt: 0, sentDay: '', sentToday: 0, mail: { uidValidity: '', lastUid: 0, lastCheck: null, lastError: '' } });
const runDoc = tenantDoc<RunState>('outbound-run', blankRun);
export function runState(tenantId = currentTenantId()): RunState { const r = runDoc.get(tenantId); r.mail ||= blankRun().mail; return r; }
export const saveRun = (tenantId = currentTenantId()) => runDoc.save(tenantId);

const spendDoc = tenantDoc<Spend>('outbound-spend', () => ({ month: '', usd: 0, searches: 0, calls: 0, companies: 0, days: {} }));
export function spend(tenantId = currentTenantId(), now = Date.now()): Spend {
  const month = sastDay(now).slice(0, 7);
  const s = spendDoc.get(tenantId);
  if (s.month !== month) { const fresh: Spend = { month, usd: 0, searches: 0, calls: 0, companies: 0, days: {} }; spendDoc.set(fresh, tenantId); return fresh; }
  return s;
}

/* US dollars per million tokens (Haiku costs more for a prompt over 100,000 tokens), and per search. An unknown
 * model is priced as a large one, so the limit is never passed by mistake. */
const PRICES: [RegExp, { in: number; out: number }, { in: number; out: number }?][] = [
  [/haiku-5-5/, { in: 0.1, out: 0.5 }, { in: 0.5, out: 2.5 }],
  [/haiku/, { in: 1, out: 5 }],
  [/sonnet-5/, { in: 2, out: 10 }],
];
const SEARCH_USD = 0.01;

export interface Usage { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; server_tool_use?: { web_search_requests?: number | null } | null }

export function costOf(model: string, u: Usage): number {
  const fresh = Number(u.input_tokens || 0), read = Number(u.cache_read_input_tokens || 0), write = Number(u.cache_creation_input_tokens || 0);
  const row = PRICES.find(([re]) => re.test(model));
  const p = !row ? { in: 5, out: 25 } : row[2] && fresh + read + write > 100_000 ? row[2] : row[1];
  return (fresh * p.in + read * p.in * 0.1 + write * p.in * 1.25 + Number(u.output_tokens || 0) * p.out) / 1e6 + Number(u.server_tool_use?.web_search_requests || 0) * SEARCH_USD;
}

export function addSpend(model: string, u: Usage, tenantId = currentTenantId(), now = Date.now()): number {
  const s = spend(tenantId, now);
  const usd = costOf(model, u);
  s.usd += usd;
  s.calls++;
  s.searches += Number(u.server_tool_use?.web_search_requests || 0);
  s.days[sastDay(now)] = (s.days[sastDay(now)] || 0) + usd;
  spendDoc.save(tenantId);
  return usd;
}
export function countCompany(tenantId = currentTenantId()) { spend(tenantId).companies++; spendDoc.save(tenantId); }

/** Weekdays left in this month, today included. */
export function weekdaysLeft(now = Date.now()): number {
  const month = sastDay(now).slice(0, 7);
  let n = 0;
  for (let t = now; sastDay(t).slice(0, 7) === month; t += 86_400_000) if (isWeekday(t)) n++;
  return Math.max(1, n);
}

/** What may still be spent: this month, and today (the month's rest shared over its weekdays, with a little slack). */
export function room(tenantId = currentTenantId(), now = Date.now()): { month: number; today: number; cap: number; spentToday: number } {
  const s = spend(tenantId, now);
  const spentToday = s.days[sastDay(now)] || 0;
  const budget = settings(tenantId).budgetUsd;
  const month = Math.max(0, budget - s.usd);
  const cap = Math.min(month + spentToday, ((month + spentToday) / weekdaysLeft(now)) * 1.25);
  return { month, today: Math.max(0, Math.min(month, cap - spentToday)), cap, spentToday };
}
