import type { DataRecord, Lesson, LessonSlide, SlideVisual } from '@/lib/types';
import type { ProgrammeVideo } from './types';
import { meta, metaDoc, bumpStat, nid } from './store';
import { matchProgramme, leadProgramme, programmeList } from './programmes';
import { bankKnowledge } from './bank';
import { SCENE_ICONS, clampWords, cleanScene, sceneComplete, visualOf } from '@/lib/lessonScene';
import { generateJSON, isStr, noEmoji, obj } from '@/lib/ai/llm';
import { getAcademyContext, getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { listCustomAgents } from '@/lib/engine/offices';
import { log } from '@/lib/engine/store';

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
    const wanted = visualOf(q);
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

export async function buildProgrammeVideo(programme: string): Promise<ProgrammeVideo> {
  const ac = getAcademyContext();
  const ti = getTenantIntegrations(currentTenantId());
  const p = programme.trim().slice(0, 80) || 'general';
  const name = presenter();
  const topic = p === 'general' ? `studying tech at ${ac.academyName}` : p;
  const known = [ti.academyFocus ? `Programmes: ${ti.academyFocus}` : '', ti.agentKnowledge || '', bankKnowledge(2000)].filter(Boolean).join('\n');
  const ai = await generateJSON<LessonSlide[]>({
    system: `You are ${name}, an admissions consultant at ${ac.academyName}, a tech academy in South Africa. You script short animated explainer videos (a great YouTube explainer, not a slide deck) for people deciding whether to study with us. Warm, hopeful, confident, never pushy; natural South African English. Facts: only what you know below; never invent fees, salaries, statistics, dates or promises. Reply with one JSON object only.`,
    prompt: `Script the shared part of a 2-minute video about ${topic}. A personal greeting scene is added before it for each viewer, so do not greet.
${known ? `What you know:\n${known}\n` : ''}
THE GOLDEN RULE: the screen SHOWS, the voice TELLS. Every scene is an animation; on-screen words are tiny labels, never sentences.

6 scenes in this order of purpose:
1. Why this field matters, as one big idea: "big" with scene.value (max 3 words) and scene.caption (max 10 words, a complete phrase).
2. What you learn, in order: "flow" with scene.nodes = 3 to 5 stages [{"label": "max 3 words", "icon"}].
3. Where you start vs where you could be: "compare" (scene.left, scene.right, each {"label": "max 6 words", "icon"}).
4. How it works with us (live classes, projects, support) as an "analogy": an everyday South African thing ≈ how we teach. scene.left = the everyday thing, scene.right = the concept (each {"label": "max 3 words", "icon"}), scene.caption = "max 10 words, a complete phrase".
5. "recap": scene.nodes = 3 to 4 reasons to choose this path, each {"label": "max 6 words", "icon"}.
6. "cta": the next step (take the button below, or reply with a question), short and encouraging.
Icons: exactly from this list: ${SCENE_ICONS.join(', ')}.
Every scene: "visual" (exactly one of: big, flow, branch, compare, analogy, recap, cta), "heading" (max 5 words), "scene" (the fields named above for that visual), "points": [], "say": narration of 35 to 60 words for the ear (short sentences, contractions, point at the screen, no markdown, no emoji).

JSON: {"slides": [{"visual": "...", "heading": "...", "scene": {...}, "points": [], "say": "..."}]}`,
    maxTokens: 14000,
    timeoutMs: 50000,
    validate: (x) => parseScenes(x, { min: 4, max: 8, closing: true }),
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
  };
  m.videos = [video, ...m.videos.filter((v) => v.id !== video.id)].slice(0, MAX_VIDEOS);
  metaDoc.save();
  log('system', 'dispatch', `Programme video ready: "${video.title}" (${video.slides.length} scenes${video.viaAi ? '' : ', from the template'}). Every lead who opens it is greeted by name.`);
  return video;
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
  m.personal[rec.key] = { slides, createdAt: Date.now() };
  // Keep the newest 300 personal videos.
  const keys = Object.entries(m.personal).sort((a, b) => b[1].createdAt - a[1].createdAt).map(([k]) => k);
  for (const k of keys.slice(300)) delete m.personal[k];
  metaDoc.save();
  return slides;
}

export function personalScenes(key: string): LessonSlide[] {
  return meta().personal?.[key]?.slides || [];
}

/* ── Playing it for one lead ──────────────────────────────────────────────── */

/** The greeting for this lead, from their record only (no AI). */
export function greetingFor(rec: Pick<DataRecord, 'name' | 'fields'>, programme: string, tutor: string, academy: string): { slide: LessonSlide; noticed: string[] } {
  const first = (rec.fields.first_name || rec.name).split(/\s+/)[0] || 'there';
  const p = programme && programme !== 'general' ? programme : '';
  const clicked = (rec.fields.last_clicked || '').replace(/["“”]/g, '').trim();
  const fit = rec.fields.fit_track || '';
  const bits: string[] = [];
  if (p) bits.push(`you're interested in ${p}`);
  if (fit) bits.push(`your quiz said you're ${fit.replace(/^the /i, 'the ')}`);
  else if (clicked && !/quiz|video/i.test(clicked)) bits.push(`you had a look at ${clicked}`);
  const noticed = bits.length ? `I noticed ${bits.join(', and ')}, so` : 'You asked about studying with us, so';
  const say = `Hey ${first}, how are you? I'm ${tutor} from ${academy}. ${noticed} I made this short video just for you. Let me show you what it's really like.`;
  const chips = [p, fit, rec.fields.source ? `via ${rec.fields.source}` : ''].filter(Boolean).slice(0, 3);
  return { slide: { visual: 'greeting', heading: `Hey ${first}`, points: [], say }, noticed: chips };
}

/** The full lesson a lead sees: their greeting, then the shared scenes. */
export function lessonForLead(video: ProgrammeVideo, rec: Pick<DataRecord, 'key' | 'name' | 'fields'>): { lesson: Lesson; noticed: string[]; personal: number } {
  const ac = getAcademyContext();
  const programme = video.programme === 'general' ? leadProgramme(rec.fields) || 'general' : video.programme;
  const g = greetingFor(rec, programme, video.tutorName, ac.academyName);
  const mine = personalScenes(rec.key);
  return {
    lesson: { title: mine.length ? `A video for ${(rec.fields.first_name || rec.name).split(/\s+/)[0]}` : video.title, slides: [g.slide, ...mine, ...video.slides], viaAi: video.viaAi, greeting: g.slide.say, tutorName: video.tutorName, academyName: ac.academyName },
    noticed: g.noticed,
    personal: mine.length,
  };
}

export function countView(id: string) {
  const v = meta().videos.find((x) => x.id === id);
  if (v) { v.views++; metaDoc.save(); }
}
