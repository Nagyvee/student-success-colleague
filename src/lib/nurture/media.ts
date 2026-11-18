import type { SlideVisual } from '@/lib/types';
import type { MediaItem } from './types';
import { FOOTAGE_TAGS } from './types';
import { mediaDoc, bumpStat, nid } from './store';
import { completeWithImage, extractJSON, isStr, obj } from '@/lib/ai/llm';
import { getAcademyContext } from '@/lib/auth/accounts';
import { currentTenantId } from '@/lib/auth/tenantContext';
import { deleteFile, MAX_FILE_BYTES, MAX_VIDEO_BYTES, putFile } from '@/lib/files/store';
import { log } from '@/lib/engine/store';

/* Footage and music for the videos.
 *
 * The academy uploads its own short clips and photos (the team waving hello,
 * students in class, someone coding, the campus, a graduation) and, if it
 * likes, a music track. Each clip is tagged with what it shows (photos are
 * read by AI once); each scene of a video then gets fitting footage by rules,
 * with no AI per video: the greeting gets a welcome shot, the ending a
 * celebration, a Data Science video prefers data footage. Teaching diagrams
 * stay clean. Without footage, the videos use their animated backgrounds. */

const TAGS = new Set<string>(FOOTAGE_TAGS);
const MAX_MUSIC_BYTES = 20 * 1024 * 1024;

export function listMedia(): MediaItem[] {
  return mediaDoc.get();
}

export function getMedia(id: string): MediaItem | null {
  return mediaDoc.get().find((m) => m.id === id) || null;
}

export const mediaUrl = (m: Pick<MediaItem, 'fileId'>, tenantId = currentTenantId()) => `/api/media/${encodeURIComponent(tenantId)}/${m.fileId}`;

function kindOf(mime: string, name: string): MediaItem['kind'] | null {
  if (/^video\//.test(mime) || /\.(mp4|webm|mov|m4v)$/i.test(name)) return 'video';
  if (/^image\//.test(mime) || /\.(jpe?g|png|webp)$/i.test(name)) return 'photo';
  if (/^audio\//.test(mime) || /\.(mp3|m4a|aac|ogg|wav)$/i.test(name)) return 'music';
  return null;
}

const cleanTags = (x: unknown) => (Array.isArray(x) ? [...new Set(x.map((t) => String(t).trim().toLowerCase()).filter((t) => TAGS.has(t)))].slice(0, 6) : []);

/** Tags from the file name when nobody gave any ("team-waving.mp4" → team, welcome). */
function guessTags(name: string): string[] {
  const n = name.toLowerCase();
  const out: string[] = [];
  const add = (t: string, re: RegExp) => { if (re.test(n)) out.push(t); };
  add('welcome', /welcome|hello|wave|waving|intro/);
  add('team', /team|staff|lecturer|facilitator|mentor/);
  add('students', /student|learner|class|group/);
  add('classroom', /class|lecture|lesson|workshop/);
  add('coding', /cod(e|ing)|program|developer|software/);
  add('laptop', /laptop|computer|screen|desk/);
  add('campus', /campus|building|office|entrance|reception/);
  add('celebration', /celebrat|party|cheer|high.?five|win/);
  add('graduation', /graduat|certificate|ceremony/);
  add('data', /data|dashboard|chart|analytics/);
  add('security', /cyber|security|hack|network/);
  add('ai', /\bai\b|robot|machine/);
  return [...new Set(out)];
}

async function describePhoto(data: Buffer, mime: string): Promise<{ tags: string[]; description: string } | null> {
  const ac = getAcademyContext();
  const text = await completeWithImage({
    system: `You tag photos for ${ac.academyName}'s videos so each scene gets fitting footage. Reply with one JSON object only.`,
    prompt: `Describe this photo in one short sentence (what and who is in it), and pick the tags that fit from exactly this list: ${FOOTAGE_TAGS.join(', ')}.\nJSON: {"description": "...", "tags": ["..."]}`,
    image: data, mime, maxTokens: 4000, timeoutMs: 40000,
  });
  if (!text) return null;
  try {
    const o = obj(extractJSON(text));
    if (!o) return null;
    return { description: isStr(o.description) ? String(o.description).slice(0, 200) : '', tags: cleanTags(o.tags) };
  } catch {
    return null;
  }
}

export async function addMedia(file: { name: string; mime: string; data: Buffer }, input: { title?: string; tags?: string[] } = {}): Promise<MediaItem> {
  const kind = kindOf(file.mime, file.name);
  if (!kind) throw new Error('Upload a video clip (MP4), a photo (JPG, PNG) or a music track (MP3).');
  const maxBytes = kind === 'video' ? MAX_VIDEO_BYTES : kind === 'music' ? MAX_MUSIC_BYTES : MAX_FILE_BYTES;
  const stored = await putFile({ name: file.name, mime: file.mime || (kind === 'video' ? 'video/mp4' : kind === 'music' ? 'audio/mpeg' : 'image/jpeg'), data: file.data, maxBytes });
  let tags = cleanTags(input.tags);
  let description = '';
  if (kind === 'photo') {
    const d = await describePhoto(file.data, stored.mime);
    if (d) { bumpStat('aiBuilds'); description = d.description; if (!tags.length) tags = d.tags; }
  }
  if (!tags.length && kind !== 'music') tags = guessTags(file.name);
  const m: MediaItem = {
    id: nid('med'), kind, fileId: stored.id,
    title: (input.title || file.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ')).trim().slice(0, 80) || 'Clip',
    tags, description, mime: stored.mime, size: stored.size, enabled: true, createdAt: Date.now(),
  };
  mediaDoc.get().unshift(m);
  mediaDoc.save();
  if (kind === 'photo') { const tid = currentTenantId(); setTimeout(() => { void warmPhotos(tid); }, 1500); }
  log('system', 'info', `Footage added: "${m.title}" (${kind}${tags.length ? `: ${tags.join(', ')}` : ''}). The videos use it from now on.`);
  return m;
}

export function updateMedia(id: string, patch: { title?: string; tags?: string[]; enabled?: boolean }): MediaItem | null {
  const m = getMedia(id);
  if (!m) return null;
  if (typeof patch.title === 'string' && patch.title.trim()) m.title = patch.title.trim().slice(0, 80);
  if (Array.isArray(patch.tags)) m.tags = cleanTags(patch.tags);
  if (typeof patch.enabled === 'boolean') m.enabled = patch.enabled;
  mediaDoc.save();
  return m;
}

export async function deleteMedia(id: string): Promise<boolean> {
  const m = getMedia(id);
  if (!m) return false;
  mediaDoc.set(mediaDoc.get().filter((x) => x.id !== id));
  await deleteFile(m.fileId);
  return true;
}

/* ── Choosing footage for a video (rules, no AI) ─────────────────────────── */

export interface SceneFootage { url: string; kind: 'video' | 'photo' }

/** Which shots fit which scene, best first. Null: the scene stays clean (a diagram to read). */
const ROLE: Partial<Record<SlideVisual, string[]>> = {
  greeting: ['welcome', 'team', 'campus', 'students'],
  cta: ['celebration', 'graduation', 'students', 'team', 'campus'],
  recap: ['students', 'classroom', 'team', 'celebration'],
  big: ['students', 'classroom', 'coding', 'laptop', 'office', 'city', 'campus'],
  analogy: ['city', 'students', 'office', 'classroom', 'campus'],
  photo: ['campus', 'students', 'classroom', 'team', 'welcome', 'celebration', 'coding'],
  facts: ['classroom', 'students', 'laptop', 'coding'],
  timeline: ['classroom', 'coding', 'laptop', 'students'],
  careers: ['office', 'team', 'laptop', 'coding', 'celebration'],
};

/** Programme words that point at a tag. */
function programmeTags(programme: string): string[] {
  const p = programme.toLowerCase();
  const out: string[] = [];
  if (/data|analytic|science/.test(p)) out.push('data');
  if (/cyber|security|network/.test(p)) out.push('security');
  if (/\bai\b|artificial|machine/.test(p)) out.push('ai');
  if (/software|web|develop|program|cod/.test(p)) out.push('coding', 'laptop');
  return out;
}

/** Footage for each scene of a video (aligned with the slides). A lesson keeps footage to the
 *  greeting, the recap and the ending; a lead's video uses it more (it sells the place and the people). */
export function footageFor(slides: { visual?: SlideVisual }[], programme: string, mode: 'lesson' | 'lead', tenantId = currentTenantId()): (SceneFootage | null)[] {
  const pool = mediaDoc.get(tenantId).filter((m) => m.enabled && (m.kind === 'video' || m.kind === 'photo'));
  if (!pool.length) return slides.map(() => null);
  const boost = programmeTags(programme);
  const used = new Map<string, number>();
  return slides.map((s, i) => {
    const v = s.visual || 'big';
    if (mode === 'lesson' && !['greeting', 'recap', 'cta'].includes(v)) return null;
    const want = ROLE[v];
    if (!want) return null;
    let best: { m: MediaItem; score: number } | null = null;
    for (const m of pool) {
      let score = 0;
      want.forEach((t, k) => { if (m.tags.includes(t)) score += 6 - Math.min(k, 4); });
      // Footage of their own programme counts for a lot (a Software video shows people coding).
      if (boost.some((t) => m.tags.includes(t))) score += 6;
      if (!m.tags.length) score += 1;
      score -= (used.get(m.id) || 0) * 5;
      if (m.kind === 'video') score += 0.5;
      // A stable nudge so equal clips rotate across scenes.
      score += ((i * 7 + m.id.length) % 3) * 0.01;
      if (score > 0 && (!best || score > best.score)) best = { m, score };
    }
    if (!best) return null;
    used.set(best.m.id, (used.get(best.m.id) || 0) + 1);
    const url = mediaUrl(best.m, tenantId);
    // Photos through Next's resizer: full-HD, compressed, cached after the first view.
    return { url: best.m.kind === 'photo' ? photoUrl(best.m, tenantId) : url, kind: best.m.kind as 'video' | 'photo' };
  });
}

/** The resized photo the videos show (Next's image resizer, full-HD, compressed). */
export const photoUrl = (m: Pick<MediaItem, 'fileId'>, tenantId = currentTenantId()) => `/_next/image?url=${encodeURIComponent(mediaUrl(m, tenantId))}&w=1920&q=72`;

/** Ask the running server for each photo's resized copy once, so it is ready before anyone watches. */
export async function warmPhotos(tenantId = currentTenantId()): Promise<number> {
  const port = process.env.PORT || '3200';
  let n = 0;
  for (const m of mediaDoc.get(tenantId).filter((x) => x.enabled && x.kind === 'photo')) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${photoUrl(m, tenantId)}`, { signal: AbortSignal.timeout(60_000) });
      if (r.ok) { await r.arrayBuffer(); n++; }
    } catch { /* the viewer's browser will ask for it instead */ }
  }
  return n;
}

/** The academy's own music bed, if it uploaded one. */
export function musicFor(tenantId = currentTenantId()): string | null {
  const m = mediaDoc.get(tenantId).find((x) => x.enabled && x.kind === 'music');
  return m ? mediaUrl(m, tenantId) : null;
}
