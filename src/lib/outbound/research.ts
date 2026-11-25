import { currentTenantId } from '@/lib/auth/tenantContext';
import { getAcademyContext } from '@/lib/auth/accounts';
import { parseCsv } from '@/lib/lms/sheet';
import { ask, jsonOf, type Answer } from './ask';
import { REJECT_REASONS, type Candidate, type Company, type Fact, type IdealCompany, type OutboundSettings } from './types';
import { blankCompany, blockedReason, companies, domainOf, httpLink, ideals, nameKey, nid, saveIdeals, saveSettings, theirOwnSite, told } from './store';

/* Finding companies that look like our ideal ones.
 *
 *   readIdeals   the list people paste or upload (a company per line)
 *   learnIdeals  what those companies have in common, as words people can edit
 *   discover     a few web searches for new companies like them, small ones
 *                first, learning from what people said no to
 *   research     one company: its own site and a search or two
 *
 * Nothing the AI says is taken on trust: a fact must come from a page it
 * really opened, and an email address must be written on one of them. */

const str = (v: unknown, max = 200) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : '');
const list = (v: unknown, n = 6, max = 200) => (Array.isArray(v) ? v.map((x) => str(x, max)).filter(Boolean).slice(0, n) : []);
const split = (v: string) => v.split(/[,;\n]+/).map((x) => x.trim()).filter(Boolean);
/** A few words, never cut inside one. */
const brief = (v: unknown, max: number) => { const t = str(v, 2000); return t.length <= max ? t : t.slice(0, max + 1).replace(/\s+\S*$/, ''); };

/* ── Our ideal companies ──────────────────────────────────────────────────── */

const COLS: Record<string, RegExp> = {
  name: /^(company|company name|name|organisation|organization|business|client)$/i, domain: /^(website|web ?site|domain|url|web)$/i, sector: /^(sector|industry|type)$/i,
  size: /^(size|employees|staff|headcount|people)$/i, province: /^(province|region|location|city|area)$/i, note: /^(note|notes|comment|why)$/i, use: /^(use|contact|status)$/i,
};

/** A pasted or uploaded list (CSV, tabs, or one name per line). "ok to contact" in a use column lets Thuso contact them too. */
export function readIdeals(raw: string): IdealCompany[] {
  const body = raw.replace(/^﻿/, '').trim();
  if (!body) return [];
  const top = body.split(/\r?\n/).slice(0, 8).join('\n');
  const rows = top.includes('\t') ? body.split(/\r?\n/).map((l) => l.split('\t')) : top.includes(';') && !top.includes(',') ? body.split(/\r?\n/).map((l) => l.split(';')) : parseCsv(body);
  const head = rows[0].map((h) => Object.keys(COLS).find((k) => COLS[k].test(h.trim())) || '');
  const named = head.includes('name');
  const out: IdealCompany[] = [];
  const seen = new Set<string>();
  for (const r of named ? rows.slice(1) : rows) {
    const get = (k: string) => (named ? str(r[head.indexOf(k)], 200) : '');
    const name = named ? get('name') : str(r[0], 200);
    // Without headings: the first thing that looks like an address is the website.
    const domain = domainOf(named ? get('domain') : r.slice(1).find((x) => theirOwnSite(domainOf(x))) || '');
    const key = domain || nameKey(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    out.push({ id: nid('id'), name, domain, sector: get('sector') || (named ? '' : str(r.slice(1).find((x) => x && !domainOf(x)), 80)), size: get('size'), province: get('province'), note: get('note'), use: /ok|research|yes/i.test(get('use')) ? 'research' : 'pattern' });
    if (out.length >= 1000) break;
  }
  return out;
}

/** Adds a list to what is there (the same company is not added twice; a new row fills in what was missing). */
export function addIdeals(raw: string): { added: number; total: number } {
  const all = ideals().slice();
  let added = 0;
  for (const x of readIdeals(raw)) {
    const same = all.find((y) => (x.domain && y.domain === x.domain) || nameKey(y.name) === nameKey(x.name));
    if (!same) { all.push(x); added++; continue; }
    for (const k of ['domain', 'sector', 'size', 'province', 'note'] as const) if (!same[k] && x[k]) same[k] = x[k];
    if (x.use === 'research') same.use = 'research';
  }
  saveIdeals(all);
  return { added, total: all.length };
}

/** What the ideal companies have in common, in words (people can change them). */
export async function learnIdeals(): Promise<{ ok: boolean; detail: string }> {
  const all = ideals();
  if (all.length < 3) return { ok: false, detail: 'Add at least three ideal companies first.' };
  const s = told();
  // A list without details: a few are looked up.
  const bare = all.filter((x) => !x.sector).length > all.length / 2;
  const a = await ask({
    system: `You study the ideal clients of ${getAcademyContext().academyName}, a South African technology academy that sells training to companies. ${s.services ? `What it sells: ${s.services}` : ''}`,
    prompt: `These are companies it would love to have as clients:\n${all.slice(0, 300).map((x) => `- ${[x.name, x.domain, x.sector, x.size, x.province, x.note].filter(Boolean).join(' | ')}`).join('\n')}\n\n${bare ? 'Most have no details: look up to five of the ones you do not know. ' : ''}Say what they have in common, so someone could find more companies like them. Many may be large: also say what a smaller company of the same kind (${s.sizeMin} to ${s.sizeMax} people) looks like. End with one JSON object in a code block: {"profile": "120 words at most: the kinds of business, how they work, the roles they employ in numbers, why they would train people", "sectors": ["up to 8 sectors"], "searchIdeas": ["up to 12 short web searches that would find South African companies like these"]}`,
    searches: bare ? 5 : 0, maxTokens: 5000, effort: 'medium',
  });
  const j = jsonOf<Record<string, unknown>>(a);
  const profile = str(j?.profile, 1500);
  if (!profile) return { ok: false, detail: 'The AI gave no usable answer. Try again.' };
  saveSettings({ profile, searchIdeas: list(j?.searchIdeas, 12, 160), ...(s.sectors.trim() ? {} : { sectors: list(j?.sectors, 8, 60).join(', ') }) });
  return { ok: true, detail: `Read ${Math.min(300, all.length)} companies. What they have in common is in Settings, where you can change it.` };
}

/* ── New companies ────────────────────────────────────────────────────────── */

const SIGNALS = [
  'advertising for juniors, interns, learners or graduates', 'running or announcing learnerships or skills programmes', 'growing: new branches, contracts, clients or funding',
  'hiring software, data, IT support or cybersecurity people', 'moving to new systems or going digital', 'publishing a B-BBEE certificate or skills development spend',
];

const signsOf = (s: OutboundSettings) => (s.signals.trim() ? s.signals.split(/\n+/).map((x) => x.trim()).filter(Boolean) : SIGNALS);
/** The sign with this number (or said in its own words), or ''. */
const signAt = (s: OutboundSettings, v: unknown): string => {
  const t = str(v).toLowerCase();
  const n = /^\D{0,6}(\d{1,2})\b/.exec(t);
  return (n ? signsOf(s)[Number(n[1]) - 1] : t.length > 8 ? signsOf(s).find((x) => x.toLowerCase().startsWith(t.slice(0, 40))) : '') || '';
};

/** Who we look for, the same words for both steps. */
function wanted(s: OutboundSettings): string {
  return [
    s.services && `What we sell: ${s.services}`,
    s.about && `About us: ${s.about}`,
    s.ideal && `Our ideal company: ${s.ideal}`,
    s.profile && `What our ideal companies have in common: ${s.profile}`,
    `Signs that they may need us now:\n${signsOf(s).map((x, i) => `${i + 1}. ${x}`).join('\n')}`,
    s.sectors && `Sectors: ${s.sectors}`,
    s.provinces && `Places: ${s.provinces}`,
    `Size: ${s.sizeMin} to ${s.sizeMax} employees (a smaller company decides faster; leave out large groups and their brands)`,
  ].filter(Boolean).join('\n');
}

/** What people said no and yes to lately: fewer and more like those. */
export function lessons(all: Company[]): string {
  const no = new Map<string, string[]>();
  for (const c of all.filter((x) => x.stage === 'rejected' && x.rejectReason).sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0)).slice(0, 40)) no.set(c.rejectReason!, [...(no.get(c.rejectReason!) || []), c.name]);
  const yes = all.filter((x) => x.decidedAt && x.stage !== 'rejected' && x.stage !== 'found').sort((a, b) => (b.decidedAt || 0) - (a.decidedAt || 0)).slice(0, 12).map((x) => `${x.name}${x.sector ? ` (${x.sector})` : ''}`);
  return [
    ...[...no].map(([why, names]) => `Our team said no to ${names.slice(0, 6).join(', ')}: ${why}.`),
    yes.length ? `Our team said yes to ${yes.join(', ')}.` : '',
  ].filter(Boolean).join('\n');
}

/** A different place, sector and sign to look at each time, so the searches do not find the same companies. */
export function angleOf(s: OutboundSettings, n: number): string {
  const pick = (xs: string[], step: number) => (xs.length ? xs[(n * step) % xs.length] : '');
  const idea = s.searchIdeas.length && n % 2 === 1 ? s.searchIdeas[((n - 1) / 2) % s.searchIdeas.length] : '';
  const place = pick(split(s.provinces), 1) || 'South Africa';
  const signs = signsOf(s);
  return idea ? `${idea} (${place})` : `${[pick(split(s.sectors), 1) || 'companies like our ideal ones', `in ${place}`, pick(signs, 5)].join(', ')}`;
}

const seenIn = (a: Answer, url: string) => { const u = httpLink(url); return Boolean(u) && [...a.urls].some((x) => httpLink(x).replace(/[#?].*$/, '').replace(/\/$/, '') === u.replace(/[#?].*$/, '').replace(/\/$/, '')); };
const hostSeen = (a: Answer, domain: string) => [...a.urls].some((x) => domainOf(x) === domain || domainOf(x).endsWith(`.${domain}`));

/** A few searches for companies we do not know yet. */
export async function discover(angle: number, tenantId = currentTenantId()): Promise<Candidate[]> {
  const s = told(tenantId);
  const known = [...companies(tenantId).sort((a, b) => b.foundAt - a.foundAt).slice(0, 150).map((c) => c.domain || c.name), ...ideals(tenantId).slice(0, 120).map((x) => x.domain || x.name)];
  const a = await ask({
    system: `You find companies that could become clients of ${getAcademyContext(tenantId).academyName}, a South African academy. You only list real companies you found in the searches.`,
    prompt: `${wanted(s)}\n${lessons(companies(tenantId))}\n\nLook at: ${angleOf(s, angle)}\n\nSearch the web (South African companies only) and list up to 12 companies where a page you found shows one of the signs, in about the last year, each with its own website (not a directory, job board or social page). A few strong ones are better than twelve weak ones: being the right size or sector is not a sign. A company that sells AI or software is only a fit when it is hiring or training its own people. Leave out recruiters, anyone who sells training, universities, government, South African offices of foreign groups, and these we know already: ${known.join(', ') || 'none yet'}.\n\nEnd with one JSON object in a code block: {"companies": [{"name": "", "website": "https://…", "sign": the number of the sign it shows, "why": "one line: what the page says, and when", "url": "the page you read it on"}]}`,
    searches: 6, maxTokens: 5000,
  });
  const j = jsonOf<{ companies?: Record<string, unknown>[] }>(a);
  const out: Candidate[] = [];
  for (const x of Array.isArray(j?.companies) ? j!.companies!.slice(0, 20) : []) {
    const name = str(x?.name, 120);
    const website = httpLink(x?.website) || (domainOf(str(x?.website)) ? `https://${domainOf(str(x?.website))}/` : '');
    const domain = domainOf(website);
    const url = httpLink(x?.url);
    const sign = signAt(s, x?.sign);
    if (!name || !theirOwnSite(domain) || !sign) continue;
    // It must have come up in the searches: its own site, or the page that names it.
    if (!hostSeen(a, domain) && !seenIn(a, url)) continue;
    if (out.some((y) => y.domain === domain) || blockedReason({ name, domain }, tenantId)) continue;
    out.push({ name, website, domain, why: str(x?.why, 300), url, from: 'research', sign });
  }
  return out;
}

/** Ideal companies marked "research" that were not looked at yet. */
export function idealCandidates(tenantId = currentTenantId()): Candidate[] {
  return ideals(tenantId).filter((x) => x.use === 'research' && x.domain && !blockedReason({ name: x.name, domain: x.domain }, tenantId))
    .map((x) => ({ name: x.name, website: `https://${x.domain}/`, domain: x.domain, why: x.note || 'On our list of ideal companies.', url: '', from: 'ideal' as const }));
}

/** "about 80", "50-100", "1 200 employees" → a number to compare (the middle of a range). */
export function headcount(v: string): number | null {
  const nums = v.replace(/(\d)[ , ](?=\d{3}\b)/g, '$1').match(/\d+(?:\.\d+)?\s*k?/gi)?.map((x) => (/k/i.test(x) ? parseFloat(x) * 1000 : parseFloat(x))).filter((x) => x > 0 && x < 5e6) || [];
  if (!nums.length) return null;
  return Math.round(nums.length > 1 ? (nums[0] + nums[1]) / 2 : nums[0]);
}

const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
/** Is this address really written on a page we read? ("info (at) acme.co.za" counts.) */
export function onAPage(a: Pick<Answer, 'pages'>, email: string): string {
  const want = email.toLowerCase();
  for (const [url, text] of a.pages) if (text.toLowerCase().replace(/\s*[[(]\s*at\s*[\])]\s*/g, '@').replace(/\s*[[(]\s*dot\s*[\])]\s*/g, '.').includes(want)) return url;
  return '';
}

/** One company, researched. Null when it is not for us (with why). */
export async function research(cand: Candidate, tenantId = currentTenantId()): Promise<{ company: Company | null; why: string }> {
  const stop = blockedReason(cand, tenantId);
  if (stop) return { company: null, why: stop };
  const s = told(tenantId);
  const open = s.magnets.filter((x) => x.on && x.when === 'open');
  const like = ideals(tenantId).slice(0, 80).map((x) => x.name);
  const a = await ask({
    system: `You research one company for the sales team of ${getAcademyContext(tenantId).academyName}, a South African academy. Short, factual, commercial. Every fact carries the address of the page you read it on.`,
    prompt: `${wanted(s)}\n${open.length ? `What we can offer for free first: ${open.map((x) => `${x.name} [${x.id}]${x.about ? `: ${x.about}` : ''}`).join('; ')}` : ''}\n\nThe company: ${cand.name} (${cand.website}). ${cand.why}\n\nOpen its website first (home, about, contact, careers or team pages), then search once or twice for the signs (what it did in about the last year) and its size. ${like.length ? `Our ideal companies, to compare: ${like.join(', ')}.` : ''}\n\nEnd with one JSON object in a code block:\n{"name": "as they write it", "what": "what they do, one sentence", "sector": "", "city": "", "province": "", "employees": "the number only, as the source says: 'about 80' or '50-100', or ''", "facts": [{"text": "one specific, recent fact, the strongest first", "sign": the number of the sign it shows, or 0 when it shows none (its size, offices, age or products show none), "url": "page"}], "fit": ["up to 3 reasons they would train people with us"], "concerns": "what speaks against it, one short sentence, or ''", "service": "what we would offer first, in two to six words", "sellsTraining": true when it sells training or runs an academy for others, else false, "magnet": "${open.map((x) => x.id).join('" or "') || ''}", "like": ["up to 2 of our ideal companies it resembles"], "contact": {"name": "who decides on training (HR, L&D, operations or the owner), if a page names them", "role": "", "email": "their address or the company's general one, only if it is written on a page you opened", "phone": ""}, "score": 1-10, "scoreWhy": "one line"}\nScore: 8 or more only for a strong sign in the last year, the right size and someone to write to; 6 or 7 for one clear sign and the right size; 5 or less when it only fits on paper; 4 or less when training is decided abroad or by a bigger group. If the website does not work or it is not a South African company, answer {"score": 0, "scoreWhy": "why"}.`,
    searches: 3, fetches: 4, maxTokens: 6000,
  });
  const j = jsonOf<Record<string, unknown>>(a);
  if (!j) return { company: null, why: 'the AI gave no usable answer' };
  let score = Math.max(0, Math.min(10, Math.round(Number(j.score) || 0)));
  const facts: Fact[] = (Array.isArray(j.facts) ? j.facts as Record<string, unknown>[] : [])
    .map((f) => ({ text: str(f?.text, 300), url: httpLink(f?.url), sign: signAt(s, f?.sign) })).filter((f) => f.text && (seenIn(a, f.url) || a.pages.has(f.url)))
    // One that shows a sign comes first: it is what an email starts with.
    .sort((x, y) => Number(Boolean(y.sign)) - Number(Boolean(x.sign))).slice(0, 6);
  if (score < 1) return { company: null, why: str(j.scoreWhy, 160) || 'not a fit' };
  if (j.sellsTraining === true && cand.from !== 'ideal') return { company: null, why: 'it sells training itself' };
  if (!facts.length) return { company: null, why: 'nothing about it could be checked on a page' };
  const size = brief(str(j.employees).split(/[(;]/)[0], 40).trim();
  const employees = headcount(size);
  // Right on paper is not a reason to write: without a sign on a page it is never one of the best.
  if (!facts.some((f) => f.sign)) score = Math.min(score, 5);
  // Small first: one far too big is left out (unless it is on our own list).
  if (cand.from !== 'ideal' && employees && employees > s.sizeMax * 1.5) return { company: null, why: `too big (${size})` };
  if (cand.from !== 'ideal' && employees && employees > s.sizeMax) score = Math.min(score, 6);
  const c = (j.contact || {}) as Record<string, unknown>;
  const email = (str(c.email, 120).match(EMAIL)?.[0] || '').toLowerCase();
  const page = email ? onAPage(a, email) : '';
  const name = str(j.name, 120) || cand.name;
  const company = blankCompany({
    name, domain: cand.domain, website: cand.website, from: cand.from, what: str(j.what, 300), sector: str(j.sector, 80), city: brief(str(j.city).split(/[(;]/)[0], 40).trim(), province: str(j.province, 60), size, employees,
    facts, fit: list(j.fit, 3, 200), concerns: brief(j.concerns, 240), service: brief(str(j.service).split(/[(;:]/)[0], 60).trim(), magnetId: open.some((x) => x.id === j.magnet) ? String(j.magnet) : open[0]?.id || '',
    like: list(j.like, 2, 120).filter((x) => like.some((y) => nameKey(y) === nameKey(x))),
    contact: { name: str(c.name, 80), role: str(c.role, 80), email: page ? email : '', phone: str(c.phone, 40), source: page }, score, scoreWhy: str(j.scoreWhy, 240),
  });
  return { company, why: '' };
}

export const isRejectReason = (v: unknown): v is string => typeof v === 'string' && (REJECT_REASONS as readonly string[]).includes(v);
