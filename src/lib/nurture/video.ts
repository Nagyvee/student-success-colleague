import type { DataRecord, Lesson, LessonSlide, SlideVisual } from '@/lib/types';
import type { ProgrammeVideo } from './types';
import { meta, metaDoc, bumpStat, nid } from './store';
import { matchProgramme, leadProgramme, programmeList } from './programmes';
import { leadProfile } from './profile';
import { bankKnowledge } from './bank';
import { LEAD_VISUALS, SCENE_ICONS, clampWords, cleanScene, sceneComplete, visualOf } from '@/lib/lessonScene';
import { generateJSON, isStr, noEmoji, obj } from '@/lib/ai/llm';
import { getAcademyContext, getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { listCustomAgents } from '@/lib/engine/offices';
import { log } from '@/lib/engine/store';
import { warmLessonAudio } from '@/lib/media/tts';

/* Programme videos for leads: made once, personal every time.
 *
 * One animated explainer per programme ("what Data Science with us is
 * really like"), written once by the model with the same visual scenes as
 * the tutoring lessons. When a lead opens their link, a greeting scene is
 * added for them alone ("Hey Thandi, I noticed you're looking at Data
 * Science and you read the parents' guide, so I made this for you"). The
 * personal part is plain text from their record: no AI per lead, and the
 * voice for the shared scenes is generated once and reused. */

const MAX_VIDEOS = 20;

export function listVideos(): ProgrammeVideo[] {
  return meta().videos;
}

export function getVideo(id: string): ProgrammeVideo | null {
  return meta().videos.find((v) => v.id === id) || null;
}

/** The video for a lead's programme, else the closest one, else the general one. */
export function videoFor(programme: string): ProgrammeVideo | null {
  const vids = meta().videos;
  if (!vids.length) return null;
  const exact = vids.find((v) => v.programme.toLowerCase() === programme.toLowerCase());
  if (exact) return exact;
  const near = matchProgramme(programme, vids.map((v) => v.programme));
  return (near && vids.find((v) => v.programme === near)) || vids.find((v) => v.programme === 'general') || vids[0];
}

function presenter(): string {
  return listCustomAgents().find((a) => a.id === 'ag_naledi')?.name || 'Naledi';
}

/* ── Writing a programme video (once) ─────────────────────────────────────── */

function fallbackSlides(programme: string, academy: string): LessonSlide[] {
  const p = programme === 'general' ? 'tech' : programme;
  return [
    { visual: 'big', heading: p, points: [], scene: { value: clampWords(p, 3), caption: 'A career you can build, step by step' }, say: `Let's talk about ${p}. It's one of the most useful skills you can learn right now, and you don't need to be a genius to start. You need curiosity, a bit of time each week, and people who'll help you when you get stuck.` },
    { visual: 'flow', heading: 'How you learn', points: [], scene: { nodes: [{ label: 'Live classes', icon: 'users' }, { label: 'Real projects', icon: 'code' }, { label: 'Your portfolio', icon: 'folder' }, { label: 'Your career', icon: 'rocket' }] }, say: `Here's the path. You learn in live classes where you can ask questions. You practise on real projects, not just theory. Those projects become your portfolio, and your portfolio is what opens doors.` },
    { visual: 'compare', heading: 'Where you could be', points: [], scene: { left: { label: 'Curious about tech', icon: 'search' }, right: { label: 'Building real things', icon: 'trophy' } }, say: `On the left is where a lot of people start: curious, not sure where to begin. On the right is where our students get to: building real things, and able to show what they can do.` },
    { visual: 'analogy', heading: 'Like learning to drive', points: [], scene: { left: { label: 'Driving lessons', icon: 'map' }, right: { label: p.split(' ').slice(0, 3).join(' '), icon: 'compass' }, caption: 'Guided practice until it feels natural' }, say: `Think of it like learning to drive. Nobody's perfect on day one. You practise with someone next to you, step by step, until it feels natural. That's exactly how we teach.` },
    { visual: 'recap', heading: 'Why people choose us', points: [], scene: { nodes: [{ label: 'Live, practical classes', icon: 'users' }, { label: 'Real projects', icon: 'code' }, { label: 'Support all the way', icon: 'heart' }] }, say: `So, three things to remember. Classes are live and practical. You build real projects. And you're supported all the way, by people who want you to finish.` },
    { visual: 'cta', heading: 'Your next step', points: [], say: `If this sounds like you, the next step is easy. Tap the button below, and if you've got any questions at all, just reply to my email. I'd love to help you get started at ${academy}.` },
  ];
}

/** The model's scenes, checked: known visuals, complete scenes, short labels. A scene it left half-drawn becomes one big line. */
function parseScenes(x: unknown, opts: { min: number; max: number; closing: boolean }): LessonSlide[] | null {
  const o = obj(x); if (!o || !Array.isArray(o.slides) || o.slides.length < opts.min || o.slides.length > opts.max) return null;
  const slides = (o.slides as unknown[]).map((v, i, all) => {
    const q = obj(v); if (!q || !isStr(q.heading) || !isStr(q.say)) return null;
    const wanted = visualOf(q, LEAD_VISUALS);
    if (!wanted) console.warn(`[thuso] lead video: a scene with no known visual: ${JSON.stringify(v).slice(0, 300)}`);
    let visual: SlideVisual = wanted && wanted !== 'greeting' && wanted !== 'code' && (opts.closing || wanted !== 'cta') ? wanted : 'big';
    if (opts.closing && i === all.length - 1) visual = 'cta';
    if (opts.closing && i === all.length - 2 && (visual === 'flow' || /recap|remember|why/i.test(String(q.heading)))) visual = 'recap';
    let scene = cleanScene(visual, q.scene);
    if (!sceneComplete(visual, scene)) {
      if (visual !== 'cta' && visual !== 'big') console.warn(`[thuso] lead video: a "${visual}" scene came back incomplete: ${JSON.stringify({ visual: q.visual, scene: q.scene }).slice(0, 400)}`);
      visual = visual === 'cta' ? 'cta' : 'big';
      scene = visual === 'big' ? { value: clampWords(q.heading, 5), caption: scene?.caption } : scene;
    }
    return { heading: clampWords(noEmoji(String(q.heading)), 6), points: [], say: noEmoji(String(q.say)), visual, scene } as LessonSlide;
  });
  return slides.every(Boolean) ? (slides as LessonSlide[]) : null;
}

/** The model's "valid_until" (an offer's last day), as the end of that day in South Africa. */
function endOfDay(x: unknown): number | null {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x.trim())) return null;
  const t = Date.parse(`${x.trim()}T23:59:59+02:00`);
  return Number.isFinite(t) && t > Date.now() ? t : null;
}

export async function buildProgrammeVideo(programme: string): Promise<ProgrammeVideo> {
  const ac = getAcademyContext();
  const ti = getTenantIntegrations(currentTenantId());
  const p = programme.trim().slice(0, 80) || 'general';
  const name = presenter();
  const topic = p === 'general' ? `studying tech at ${ac.academyName} (all programmes)` : `the ${p} programme at ${ac.academyName}`;
  const known = [ti.academyFocus ? `Programmes: ${ti.academyFocus}` : '', ti.agentKnowledge || '', bankKnowledge(2500)].filter(Boolean).join('\n');
  const today = new Date().toISOString().slice(0, 10);
  let validUntil: number | null = null;
  let loanPrice: LessonSlide | null = null;
  const ai = await generateJSON<LessonSlide[]>({
    system: `You are ${name}, an admissions consultant at ${ac.academyName} in South Africa. You script short, documentary-style videos that make someone want to study with us: real photos of our classrooms and people, the facts that matter on screen, and a warm, confident voice. Natural South African English. Never pushy. Facts: only what is written below, quoted exactly (names, NQF levels, durations, rand amounts, dates); never invent fees, salaries, statistics, dates or promises. Never mention class days or class times, SAQA IDs, accreditation numbers or credits; never say people can come to campus any time (campus days at our Rosebank campus are optional) and never mention any other campus or hub; never send people to an application form. The shared scenes are for everyone, so never assume anything about the viewer (their job, age, background, where they live or how they will pay). Reply with one JSON object only.`,
    prompt: `Today is ${today}. Script the shared part of a 3-minute video about ${topic}. A personal greeting by name is added before it for each viewer, so do not greet.
${known ? `What you know:\n${known}\n` : ''}
THE GOLDEN RULE: the screen SHOWS what the voice TELLS. When the voice says a number, a qualification, a price or a job, that exact thing is on screen in that scene. On-screen words are short labels; the voice does the explaining.

Ten scenes, in this order:
1. "photo" (a real photo of our people fills the screen): the hook. Why this field, why now, why people like them can do it. scene.kicker = "${ac.academyName}", heading = a bold line (max 6 words), scene.caption = one line (max 12 words).
2. "facts": the programme at a glance. scene.nodes = 3 or 4 tiles, each {"label": the number or short fact (max 3 words, e.g. "NQF Level 5", "12-18 months", "100% online"), "note": what it means (max 5 words)}. No SAQA IDs or credits.
3. "flow": what you learn, in order. scene.nodes = 4 or 5 stages, each {"label": a real module or tool from what you know (max 3 words), "icon"}.
4. "photo": how classes work (live online classes, mentors, a class you belong to; optional campus days at our Rosebank campus). No days or times, no other campuses. kicker, heading (max 6 words), caption (max 12 words).
5. "timeline": the months ahead. scene.nodes = 3 or 4 steps, each {"label": the period (e.g. "Months 1-4"), "note": what happens (max 6 words)}.
6. "careers": the jobs this path leads to. scene.nodes = 4 to 6 job titles from what you know, each {"label": max 4 words, "icon"}.
7. "price": what it costs and the current offers. scene.rows = 1 to 3 cards, each {"label": max 4 words (e.g. "Accredited, paid in full"), "was": the standard fee as written (e.g. "R 74 999") or omit, "now": the price they would pay (e.g. "R 37 499" or "R 3 997/month"), "note": the condition and its end date (max 7 words)}. scene.caption = one line about other ways to pay (monthly plans, student loans), max 14 words. Quote amounts exactly as written above.
8. "photo": the people and the support (mentors, career coach, internship with a hiring partner). kicker, heading, caption.
9. "recap": scene.nodes = 3 or 4 reasons to choose this path with us, each {"label": max 6 words, "icon"}.
10. "cta": the next step: tap "Yes, I want to enrol" below and a Student Advisor calls them to set everything up (or reply to the email with a question). Short and warm; never mention an application form.
Icons: exactly from this list: ${SCENE_ICONS.join(', ')}.
Every scene: "visual" (exactly one of: photo, facts, flow, timeline, careers, price, recap, cta), "heading" (max 6 words), "scene" (the fields named above), "points": [], "say": narration of 35 to 65 words for the ear (short sentences, contractions, talk about what is on screen; write rand amounts as "R 37 499"; no markdown, no emoji).
If any scene mentions an offer that ends on a date, set "valid_until" to the earliest such date (YYYY-MM-DD), else null.

Also write "loan_price": one extra "price" scene that replaces scene 7 for viewers who need a student loan (discounts and offers do not apply to them, so never mention them here). scene.rows = 1 or 2 cards {"label": max 4 words, "now": the fee a loan-funded learner pays as written, "note": max 7 words}; scene.caption = the lending partners or the repayment period, max 14 words; "say": how a student loan works for them (the lender pays the academy, they repay over the period written above, what they need to apply, a Student Advisor helps), 35 to 65 words. Only if what you know covers student loans; else null.

JSON: {"valid_until": "YYYY-MM-DD" or null, "slides": [{"visual": "...", "heading": "...", "scene": {...}, "points": [], "say": "..."}], "loan_price": {"visual": "price", ...} or null}`,
    maxTokens: 24000,
    timeoutMs: 120000,
    model: process.env.VIDEO_SCRIPT_MODEL || 'claude-sonnet-5-5',
    effort: 'medium',
    validate: (x) => {
      const slides = parseScenes(x, { min: 6, max: 12, closing: true });
      if (slides) {
        validUntil = endOfDay(obj(x)?.valid_until);
        const loan = obj(x)?.loan_price ? parseScenes({ slides: [obj(x)!.loan_price] }, { min: 1, max: 1, closing: false })?.[0] : null;
        loanPrice = loan && loan.visual === 'price' ? loan : null;
      }
      return slides;
    },
  });
  if (ai) bumpStat('aiBuilds');
  const m = meta();
  const prev = m.videos.find((v) => v.programme.toLowerCase() === p.toLowerCase());
  const video: ProgrammeVideo = {
    id: prev?.id || nid('pv'),
    programme: p,
    title: p === 'general' ? `Why tech, why ${ac.academyName}` : `${p} at ${ac.academyName}`,
    slides: ai || fallbackSlides(p, ac.academyName),
    tutorName: name,
    viaAi: Boolean(ai),
    createdAt: Date.now(),
    views: prev?.views || 0,
    validUntil: ai ? validUntil : null,
    loanPrice: ai ? loanPrice : null,
  };
  m.videos = [video, ...m.videos.filter((v) => v.id !== video.id)].slice(0, MAX_VIDEOS);
  metaDoc.save();
  // The voice for every shared scene is made now (and the loan version of the price), so no viewer waits for it.
  warmLessonAudio(currentTenantId(), video.id, video.slides);
  const priceAt = video.slides.findIndex((s) => s.visual === 'price');
  if (video.loanPrice && priceAt >= 0) warmLessonAudio(currentTenantId(), video.id, video.slides.map((s, i) => (i === priceAt ? video.loanPrice! : { say: '' })));
  log('system', 'dispatch', `Programme video ready: "${video.title}" (${video.slides.length} scenes${video.viaAi ? '' : ', from the template'})${video.validUntil ? `; it mentions an offer, so it is rewritten after ${new Date(video.validUntil).toISOString().slice(0, 10)}` : ''}. Every lead who opens it is greeted by name.`);
  return video;
}

/** Videos whose offer has ended are rewritten with what is current (checked by the always-on pump). */
export async function refreshExpiredVideos(): Promise<number> {
  const due = meta().videos.filter((v) => v.validUntil && v.validUntil < Date.now());
  for (const v of due) await buildProgrammeVideo(v.programme);
  return due.length;
}

/** Make the videos for every programme that has none yet (and the general one). */
export async function buildMissingVideos(): Promise<ProgrammeVideo[]> {
  const have = new Set(meta().videos.map((v) => v.programme.toLowerCase()));
  const wanted = [...programmeList(), 'general'].filter((p) => !have.has(p.toLowerCase()));
  const out: ProgrammeVideo[] = [];
  for (const p of wanted) out.push(await buildProgrammeVideo(p));
  return out;
}

/* ── A video for one person (hot leads) ───────────────────────────────────── */

/** Scenes made for one lead: their goal, what they asked or what holds them back, why it fits them.
 *  One AI call; played between their greeting and the programme's shared scenes. */
export async function buildPersonalScenes(rec: Pick<DataRecord, 'key' | 'name' | 'fields'>, conversation: string): Promise<LessonSlide[] | null> {
  const ac = getAcademyContext();
  const ti = getTenantIntegrations(currentTenantId());
  const first = (rec.fields.first_name || rec.name).split(/\s+/)[0];
  const programme = leadProgramme(rec.fields) || 'tech';
  const facts = Object.entries(rec.fields)
    .filter(([k, v]) => v && v.length < 400 && /^(interest|programme|source|campaign|message|notes|question|fit_track|fit_programme|last_clicked|last_reply|lead_brief|status|who|why)$/.test(k))
    .map(([k, v]) => `- ${k}: ${v}`).join('\n');
  const known = [ti.academyFocus ? `Programmes: ${ti.academyFocus}` : '', ti.agentKnowledge || '', bankKnowledge(1500)].filter(Boolean).join('\n');
  const slides = await generateJSON<LessonSlide[]>({
    system: `You are ${presenter()}, an admissions consultant at ${ac.academyName}, a tech academy in South Africa. ${first} is seriously considering ${programme}, and you are making them a short personal video. Warm, specific, confident, never pushy; natural South African English; no emoji. Facts: only what you know below; never invent fees, salaries, statistics, dates or promises. Reply with one JSON object only.`,
    prompt: `What we know about ${first}:\n${facts || '- only their interest'}\n${conversation ? `\n${conversation}\n` : ''}${known ? `\nWhat you know about the academy:\n${known}\n` : ''}
Script 2 or 3 scenes for ${first} alone (the greeting is added before them and the programme's own scenes after them, so do not greet and do not end the video):
1. Their goal: where they are now and where ${programme} can take them, as "compare" (scene.left = now, scene.right = their goal, each {"label": "max 6 words", "icon"}) or "flow" (scene.nodes = 3 to 4 steps on their path).
2. The question they asked or the doubt most likely holding them back, answered with facts: "big" (scene.value max 3 words, scene.caption max 10 words) or "analogy" (scene.left = an everyday South African thing, scene.right = the answer, scene.caption).
3. (optional) "recap": 3 reasons this fits ${first} specifically (scene.nodes, each {"label": "max 6 words", "icon"}).
Icons: exactly from this list: ${SCENE_ICONS.join(', ')}.
Each scene: "visual", "heading" (max 5 words), "scene", "points": [], "say": 35 to 60 words spoken to ${first} (use their name once in the whole video), for the ear, pointing at the screen, no markdown, no emoji.

JSON: {"slides": [...]}`,
    maxTokens: 10000,
    timeoutMs: 45000,
    validate: (x) => parseScenes(x, { min: 2, max: 3, closing: false }),
  });
  if (!slides) return null;
  bumpStat('aiBuilds');
  const m = meta();
  m.personal ||= {};
  m.personal[rec.key] = { slides, createdAt: Date.now(), programme: leadProgramme(rec.fields) || '' };
  // Keep the newest 300 personal videos.
  const keys = Object.entries(m.personal).sort((a, b) => b[1].createdAt - a[1].createdAt).map(([k]) => k);
  for (const k of keys.slice(300)) delete m.personal[k];
  metaDoc.save();
  return slides;
}

/** A lead's own scenes, only inside the video for the programme they were made about
 *  (scenes about Software Development never play inside the Data Science video). */
export function personalScenes(key: string, programme: string): LessonSlide[] {
  const p = meta().personal?.[key];
  if (!p?.slides?.length || !p.programme) return [];
  const resolve = (x: string) => (matchProgramme(x) || x).toLowerCase();
  const same = p.programme.toLowerCase() === programme.toLowerCase() || resolve(p.programme) === resolve(programme);
  return same ? p.slides : [];
}

/* ── Playing it for one lead ──────────────────────────────────────────────── */

/** The greeting for this lead, from their record only (no AI). */
export function greetingFor(rec: Pick<DataRecord, 'name' | 'fields'>, programme: string, tutor: string, academy: string): { slide: LessonSlide; noticed: string[] } {
  const first = (rec.fields.first_name || rec.name).split(/\s+/)[0] || 'there';
  const p = programme && programme !== 'general' ? programme : '';
  const fit = rec.fields.fit_track || '';
  const funding = leadProfile(rec.fields).funding || '';
  // Only what their own record says: their programme, their quiz result, how they said they would pay.
  const bits: string[] = [];
  if (p) bits.push(`you're interested in ${p}`);
  if (fit) bits.push(`your quiz said you're ${fit}`);
  const pay = funding === 'loan' ? ` You also told us you'd need a student loan, so I'll show you how that works.`
    : funding === 'family' ? ` You mentioned your family would help with the fees, so I'll show you the options.`
      : '';
  const noticed = bits.length ? `I noticed ${bits.join(', and ')}, so` : 'You asked about studying with us, so';
  const say = `Hey ${first}, how are you? I'm ${tutor} from ${academy}. ${noticed} I made this short video just for you.${pay} Let me show you what it's really like.`;
  const chips = [p, fit, funding === 'loan' ? 'Student loan' : ''].filter(Boolean).slice(0, 3);
  return { slide: { visual: 'greeting', heading: `Hey ${first}`, points: [], say }, noticed: chips };
}

/** The full lesson a lead sees: their greeting, then the shared scenes. */
export function lessonForLead(video: ProgrammeVideo, rec: Pick<DataRecord, 'key' | 'name' | 'fields'>): { lesson: Lesson; noticed: string[]; personal: number } {
  const ac = getAcademyContext();
  const programme = video.programme === 'general' ? leadProgramme(rec.fields) || 'general' : video.programme;
  const g = greetingFor(rec, programme, video.tutorName, ac.academyName);
  const mine = personalScenes(rec.key, programme);
  // A lead who needs a student loan sees the loan version of the price (the offers do not apply to them).
  const loan = leadProfile(rec.fields).funding === 'loan' && video.loanPrice;
  const shared = loan ? video.slides.map((s) => (s.visual === 'price' ? video.loanPrice! : s)) : video.slides;
  return {
    lesson: { title: mine.length ? `A video for ${(rec.fields.first_name || rec.name).split(/\s+/)[0]}` : video.title, slides: [g.slide, ...mine, ...shared], viaAi: video.viaAi, greeting: g.slide.say, tutorName: video.tutorName, academyName: ac.academyName },
    noticed: g.noticed,
    personal: mine.length,
  };
}

export function countView(id: string) {
  const v = meta().videos.find((x) => x.id === id);
  if (v) { v.views++; metaDoc.save(); }
}
