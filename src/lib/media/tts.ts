import { noteFine, noteProblem } from '@/lib/engine/problems';
import fs from 'node:fs';
import { forSpeech } from './speech';
import path from 'node:path';
import { createHash } from 'node:crypto';

/* The lesson's voice.
 *
 * A natural voice reads each slide's narration. Deepgram (Aura) is the
 * academy's voice provider and is used first; ElevenLabs or OpenAI are used
 * only when there is no Deepgram key (or TTS_PROVIDER names one). With none of them the route
 * answers 404 and the player falls back to the browser's own speech, so a
 * lesson always plays.
 *
 * Audio is generated once per slide and kept on disk, keyed by the text and
 * the voice, so replays and re-opens cost nothing. Only narration that exists
 * in a stored lesson is ever spoken: callers pass slide text, never user text. */

export type TtsProvider = 'elevenlabs' | 'openai' | 'deepgram';

const TIMEOUT_MS = 20_000;
const MAX_CHARS = 1600;

/** The Deepgram key, under the names it is usually given. */
export const deepgramKey = () => (process.env.DEEPGRAM_API_KEY || process.env.DEEPGRAM_KEY || process.env.DG_API_KEY || '').trim();

export function ttsProvider(): TtsProvider | null {
  const forced = (process.env.TTS_PROVIDER || '').trim().toLowerCase();
  const has: Record<TtsProvider, boolean> = {
    deepgram: Boolean(deepgramKey()),
    elevenlabs: Boolean(process.env.ELEVENLABS_API_KEY?.trim()),
    openai: Boolean(process.env.OPENAI_API_KEY?.trim()),
  };
  if ((forced === 'deepgram' || forced === 'elevenlabs' || forced === 'openai') && has[forced]) return forced;
  if (has.deepgram) return 'deepgram';
  if (has.elevenlabs) return 'elevenlabs';
  if (has.openai) return 'openai';
  return null;
}

function voiceId(p: TtsProvider): string {
  if (p === 'elevenlabs') return process.env.ELEVENLABS_VOICE_ID?.trim() || 'EXAVITQu4vr4xnSDxMaL';
  if (p === 'openai') return process.env.OPENAI_TTS_VOICE?.trim() || 'coral';
  return process.env.DEEPGRAM_TTS_MODEL?.trim() || 'aura-2-thalia-en';
}

const safeSegment = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || 'x';

function cachePath(tenantId: string, quizId: string, slide: number, text: string, p: TtsProvider): string {
  const hash = createHash('sha1').update(`${p}|${voiceId(p)}|${text}`).digest('hex').slice(0, 14);
  return path.join(process.cwd(), '.data', 'media', safeSegment(tenantId), safeSegment(quizId), `${slide}-${hash}.mp3`);
}

async function elevenlabs(text: string, signal: AbortSignal): Promise<Buffer> {
  const voice = voiceId('elevenlabs');
  const model = process.env.ELEVENLABS_MODEL?.trim() || 'eleven_multilingual_v2';
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY!.trim(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.25, use_speaker_boost: true } }),
    signal,
  });
  if (!res.ok) throw new Error(`ElevenLabs answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function openai(text: string, signal: AbortSignal): Promise<Buffer> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY!.trim()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL?.trim() || 'gpt-4o-mini-tts',
      voice: voiceId('openai'),
      input: text,
      instructions: 'You are a warm, encouraging tutor recording a short personal video lesson for one student. Speak clearly at a relaxed pace, smile in your voice, and pause briefly between ideas.',
      response_format: 'mp3',
    }),
    signal,
  });
  if (!res.ok) throw new Error(`OpenAI TTS answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function deepgram(text: string, signal: AbortSignal): Promise<Buffer> {
  const model = voiceId('deepgram');
  const res = await fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(model)}&encoding=mp3`, {
    method: 'POST',
    headers: { Authorization: `Token ${deepgramKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) throw new Error(`Deepgram answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Plain, speakable text: no markdown, no emoji, within the provider's limits. */
export function speakable(text: string): string {
  // Rand, percentages, times and acronyms as a presenter would say them.
  return forSpeech(text)
    .replace(/[`*_#>]/g, '')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHARS);
}

const g = globalThis as unknown as { __thusoTts?: Map<string, Promise<Buffer | null>>; __thusoVoice?: { okAt: number; failAt: number; error: string } };
const inflight = (g.__thusoTts ??= new Map());
const health = (g.__thusoVoice ??= { okAt: 0, failAt: 0, error: '' });

/** The provider's last answer, when it was a refusal ('' when all is well). */
export const voiceError = () => (health.failAt > health.okAt ? health.error : '');

/** A voice is set up and did not just fail (a player that knows starts with the device's own voice, inside the tap). */
export const voiceReady = () => Boolean(ttsProvider()) && !(health.failAt > health.okAt && Date.now() - health.failAt < 2 * 60_000);

/** The narration for one slide as MP3, from the disk cache or freshly made.
 *  Null when no provider is configured or the provider failed: never throws. */
export async function slideAudio(tenantId: string, quizId: string, slide: number, rawText: string): Promise<Buffer | null> {
  const p = ttsProvider();
  const text = speakable(rawText);
  if (!p || !text) return null;
  const file = cachePath(tenantId, quizId, slide, text, p);
  try { return await fs.promises.readFile(file); } catch { /* not cached yet */ }
  const pending = inflight.get(file);
  if (pending) return pending;
  const job = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const audio = p === 'elevenlabs' ? await elevenlabs(text, ctrl.signal)
        : p === 'openai' ? await openai(text, ctrl.signal)
          : await deepgram(text, ctrl.signal);
      if (audio.length < 512) throw new Error('empty audio');
      health.okAt = Date.now();
      noteFine('voice', tenantId);
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, audio);
      } catch { /* read-only disk: serve it uncached */ }
      return audio;
    } catch (e) {
      health.failAt = Date.now();
      health.error = (e as Error).message.slice(0, 160);
      noteProblem('voice', { why: health.error, sure: /\b40[123]\b/.test(health.error) }, tenantId);
      console.warn(`[thuso] lesson voice (${p}) failed: ${(e as Error).message}; the player will use the browser voice.`);
      return null;
    } finally {
      clearTimeout(timer);
      inflight.delete(file);
    }
  })();
  inflight.set(file, job);
  return job;
}

/** Make every slide's narration ahead of time (two at a time), so the lesson
 *  starts instantly when the learner presses play. Fire and forget. */
export function warmLessonAudio(tenantId: string, quizId: string, slides: { say: string }[]): void {
  if (!ttsProvider() || !slides.length) return;
  const queue = slides.map((s, i) => ({ i, say: s.say }));
  const worker = async () => {
    for (let job = queue.shift(); job; job = queue.shift()) await slideAudio(tenantId, quizId, job.i, job.say);
  };
  void Promise.all([worker(), worker()]).catch(() => { /* the route makes any missing slide on demand */ });
}
