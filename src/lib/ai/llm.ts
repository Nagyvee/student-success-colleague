import Anthropic from '@anthropic-ai/sdk';
import { bump } from '@/lib/engine/store';

/* The model behind the agents.
 *
 * One function, complete(), and one JSON wrapper around it. Anthropic if
 * ANTHROPIC_API_KEY is set, OpenAI if OPENAI_API_KEY is, and null otherwise so
 * every caller falls through to its deterministic simulation. A slow or
 * failing call also returns null: the demo never waits on the network.
 *
 * Anthropic calls run on ANTHROPIC_MODEL (default Claude Haiku 5.5) at low
 * effort (fast, and the drafts here are short), with Anthropic's server-side
 * refusal fallback switched on
 * so a declined request is re-run on a fallback model inside the same call.
 * max_tokens stays generous: on the 5-series the model's thinking is billed
 * inside it, and a ceiling of a few hundred tokens returns no text at all. */

export type Provider = 'anthropic' | 'openai' | 'simulation';

export function provider(): Provider {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OPENAI_API_KEY) return 'openai';
  return 'simulation';
}

export function modelName() {
  const p = provider();
  if (p === 'anthropic') return process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
  if (p === 'openai') return process.env.OPENAI_MODEL || 'gpt-4o-mini';
  return 'simulation';
}

let anthropic: Anthropic | null = null;
function anthropicClient() {
  if (!anthropic) anthropic = new Anthropic();
  return anthropic;
}

export interface CompleteOptions {
  system: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
  json?: boolean;
}

export async function complete(o: CompleteOptions): Promise<string | null> {
  const p = provider();
  if (p === 'simulation') return null;
  // Adaptive thinking is billed inside max_tokens: never hand the model a ceiling it will spend on thinking alone.
  const maxTokens = Math.max(o.maxTokens ?? 8000, 4000);
  const timeoutMs = o.timeoutMs ?? 28_000;
  try {
    bump('aiCalls');
    if (p === 'anthropic') return await completeAnthropic(o.system, o.prompt, maxTokens, timeoutMs);
    return await completeOpenAI(o.system, o.prompt, maxTokens, timeoutMs, o.json !== false);
  } catch (e) {
    console.warn('[student-success] model call failed, using simulation:', (e as Error)?.message || e);
    return null;
  }
}

async function completeAnthropic(system: string, prompt: string, maxTokens: number, timeoutMs: number) {
  const client = anthropicClient();
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
  const base = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user' as const, content: prompt }],
  };
  // Effort is the speed lever on the 5-series; older models ignore it.
  const effort = /opus-5|sonnet-5|haiku-5|fable|opus-4-[678]|sonnet-4-6/.test(model) ? { output_config: { effort: 'low' as const } } : {};
  let res: Anthropic.Message | Anthropic.Beta.BetaMessage;
  try {
    const req = { ...base, ...effort, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
    res = await client.beta.messages.create(req as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming, { timeout: timeoutMs, maxRetries: 0 });
  } catch (e) {
    // A key or model that cannot take the fallback beta still gets a plain call.
    if (e instanceof Anthropic.BadRequestError || e instanceof Anthropic.NotFoundError) {
      res = await client.messages.create({ ...base, ...effort } as Anthropic.MessageCreateParamsNonStreaming, { timeout: timeoutMs, maxRetries: 0 });
    } else throw e;
  }
  if (res.stop_reason === 'refusal') return null;
  return res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n');
}

/** Read a PDF (a guide, a prospectus) and answer about it. Anthropic only: the
 *  document goes to the model as-is, so nothing needs a PDF parser here. */
export async function completeWithPdf(o: CompleteOptions & { pdf: Buffer }): Promise<string | null> {
  if (provider() !== 'anthropic') return null;
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
  const effort = /opus-5|sonnet-5|haiku-5|fable|opus-4-[678]|sonnet-4-6/.test(model) ? { output_config: { effort: 'low' as const } } : {};
  try {
    bump('aiCalls');
    const res = await anthropicClient().messages.create({
      model,
      max_tokens: Math.max(o.maxTokens ?? 6000, 4000),
      system: o.system,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: o.pdf.toString('base64') } },
          { type: 'text', text: o.prompt },
        ],
      }],
      ...effort,
    } as Anthropic.MessageCreateParamsNonStreaming, { timeout: o.timeoutMs ?? 60_000, maxRetries: 0 });
    if (res.stop_reason === 'refusal') return null;
    return res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n');
  } catch (e) {
    console.warn('[student-success] PDF read failed:', (e as Error)?.message || e);
    return null;
  }
}

/** Look at a photo and answer about it (Anthropic only). Used once per uploaded photo. */
export async function completeWithImage(o: CompleteOptions & { image: Buffer; mime: string }): Promise<string | null> {
  if (provider() !== 'anthropic') return null;
  const mt = /png/.test(o.mime) ? 'image/png' : /webp/.test(o.mime) ? 'image/webp' : /gif/.test(o.mime) ? 'image/gif' : 'image/jpeg';
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
  const effort = /opus-5|sonnet-5|haiku-5|fable|opus-4-[678]|sonnet-4-6/.test(model) ? { output_config: { effort: 'low' as const } } : {};
  try {
    bump('aiCalls');
    const res = await anthropicClient().messages.create({
      model,
      max_tokens: Math.max(o.maxTokens ?? 4000, 4000),
      system: o.system,
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mt, data: o.image.toString('base64') } }, { type: 'text', text: o.prompt }] }],
      ...effort,
    } as Anthropic.MessageCreateParamsNonStreaming, { timeout: o.timeoutMs ?? 40_000, maxRetries: 0 });
    if (res.stop_reason === 'refusal') return null;
    return res.content.filter((b): b is Anthropic.TextBlock => b.type === 'text').map((b) => b.text).join('\n');
  } catch (e) {
    console.warn('[student-success] image read failed:', (e as Error)?.message || e);
    return null;
  }
}

async function completeOpenAI(system: string, prompt: string, maxTokens: number, timeoutMs: number, json: boolean) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        max_tokens: maxTokens,
        temperature: 0.4,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? null;
  } finally { clearTimeout(t); }
}

/** The first JSON object or array in a reply, fences and chatter stripped. */
export function extractJSON(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const start = Math.min(...['{', '['].map((c) => { const i = cleaned.indexOf(c); return i < 0 ? Infinity : i; }));
  if (!Number.isFinite(start)) throw new Error('no JSON in reply');
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  const end = cleaned.lastIndexOf(close);
  const body = cleaned.slice(start, end + 1);
  try { return JSON.parse(body); }
  catch { return JSON.parse(repairJSON(body)); }
}

/** The repairs a model reply usually needs: raw newlines inside strings, trailing commas, curly quotes. */
function repairJSON(body: string) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (const ch of body) {
    if (inStr) {
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r' || ch === '\t') { out += ' '; continue; }
      if (ch === '\u201c' || ch === '\u201d') { out += "'"; continue; }
      out += ch;
      continue;
    }
    if (ch === '"') { inStr = true; out += ch; continue; }
    if (ch === '\u201c' || ch === '\u201d') { inStr = true; out += '"'; continue; }
    out += ch;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

export interface JsonOptions<T> extends CompleteOptions {
  /** Return the typed value, or null to reject the reply. */
  validate: (x: unknown) => T | null;
}

/** Ask for JSON, validate it, and hand back null for anything short of valid. */
export async function generateJSON<T>(o: JsonOptions<T>): Promise<T | null> {
  const text = await complete({ ...o, json: true });
  if (!text) return null;
  try {
    const parsed = extractJSON(text);
    return o.validate(parsed);
  } catch (e) {
    console.warn('[student-success] model reply was not usable JSON:', (e as Error)?.message);
    return null;
  }
}

/** Messages never carry emoji (the academy's voice is plain and human). Removes pictographs and tidies the spaces they leave. */
export const noEmoji = (t: string) => t
  .replace(/[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
  .replace(/[ \t]{2,}/g, ' ')
  .replace(/ +([,.!?])/g, '$1')
  .replace(/ +\n/g, '\n')
  .trim();

/* small validators */
export const isStr = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
export const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
export const strArr = (x: unknown, min = 1): string[] | null => (Array.isArray(x) && x.length >= min && x.every(isStr) ? x.map((s) => s.trim()) : null);
export const obj = (x: unknown): Record<string, unknown> | null => (x && typeof x === 'object' && !Array.isArray(x) ? (x as Record<string, unknown>) : null);
