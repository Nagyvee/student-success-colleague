import type { FitQuestion, FitQuiz, FitTrack, TrackPayload } from './types';
import { meta, metaDoc, bumpStat } from './store';
import { programmeList } from './programmes';
import { noteEngagement } from './track';
import { generateJSON, isStr, obj } from '@/lib/ai/llm';
import { getAcademyContext, getTenantIntegrations } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { getRecord, setRecordField } from '@/lib/data/records';

/* The career-fit quiz: "Which tech path fits you?"
 *
 * One quiz per academy, made once from its programmes. Every lead gets the
 * same quiz through their own tracked link, so it costs nothing per lead,
 * and their answers tell the nurturing which programme to talk about. It is
 * the friendliest first step there is: two minutes, no wrong answers, and a
 * result that says something nice about them. */

export const FIT_ICONS = ['code', 'chart', 'shield', 'brain', 'star', 'rocket', 'search', 'users', 'puzzle', 'zap', 'trophy', 'coffee', 'lightbulb', 'target', 'heart', 'compass', 'layout', 'message'] as const;
const ICONS = new Set<string>(FIT_ICONS);

type Trait = 'build' | 'data' | 'protect' | 'invent' | 'create' | 'tell';

const ARCHETYPES: { trait: Trait; test: RegExp; name: string; icon: string; tagline: string; why: (p: string) => string }[] = [
  { trait: 'invent', test: /\b(ai|artificial|machine learning|ml)\b/i, name: 'The Inventor', icon: 'brain', tagline: 'You want to build what comes next.', why: (p) => `You get excited by new ideas and want to teach machines to help people. ${p} turns that curiosity into tools people actually use.` },
  { trait: 'protect', test: /cyber|security|network/i, name: 'The Protector', icon: 'shield', tagline: 'You see the weak spot before anyone else.', why: (p) => `You notice what could go wrong and enjoy outsmarting the problem. ${p} trains exactly that instinct, and every company needs it.` },
  { trait: 'data', test: /data|analytic|science|\bbi\b/i, name: 'The Detective', icon: 'chart', tagline: 'You find the story hidden in the numbers.', why: (p) => `You like puzzles and want to know why things happen. ${p} gives you the tools to turn messy data into answers people act on.` },
  { trait: 'build', test: /software|web|develop|program|coding|engineer|app/i, name: 'The Builder', icon: 'code', tagline: 'You love making ideas real.', why: (p) => `You enjoy creating things and seeing them work. ${p} teaches you to build real apps and websites, step by step, until you can make anything you imagine.` },
  { trait: 'create', test: /design|ux|ui|creative|media/i, name: 'The Creator', icon: 'star', tagline: 'You make things people love to use.', why: (p) => `You care how things look and feel. ${p} turns that eye into designs people enjoy using.` },
  { trait: 'tell', test: /marketing|content|social/i, name: 'The Storyteller', icon: 'message', tagline: 'You know how to get people talking.', why: (p) => `You understand people and what moves them. ${p} gives you the skills to reach them at scale.` },
];

const BANK: { prompt: string; icon: string; options: Partial<Record<Trait, string>> }[] = [
  { prompt: 'It is Saturday and you have a free afternoon. What sounds best?', icon: 'coffee', options: { build: 'Building or fixing something, just to see it work', data: 'Working out a puzzle, or why something happened', protect: 'Finding the weak spot in a game or a system', invent: 'Trying a new AI app and imagining what else it could do', create: 'Designing something that looks and feels great', tell: 'Making a post or video people share' } },
  { prompt: 'Your friends would say you are the one who...', icon: 'users', options: { build: 'makes plans actually happen', data: 'spots patterns nobody else sees', protect: 'checks everything twice', invent: 'always has a new idea', create: 'makes things look good', tell: 'gets everyone excited about something' } },
  { prompt: 'Which headline would you click first?', icon: 'search', options: { build: 'How a 19-year-old built an app thousands use', data: 'What the numbers really say about load-shedding', protect: 'How hackers almost emptied a bank, and who stopped them', invent: 'The AI that can see, talk and write', create: 'The redesign that doubled a shop\'s sales', tell: 'The campaign everyone in Mzansi talked about' } },
  { prompt: 'In a group project, you would rather...', icon: 'puzzle', options: { build: 'build the actual thing', data: 'research and test what works', protect: 'make sure nothing can go wrong', invent: 'come up with the big idea', create: 'design how it looks', tell: 'present it to everyone' } },
  { prompt: 'Pick a superpower.', icon: 'zap', options: { build: 'Make any idea real', data: 'Predict what happens next', protect: 'See every threat before it lands', invent: 'Teach machines to think', create: 'Make anything beautiful', tell: 'Make anyone listen' } },
  { prompt: 'A year from now, what would make you proudest?', icon: 'trophy', options: { build: 'An app or website I made, live and used', data: 'A report that changed a big decision', protect: 'Stopping an attack before it hurt anyone', invent: 'An AI tool people rely on', create: 'A design people love using', tell: 'A campaign that reached thousands' } },
];

/** The quiz from the academy's programmes without the model: archetypes and a fixed question bank. */
export function templateQuiz(programmes: string[], academy: string): FitQuiz | null {
  const tracks: (FitTrack & { trait: Trait })[] = [];
  for (const p of programmes) {
    const a = ARCHETYPES.find((x) => x.test.test(p) && !tracks.some((t) => t.trait === x.trait));
    if (!a) continue;
    tracks.push({ id: a.trait, trait: a.trait, name: a.name, programme: p, tagline: a.tagline, why: a.why(p), icon: a.icon });
  }
  if (tracks.length < 2) return null;
  const questions: FitQuestion[] = BANK.map((q, i) => ({
    id: `q${i + 1}`,
    prompt: q.prompt,
    icon: q.icon,
    options: tracks.filter((t) => q.options[t.trait]).map((t) => ({ label: q.options[t.trait]!, track: t.id })),
  })).filter((q) => q.options.length >= 2);
  return {
    title: 'Which tech path fits you?',
    intro: `Six quick questions, no wrong answers. We'll match what you enjoy to a path at ${academy}.`,
    tracks: tracks.map(({ trait: _t, ...t }) => t),
    questions,
    viaAi: false,
    createdAt: Date.now(),
  };
}

export function getFitQuiz(): FitQuiz | null {
  return meta().fit;
}

/** Make (or remake) the quiz. One AI call, ever; the template if the model is off. */
export async function buildFitQuiz(): Promise<FitQuiz> {
  const programmes = programmeList();
  const ac = getAcademyContext();
  if (programmes.length < 2) throw new Error('Add at least two programmes first (Settings → academy focus, e.g. "Software Development, Data Science, Cybersecurity").');
  const ti = getTenantIntegrations(currentTenantId());
  const ai = await generateJSON<FitQuiz>({
    system: `You design a short, fun career-fit quiz for ${ac.academyName}, a tech academy in South Africa. People who might study with us take it before they decide. Warm, light, relatable to young South Africans and to parents; no jargon; no wrong answers. Reply with one JSON object only.`,
    prompt: `Programmes (one track each): ${programmes.join('; ')}.
${ti.agentKnowledge ? `What you know about the academy:\n${ti.agentKnowledge.slice(0, 1500)}\n` : ''}
Make one track per programme: {"id": "short-id", "name": "The Builder (an archetype, 2 to 3 words)", "programme": "exact programme name from the list", "tagline": "max 9 words", "why": "2 sentences spoken to the person: why this fits them", "icon": one of ${FIT_ICONS.join(', ')}}.
Then 6 questions about what they enjoy (not tech knowledge): {"id": "q1", "prompt": "max 14 words", "icon": one of the icons, "options": [{"label": "max 10 words", "track": "a track id"}]} with one option per track, in a mixed order.
JSON: {"title": "max 7 words", "intro": "one sentence", "tracks": [...], "questions": [...]}`,
    maxTokens: 10000,
    timeoutMs: 40000,
    validate: (x) => {
      const o = obj(x); if (!o || !Array.isArray(o.tracks) || !Array.isArray(o.questions)) return null;
      const tracks: FitTrack[] = (o.tracks as unknown[]).map((t) => obj(t)).filter((t): t is Record<string, unknown> => Boolean(t && isStr(t.id) && isStr(t.name) && isStr(t.programme) && programmes.includes(String(t.programme))))
        .map((t) => ({ id: String(t.id).slice(0, 24), name: String(t.name).slice(0, 40), programme: String(t.programme), tagline: isStr(t.tagline) ? String(t.tagline).slice(0, 90) : '', why: isStr(t.why) ? String(t.why).slice(0, 320) : '', icon: ICONS.has(String(t.icon)) ? String(t.icon) : 'target' }));
      const ids = new Set(tracks.map((t) => t.id));
      if (tracks.length < 2 || ids.size !== tracks.length) return null;
      const questions: FitQuestion[] = (o.questions as unknown[]).map((q, i) => obj(q)).filter((q): q is Record<string, unknown> => Boolean(q && isStr(q.prompt) && Array.isArray(q.options)))
        .map((q, i) => ({
          id: `q${i + 1}`,
          prompt: String(q.prompt).slice(0, 120),
          icon: ICONS.has(String(q.icon)) ? String(q.icon) : 'compass',
          options: (q.options as unknown[]).map((op) => obj(op)).filter((op): op is Record<string, unknown> => Boolean(op && isStr(op.label) && ids.has(String(op.track)))).map((op) => ({ label: String(op.label).slice(0, 90), track: String(op.track) })),
        }))
        .filter((q) => q.options.length >= 2);
      if (questions.length < 4) return null;
      return { title: isStr(o.title) ? String(o.title).slice(0, 60) : 'Which tech path fits you?', intro: isStr(o.intro) ? String(o.intro).slice(0, 200) : '', tracks, questions: questions.slice(0, 8), viaAi: true, createdAt: Date.now() };
    },
  });
  const quiz = ai || templateQuiz(programmes, ac.academyName);
  if (!quiz) throw new Error('Could not match your programmes to quiz tracks. Check the programme names in Settings.');
  if (ai) bumpStat('aiBuilds');
  const m = meta();
  m.fit = quiz;
  metaDoc.save();
  return quiz;
}

/** The quiz, made from the template the first time someone needs it (no waiting on the model). */
export function ensureFitQuiz(): FitQuiz | null {
  const m = meta();
  if (m.fit) return m.fit;
  const q = templateQuiz(programmeList(), getAcademyContext().academyName);
  if (q) { m.fit = q; metaDoc.save(); }
  return q;
}

/** Answers → the track that fits best (ties go to the first track). */
export function scoreFit(quiz: FitQuiz, answers: Record<string, number>): { track: FitTrack; scores: Record<string, number> } {
  const scores: Record<string, number> = Object.fromEntries(quiz.tracks.map((t) => [t.id, 0]));
  for (const q of quiz.questions) {
    const pick = answers[q.id];
    const opt = Number.isInteger(pick) ? q.options[pick] : undefined;
    if (opt && opt.track in scores) scores[opt.track]++;
  }
  const track = quiz.tracks.reduce((best, t) => (scores[t.id] > scores[best.id] ? t : best), quiz.tracks[0]);
  return { track, scores };
}

/** A lead finished the quiz: save the result on their record and count it. */
export async function submitFit(p: TrackPayload, answers: Record<string, number>): Promise<{ track: FitTrack; scores: Record<string, number>; first: string } | null> {
  const quiz = ensureFitQuiz();
  const rec = getRecord(p.s, p.k);
  if (!quiz || !rec) return null;
  const { track, scores } = scoreFit(quiz, answers);
  setRecordField(p.s, p.k, 'fit_track', track.name);
  setRecordField(p.s, p.k, 'fit_programme', track.programme);
  setRecordField(p.s, p.k, 'fit_done', 'yes');
  setRecordField(p.s, p.k, 'fit_at', new Date().toISOString());
  await noteEngagement(p, 'quiz', `${track.name} → ${track.programme}`);
  return { track, scores, first: (rec.fields.first_name || rec.name).split(/\s+/)[0] };
}
