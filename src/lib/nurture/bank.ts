import type { Audience, NurtureResource, NurtureStage, ResourceKind } from './types';
import { AUDIENCES, NURTURE_STAGES } from './types';
import { bankDoc, bumpStat, nid } from './store';
import { programmeList, leadProgramme } from './programmes';
import { completeWithPdf, extractJSON, generateJSON, isStr, obj } from '@/lib/ai/llm';
import { getAcademyContext } from '@/lib/auth/accounts';
import { deleteFile, putFile } from '@/lib/files/store';
import { log } from '@/lib/engine/store';

/* The content bank: everything the nurturing can share or learn from.
 *
 *   PDF guides (for parents, a prospectus)  uploaded, shared as a tracked link
 *   YouTube videos                          imported from the channel feed
 *   Links (an article, a page on our site)  shared as a tracked link
 *   Notes and WhatsApp FAQs                 what the agents may say (not sent)
 *
 * Each item is read by the model once, when it is added, and gets a short
 * summary, a hook line, who it is for and when in the journey it helps. From
 * then on choosing what to send a lead is plain rules: no AI per lead. */

export const SHAREABLE: ResourceKind[] = ['pdf', 'video', 'link'];
const MAX_TEXT = 6000;

export function listResources(): NurtureResource[] {
  return bankDoc.get();
}

export function getResource(id: string | undefined): NurtureResource | null {
  if (!id) return null;
  return bankDoc.get().find((r) => r.id === id) || null;
}

function save(r: NurtureResource) {
  const list = bankDoc.get();
  const i = list.findIndex((x) => x.id === r.id);
  if (i >= 0) list[i] = r; else list.unshift(r);
  bankDoc.save();
}

/* ── Reading something once ───────────────────────────────────────────────── */

interface Digest { title?: string; summary: string; hook: string; audience: Audience[]; programmes: string[]; stage: NurtureStage | 'any'; text?: string }

const DIGEST_SHAPE = (programmes: string[]) => `JSON: {"title": "a clear title (keep the original unless it is unclear)", "summary": "1 to 2 sentences: what it is and who it helps", "hook": "one warm line an email can use to introduce it, max 18 words, no hype", "audience": [any of ${AUDIENCES.map((a) => `"${a}"`).join(', ')}], "programmes": [${programmes.length ? `any of ${programmes.map((p) => JSON.stringify(p)).join(', ')}, or [] if it fits all` : '[]'}], "stage": one of "welcome" (a first hello), "learn" (useful knowledge), "trust" (proof, stories, how it works), "offer", "decide" (applying, fees, deadlines), "reengage", or "any", "gist": "the facts in it an admissions agent may repeat (fees, dates, requirements, what is taught), max 120 words, only what it really says"}`;

function validDigest(x: unknown, programmes: string[]): Digest | null {
  const o = obj(x);
  if (!o || !isStr(o.summary) || !isStr(o.hook)) return null;
  const audience = Array.isArray(o.audience) ? o.audience.filter((a): a is Audience => AUDIENCES.includes(a as Audience)) : [];
  const progs = Array.isArray(o.programmes) ? o.programmes.filter((p): p is string => typeof p === 'string' && programmes.includes(p)) : [];
  const stage = NURTURE_STAGES.includes(o.stage as NurtureStage) ? (o.stage as NurtureStage) : 'any';
  return {
    title: isStr(o.title) ? o.title.trim().slice(0, 120) : undefined,
    summary: o.summary.trim().slice(0, 400),
    hook: o.hook.trim().slice(0, 160),
    audience: audience.length ? [...new Set(audience)] : ['everyone'],
    programmes: [...new Set(progs)],
    stage,
    text: isStr(o.gist) ? o.gist.trim().slice(0, 1200) : undefined,
  };
}

function basicDigest(title: string, kind: ResourceKind): Digest {
  const what = kind === 'pdf' ? 'guide' : kind === 'video' ? 'video' : kind === 'link' ? 'read' : 'note';
  return { summary: `${title}.`, hook: `I thought you'd find this ${what} useful: ${title}.`, audience: ['everyone'], programmes: [], stage: 'any' };
}

async function digestText(title: string, kind: ResourceKind, text: string, url?: string): Promise<{ d: Digest; ai: boolean }> {
  const ac = getAcademyContext();
  const programmes = programmeList();
  const d = await generateJSON<Digest>({
    system: `You catalogue resources for ${ac.academyName}, a tech academy, so its admissions team can share the right thing with the right prospective student. Be factual: describe only what the resource really contains. Reply with one JSON object only.`,
    prompt: `Resource (${kind}): ${title}${url ? `\nLink: ${url}` : ''}\nContent:\n${text.slice(0, MAX_TEXT) || '(only the title is known)'}\n\n${DIGEST_SHAPE(programmes)}`,
    maxTokens: 6000,
    timeoutMs: 30000,
    validate: (x) => validDigest(x, programmes),
  });
  if (d) bumpStat('aiBuilds');
  return d ? { d, ai: true } : { d: basicDigest(title, kind), ai: false };
}

async function digestPdf(title: string, pdf: Buffer): Promise<{ d: Digest; ai: boolean }> {
  const ac = getAcademyContext();
  const programmes = programmeList();
  const text = await completeWithPdf({
    system: `You catalogue resources for ${ac.academyName}, a tech academy, so its admissions team can share the right thing with the right prospective student. Be factual. Reply with one JSON object only.`,
    prompt: `This PDF is called "${title}". Read it and describe it.\n\n${DIGEST_SHAPE(programmes)}`,
    maxTokens: 6000,
    timeoutMs: 90000,
    pdf,
  });
  if (text) {
    try {
      const d = validDigest(extractJSON(text), programmes);
      if (d) { bumpStat('aiBuilds'); return { d, ai: true }; }
    } catch { /* fall through */ }
  }
  return { d: basicDigest(title, 'pdf'), ai: false };
}

/* ── Adding ───────────────────────────────────────────────────────────────── */

function make(kind: ResourceKind, title: string, d: Digest, ai: boolean, extra: Partial<NurtureResource>): NurtureResource {
  const now = Date.now();
  return {
    id: nid('res'), kind, title: (d.title && kind !== 'pdf' ? d.title : title).slice(0, 120),
    summary: d.summary, hook: d.hook, audience: d.audience, programmes: d.programmes, stage: d.stage,
    text: d.text, origin: 'manual', enabled: true, digest: ai ? 'ai' : 'basic',
    createdAt: now, updatedAt: now, stats: { sent: 0, clicks: 0 },
    ...extra,
  };
}

/** Upload a PDF (a guide for parents, a prospectus). */
export async function addPdf(file: { name: string; mime: string; data: Buffer }, title?: string): Promise<NurtureResource> {
  if (!/pdf/i.test(file.mime) && !/\.pdf$/i.test(file.name)) throw new Error('Only PDF files can be shared as guides.');
  if (file.data.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('That file is not a readable PDF.');
  const stored = await putFile({ name: file.name, mime: 'application/pdf', data: file.data });
  const t = (title || file.name.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ')).trim().slice(0, 120) || 'Guide';
  const { d, ai } = await digestPdf(t, file.data);
  const r = make('pdf', t, d, ai, { fileId: stored.id, fileName: stored.name, size: stored.size, origin: 'upload' });
  save(r);
  log('system', 'info', `Content bank: added the PDF "${r.title}"${ai ? ', read and summarised' : ''}.`);
  return r;
}

/** A link: an article, a page on our site, a single YouTube video. */
export async function addLink(url: string, title?: string): Promise<NurtureResource> {
  const clean = url.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(clean)) throw new Error('Paste a full link starting with https://');
  const yt = youtubeId(clean);
  if (yt) {
    const meta = await youtubeOembed(clean);
    const t = title?.trim() || meta?.title || 'Video';
    const { d, ai } = await digestText(t, 'video', meta?.author ? `A YouTube video by ${meta.author}.` : '', clean);
    const r = make('video', t, d, ai, { url: `https://www.youtube.com/watch?v=${yt}`, thumb: `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`, origin: 'youtube' });
    save(r);
    return r;
  }
  const page = await fetchPage(clean);
  const t = title?.trim() || page.title || new URL(clean).hostname;
  const { d, ai } = await digestText(t, 'link', page.text, clean);
  const r = make('link', t, d, ai, { url: clean, origin: 'website' });
  save(r);
  log('system', 'info', `Content bank: added the link "${r.title}".`);
  return r;
}

/** A note the agents may use (fees, intakes, how classes work). Not sent as a link. */
export async function addNote(title: string, text: string): Promise<NurtureResource> {
  const body = text.trim().slice(0, MAX_TEXT);
  if (!body) throw new Error('Write the note first.');
  const t = title.trim().slice(0, 120) || 'Note';
  const { d, ai } = await digestText(t, 'note', body);
  const r = make('note', t, { ...d, text: body }, ai, { origin: 'manual' });
  save(r);
  return r;
}

export function updateResource(id: string, patch: Partial<Pick<NurtureResource, 'title' | 'summary' | 'hook' | 'audience' | 'programmes' | 'stage' | 'enabled' | 'text'>>): NurtureResource | null {
  const r = getResource(id);
  if (!r) return null;
  const next: NurtureResource = { ...r, updatedAt: Date.now() };
  if (typeof patch.title === 'string' && patch.title.trim()) next.title = patch.title.trim().slice(0, 120);
  if (typeof patch.summary === 'string') next.summary = patch.summary.trim().slice(0, 400);
  if (typeof patch.hook === 'string') next.hook = patch.hook.trim().slice(0, 160);
  if (typeof patch.text === 'string') next.text = patch.text.trim().slice(0, MAX_TEXT);
  if (Array.isArray(patch.audience)) { const a = patch.audience.filter((x) => AUDIENCES.includes(x)); next.audience = a.length ? a : ['everyone']; }
  if (Array.isArray(patch.programmes)) next.programmes = patch.programmes.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean).slice(0, 12);
  if (patch.stage && (patch.stage === 'any' || NURTURE_STAGES.includes(patch.stage))) next.stage = patch.stage;
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  save(next);
  return next;
}

export async function deleteResource(id: string): Promise<boolean> {
  const r = getResource(id);
  if (!r) return false;
  bankDoc.set(bankDoc.get().filter((x) => x.id !== id));
  if (r.fileId) await deleteFile(r.fileId);
  return true;
}

/* ── YouTube ──────────────────────────────────────────────────────────────── */

export function youtubeId(url: string): string | null {
  const m = url.match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

async function youtubeOembed(url: string): Promise<{ title: string; author: string } | null> {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { title?: string; author_name?: string };
    return j.title ? { title: j.title, author: j.author_name || '' } : null;
  } catch {
    return null;
  }
}

/** The feed address for a channel, @handle, or playlist link. */
async function youtubeFeed(input: string): Promise<string> {
  const s = input.trim();
  const list = s.match(/[?&]list=([A-Za-z0-9_-]{10,})/);
  if (list) return `https://www.youtube.com/feeds/videos.xml?playlist_id=${list[1]}`;
  const direct = s.match(/(UC[A-Za-z0-9_-]{22})/);
  if (direct) return `https://www.youtube.com/feeds/videos.xml?channel_id=${direct[1]}`;
  const url = /^https?:\/\//i.test(s) ? s : s.startsWith('@') ? `https://www.youtube.com/${s}` : `https://www.youtube.com/@${s.replace(/^@/, '')}`;
  if (!/youtube\.com/i.test(url)) throw new Error('Paste your YouTube channel link (youtube.com/@yourchannel) or a playlist link.');
  const res = await fetch(url, { headers: { 'Accept-Language': 'en', 'User-Agent': 'Mozilla/5.0 (compatible; ThusoBot/1.0)' }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`YouTube answered ${res.status} for that channel.`);
  const html = await res.text();
  const id = html.match(/"(?:channelId|externalId|browseId)":"(UC[A-Za-z0-9_-]{22})"/)?.[1] || html.match(/channel\/(UC[A-Za-z0-9_-]{22})/)?.[1];
  if (!id) throw new Error('Could not find that channel. Paste the full channel link.');
  return `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;
}

const xmlText = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();

export function parseYoutubeFeed(xml: string): { id: string; title: string; description: string; published: string }[] {
  const out: { id: string; title: string; description: string; published: string }[] = [];
  for (const entry of xml.split('<entry>').slice(1)) {
    const id = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    if (!id || !title) continue;
    out.push({
      id,
      title: xmlText(title),
      description: xmlText(entry.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] || '').slice(0, 600),
      published: entry.match(/<published>([^<]+)<\/published>/)?.[1] || '',
    });
  }
  return out;
}

/** Import the latest videos from a channel or playlist: one AI call reads them all. */
export async function importYouTube(input: string): Promise<{ added: NurtureResource[]; skipped: number }> {
  const feed = await youtubeFeed(input);
  const res = await fetch(feed, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`YouTube's feed answered ${res.status}.`);
  const videos = parseYoutubeFeed(await res.text());
  if (!videos.length) throw new Error('That channel has no public videos yet.');
  const have = new Set(bankDoc.get().map((r) => (r.url ? youtubeId(r.url) : null)).filter(Boolean));
  const fresh = videos.filter((v) => !have.has(v.id)).slice(0, 15);
  if (!fresh.length) return { added: [], skipped: videos.length };

  const ac = getAcademyContext();
  const programmes = programmeList();
  const batch = await generateJSON<Record<number, Digest & { useful: boolean }>>({
    system: `You catalogue ${ac.academyName}'s YouTube videos so its admissions team can share the right one with the right prospective student. Be factual. Reply with one JSON object only.`,
    prompt: `Videos:\n${fresh.map((v, i) => `${i}. ${v.title}\n   ${v.description.replace(/\s+/g, ' ').slice(0, 300) || '(no description)'}`).join('\n')}\n\nFor each video number give {"useful": true if it would help someone deciding whether to study with us (false for internal or off-topic clips), and the fields below}.\n${DIGEST_SHAPE(programmes)}\n\nReply as {"0": {...}, "1": {...}, ...}.`,
    maxTokens: 12000,
    timeoutMs: 45000,
    validate: (x) => {
      const o = obj(x); if (!o) return null;
      const out: Record<number, Digest & { useful: boolean }> = {};
      for (const [k, v] of Object.entries(o)) {
        const d = validDigest(v, programmes);
        if (d) out[Number(k)] = { ...d, useful: (v as { useful?: unknown }).useful !== false };
      }
      return Object.keys(out).length ? out : null;
    },
  });
  if (batch) bumpStat('aiBuilds');
  const added: NurtureResource[] = [];
  fresh.forEach((v, i) => {
    const d = batch?.[i];
    if (d && !d.useful) return;
    const r = make('video', v.title, d || basicDigest(v.title, 'video'), Boolean(d), {
      url: `https://www.youtube.com/watch?v=${v.id}`, thumb: `https://i.ytimg.com/vi/${v.id}/hqdefault.jpg`, origin: 'youtube',
    });
    r.title = v.title.slice(0, 120);
    save(r);
    added.push(r);
  });
  log('system', 'info', `Content bank: imported ${added.length} video${added.length === 1 ? '' : 's'} from YouTube.`);
  return { added, skipped: videos.length - added.length };
}

/* ── WhatsApp ─────────────────────────────────────────────────────────────── */

/** A chat export with names, numbers and emails taken out: who said what becomes Person A, B, C. */
export function scrubChat(raw: string): { text: string; people: number; lines: number } {
  const names = new Map<string, string>();
  const label = (n: string) => {
    const k = n.trim().toLowerCase();
    if (!names.has(k)) names.set(k, `Person ${String.fromCharCode(65 + Math.min(names.size, 25))}`);
    return names.get(k)!;
  };
  const out: string[] = [];
  for (const line of raw.replace(/\r\n/g, '\n').split('\n')) {
    let t = line.trim();
    if (!t) continue;
    // "12/03/2025, 14:22 - Name: text"  or  "[12/03/2025, 14:22:01] Name: text"
    const m = t.match(/^\[?\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?\]?\s*(?:-\s*)?([^:]{1,60}):\s?(.*)$/);
    if (m) t = `${label(m[1])}: ${m[2]}`;
    else if (/^\[?\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4},?\s+\d{1,2}:\d{2}/.test(t)) continue; // system lines (joined, changed number)
    if (/<media omitted>|this message was deleted|messages and calls are end-to-end encrypted|image omitted|video omitted|sticker omitted/i.test(t)) continue;
    t = t
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
      .replace(/(?:\+?\d[\d\s()-]{7,}\d)/g, '[number]');
    out.push(t);
  }
  return { text: out.join('\n'), people: names.size, lines: out.length };
}

/** Learn from WhatsApp: the questions leads ask and the answers that worked. Only the distilled FAQs are kept. */
export async function importWhatsApp(raw: string, title = 'What leads ask on WhatsApp'): Promise<{ resource: NurtureResource; faqs: number }> {
  const { text, lines } = scrubChat(raw);
  if (lines < 3) throw new Error('That does not look like a WhatsApp chat export (Chat → More → Export chat → Without media).');
  const ac = getAcademyContext();
  const recent = text.slice(-40_000);
  const res = await generateJSON<{ faqs: { q: string; a: string }[]; objections: string[]; summary: string }>({
    system: `You help ${ac.academyName}'s admissions team learn from their WhatsApp conversations with prospective students. Names and numbers were removed; one of the people is the academy team (usually the one answering). Reply with one JSON object only.`,
    prompt: `Conversation lines (oldest first):\n${recent}\n\nJSON: {"faqs": [{"q": "a question prospective students really ask, in plain words", "a": "the answer the academy gave, as facts only (empty if never answered)"}] (the 6 to 15 most common), "objections": ["what holds people back (fees, time, doubts), max 8"], "summary": "2 sentences on what people mostly want to know"}`,
    maxTokens: 9000,
    timeoutMs: 60000,
    validate: (x) => {
      const o = obj(x); if (!o || !Array.isArray(o.faqs)) return null;
      const faqs = (o.faqs as unknown[]).map((f) => obj(f)).filter((f): f is Record<string, unknown> => Boolean(f && isStr(f.q))).map((f) => ({ q: String(f.q).trim().slice(0, 200), a: isStr(f.a) ? String(f.a).trim().slice(0, 400) : '' })).slice(0, 15);
      if (!faqs.length) return null;
      return { faqs, objections: Array.isArray(o.objections) ? o.objections.filter(isStr).map((s) => s.trim().slice(0, 160)).slice(0, 8) : [], summary: isStr(o.summary) ? o.summary.trim().slice(0, 400) : '' };
    },
  });
  if (!res) throw new Error('The chat could not be read right now. Try again in a minute.');
  bumpStat('aiBuilds');
  const body = [
    ...res.faqs.map((f) => `Q: ${f.q}\nA: ${f.a || '(not answered in the chat: a consultant confirms)'}`),
    res.objections.length ? `What holds people back: ${res.objections.join('; ')}.` : '',
  ].filter(Boolean).join('\n\n');
  const now = Date.now();
  const r: NurtureResource = {
    id: nid('res'), kind: 'faq', title: title.slice(0, 120), summary: res.summary || `${res.faqs.length} questions leads ask on WhatsApp.`,
    hook: '', audience: ['everyone'], programmes: [], stage: 'any', text: body.slice(0, MAX_TEXT), origin: 'whatsapp',
    enabled: true, digest: 'ai', createdAt: now, updatedAt: now, stats: { sent: 0, clicks: 0 },
  };
  save(r);
  log('system', 'info', `Content bank: learned ${res.faqs.length} common questions from a WhatsApp chat (names and numbers removed).`);
  return { resource: r, faqs: res.faqs.length };
}

/* ── Websites ─────────────────────────────────────────────────────────────── */

async function fetchPage(url: string): Promise<{ title: string; text: string }> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ThusoBot/1.0)' }, signal: AbortSignal.timeout(9000), redirect: 'follow' });
    if (!res.ok || !/html|text/i.test(res.headers.get('content-type') || '')) return { title: '', text: '' };
    const html = (await res.text()).slice(0, 400_000);
    const title = xmlText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').slice(0, 120);
    const desc = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)/i)?.[1] || '';
    const text = html
      .replace(/<(script|style|noscript|svg|nav|footer|header)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { title, text: `${desc}\n${text}`.slice(0, MAX_TEXT) };
  } catch {
    return { title: '', text: '' };
  }
}

/* ── Using the bank ───────────────────────────────────────────────────────── */

/** Who a lead is, as best the fields say (a parent asking for a child, a working adult...). */
export function leadAudience(fields: Record<string, string>): Audience {
  const said = `${fields.audience || ''} ${fields.who || ''} ${fields.message || ''} ${fields.notes || ''} ${fields.are_you || ''}`.toLowerCase();
  if (/parent|my (son|daughter|child|kid)|guardian/.test(said)) return 'parents';
  if (/matric|grade 12|school leaver|just finished school|gap year/.test(said)) return 'school_leavers';
  if (/career change|switch|new career|retrain/.test(said)) return 'career_changers';
  if (/working|employed|full[- ]time job|after work/.test(said)) return 'working';
  return 'everyone';
}

/** The best resources for one lead, by rules: their programme, who they are, the stage, what they have not had. */
export function pickResources(fields: Record<string, string>, stage: NurtureStage | 'any' = 'any', max = 2, exclude: string[] = []): NurtureResource[] {
  const programme = leadProgramme(fields).toLowerCase();
  const audience = leadAudience(fields);
  const had = new Set([...(fields.nurture_res || '').split('|').filter(Boolean), ...exclude]);
  return bankDoc.get()
    .filter((r) => r.enabled && SHAREABLE.includes(r.kind) && (r.url || r.fileId))
    .map((r) => {
      let score = 0;
      if (r.programmes.length) score += r.programmes.some((p) => p.toLowerCase() === programme) ? 4 : -8;
      if (r.audience.includes(audience) && audience !== 'everyone') score += 3;
      else if (!r.audience.includes('everyone') && !r.audience.includes(audience)) score -= 2;
      if (stage !== 'any' && r.stage === stage) score += 2;
      if (r.stage === 'any') score += 1;
      score += had.has(r.id) ? -6 : 2;
      if (r.stats.sent >= 5) score += Math.min(2, (r.stats.clicks / r.stats.sent) * 6);
      return { r, score };
    })
    .filter((x) => x.score > -3)
    .sort((a, b) => b.score - a.score)
    .slice(0, max)
    .map((x) => x.r);
}

/** What the agents know from the bank: notes, FAQs, the facts in guides, and what can be shared. */
export function bankKnowledge(maxChars = 3500): string {
  const list = bankDoc.get().filter((r) => r.enabled);
  if (!list.length) return '';
  const facts = list.filter((r) => r.text && (r.kind === 'note' || r.kind === 'faq' || r.kind === 'pdf')).map((r) => `${r.title}:\n${r.text}`);
  const share = list.filter((r) => SHAREABLE.includes(r.kind)).slice(0, 12).map((r) => `- ${r.title} (${r.kind}): ${r.summary}`);
  const out = [
    facts.length ? `From the academy's notes, guides and WhatsApp FAQs:\n${facts.join('\n\n')}` : '',
    share.length ? `Guides and videos the team can share (a colleague attaches the link; mention them by name only):\n${share.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
  return out.length > maxChars ? `${out.slice(0, maxChars - 1)}…` : out;
}
