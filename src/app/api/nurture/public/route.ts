import { NextResponse } from 'next/server';
import { withTenant } from '@/lib/auth/tenantContext';
import { getAcademyContext, getTenantIntegrations, listTenantIds } from '@/lib/auth/accounts';
import { bootReady } from '@/lib/engine/automation';
import { getRecord } from '@/lib/data/records';
import { liveFields } from '@/lib/data/sources';
import { getState } from '@/lib/engine/store';
import { lessonBrand } from '@/lib/engine/quiz';
import { readTrack, signTrack, trackUrl } from '@/lib/nurture/track';
import { ensureFitQuiz, submitFit } from '@/lib/nurture/fit';
import { countView, lessonForLead, videoFor } from '@/lib/nurture/video';
import { leadProgramme } from '@/lib/nurture/programmes';
import { noteEngagement } from '@/lib/nurture/track';
import { slideAudio, ttsProvider } from '@/lib/media/tts';
import { claimShared, dateText, findVoucher, getOffer, valueText } from '@/lib/nurture/vouchers';
import { programmeList } from '@/lib/nurture/programmes';
import { footageFor, musicFor } from '@/lib/nurture/media';
import type { TrackPayload } from '@/lib/nurture/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* What a lead's own pages read (public: the signed token is the key).
 *
 *   GET  ?t=<token>&fit=1          the career-fit quiz, with their first name
 *   POST {t, answers}              their answers → their track, saved on their record
 *   GET  ?t=<token>&watch=1        their programme video (greeting made for them)
 *   GET  ?t=<token>&audio=N        the narration of scene N (shared scenes are cached once)
 *   GET  ?t=<token>&audio=probe    is a natural voice available
 *   POST {t, watched: true}        they pressed play (counts once) */

async function within<T>(token: string | null, fn: (p: TrackPayload) => Promise<T>): Promise<T | Response> {
  const p = token ? readTrack(token) : null;
  if (!p || !listTenantIds().includes(p.t)) return NextResponse.json({ error: 'This link has expired.' }, { status: 404 });
  await bootReady(p.t);
  return withTenant(p.t, () => fn(p));
}

/** Links on the lead's pages carry their identity, with a different destination. */
function linkFor(p: TrackPayload, x: TrackPayload['x']): string {
  return trackUrl(getState().caps.baseUrl, { ...p, x, r: undefined, u: undefined, m: p.m });
}

function nextSteps(p: TrackPayload) {
  const apply = (getTenantIntegrations(p.t).applyUrl || '').trim();
  return {
    apply: { href: linkFor(p, 'apply'), label: apply ? 'Start my application' : 'Help me apply' },
    video: { href: linkFor(p, 'video'), label: 'Watch my video' },
    quiz: { href: linkFor(p, 'quiz'), label: 'Find my tech fit' },
  };
}

/** The workspace a voucher code belongs to (codes are unique per workspace; the first match wins). */
async function tenantForCode(code: string): Promise<string | null> {
  const c = code.trim().toUpperCase();
  if (!/^[A-Z0-9]{1,6}-[A-Z]{4}-[A-Z0-9]{4}$/.test(c)) return null;
  for (const tid of listTenantIds()) {
    await bootReady(tid);
    if (withTenant(tid, () => Boolean(findVoucher(c)))) return tid;
  }
  return null;
}

async function voucherView(code: string) {
  const tid = await tenantForCode(code);
  if (!tid) return NextResponse.json({ error: 'That voucher does not exist.' }, { status: 404 });
  return withTenant(tid, () => {
    const v = findVoucher(code)!;
    const o = getOffer(v.offerId);
    if (!o) return NextResponse.json({ error: 'That voucher does not exist.' }, { status: 404 });
    const ac = getAcademyContext();
    const state = v.status === 'redeemed' ? 'used' : v.status === 'cancelled' || v.expiresAt < Date.now() ? 'ended' : 'valid';
    return NextResponse.json({
      code: v.code, state, value: valueText(o), appliesTo: o.appliesTo, expires: dateText(v.expiresAt), shareable: o.shareable,
      from: v.leadName.split(/\s+/)[0], academy: ac.academyName, brand: lessonBrand(ac.academyName), programmes: programmeList(),
      applyUrl: (getTenantIntegrations(tid).applyUrl || '').trim() || null,
    });
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const vcode = url.searchParams.get('voucher');
  if (vcode) return voucherView(vcode);
  return within(url.searchParams.get('t'), async (p) => {
    const ac = getAcademyContext();
    const rec = getRecord(p.s, p.k);
    if (!rec) return NextResponse.json({ error: 'We could not find you. Reply to our email and we will help.' }, { status: 404 });
    const f = liveFields(rec);
    const first = (f.first_name || rec.name).split(/\s+/)[0];

    if (url.searchParams.get('fit')) {
      const quiz = ensureFitQuiz();
      if (!quiz) return NextResponse.json({ error: 'The quiz is not ready yet.' }, { status: 404 });
      return NextResponse.json({
        first, academy: ac.academyName, brand: lessonBrand(ac.academyName),
        quiz: { title: quiz.title, intro: quiz.intro, questions: quiz.questions, tracks: quiz.tracks },
        done: f.fit_done === 'yes' ? { track: f.fit_track, programme: f.fit_programme } : null,
        next: nextSteps(p),
      });
    }

    const programme = leadProgramme(f) || 'general';
    const video = videoFor(programme);
    if (url.searchParams.get('watch')) {
      if (!video) return NextResponse.json({ error: 'Your video is still being made. Try again in a few minutes.' }, { status: 404 });
      const { lesson, noticed } = lessonForLead(video, rec);
      const next = nextSteps(p);
      const quizDone = f.fit_done === 'yes';
      return NextResponse.json({
        learner: { name: rec.name },
        module: { code: video.programme === 'general' ? 'Tech' : video.programme, title: video.title },
        topic: video.programme === 'general' ? (programme === 'general' ? 'tech' : programme) : video.programme,
        passMark: 0, questions: [], lesson, academyName: ac.academyName, evidence: null, brand: lessonBrand(ac.academyName),
        noticed,
        presenter: { label: 'Admissions' },
        cta: quizDone ? next.apply : next.quiz,
        skip: quizDone ? next.apply : next.quiz,
        ctaTiles: quizDone ? [['5 min', 'to apply'], ['Live', 'classes'], ['1:1', 'support']] : [['2 min', 'fit quiz'], ['6', 'questions'], ['0', 'wrong answers']],
        ctaKicker: `Your next step, ${first}`,
        footage: footageFor(lesson.slides, video.programme === 'general' ? programme : video.programme, 'lead'),
        music: musicFor(),
      });
    }

    const audio = url.searchParams.get('audio');
    if (audio) {
      if (!video) return NextResponse.json({ error: 'No video.' }, { status: 404 });
      if (audio === 'probe') return NextResponse.json({ available: Boolean(ttsProvider()) }, { headers: { 'Cache-Control': 'no-store' } });
      const n = Number(audio);
      const { lesson, personal } = lessonForLead(video, rec);
      if (!Number.isInteger(n) || n < 0 || n >= lesson.slides.length || !ttsProvider()) return NextResponse.json({ error: 'No audio.' }, { status: 404 });
      // The greeting and any scenes made for this lead are voiced for them; the shared scenes once, for everyone.
      const own = n <= personal;
      const clip = await slideAudio(p.t, own ? `${video.id}_${rec.key.replace(/[^a-z0-9]/gi, '').slice(0, 30)}` : video.id, own ? n : n - 1 - personal, lesson.slides[n].say);
      if (!clip) return NextResponse.json({ error: 'The voice is unavailable right now.' }, { status: 404 });
      return new Response(new Uint8Array(clip), { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': String(clip.length), 'Cache-Control': 'private, max-age=86400', 'X-Robots-Tag': 'noindex' } });
    }

    return NextResponse.json({ error: 'Say what you need: fit, watch or audio.' }, { status: 400 });
  });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (typeof body.voucher === 'string') {
    const tid = await tenantForCode(body.voucher);
    if (!tid) return NextResponse.json({ error: 'That voucher does not exist.' }, { status: 404 });
    const s = (k: string) => (typeof body[k] === 'string' ? String(body[k]) : '');
    const r = await withTenant(tid, () => claimShared(String(body.voucher), { name: s('name'), email: s('email'), phone: s('phone'), interest: s('interest') }));
    return r.ok ? NextResponse.json(r) : NextResponse.json({ error: r.error }, { status: 400 });
  }
  return within(typeof body.t === 'string' ? body.t : null, async (p) => {
    if (body.watched === true) {
      const rec = getRecord(p.s, p.k);
      const video = rec ? videoFor(leadProgramme(liveFields(rec)) || 'general') : null;
      if (rec && video) {
        const seen = (rec.fields.nurture_seen || '').includes(`video:${p.m}:`);
        await noteEngagement({ ...p, x: 'video' }, 'video', video.title);
        if (!seen) countView(video.id);
      }
      return NextResponse.json({ ok: true });
    }
    const raw = (body.answers && typeof body.answers === 'object' ? body.answers : {}) as Record<string, unknown>;
    const answers: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) if (/^q\d{1,2}$/.test(k) && Number.isInteger(v)) answers[k] = v as number;
    if (Object.keys(answers).length < 3) return NextResponse.json({ error: 'Answer the questions first.' }, { status: 400 });
    const r = await submitFit(p, answers);
    if (!r) return NextResponse.json({ error: 'We could not save that. Reply to our email and we will help.' }, { status: 404 });
    // Their video link now knows their programme.
    return NextResponse.json({ ok: true, track: r.track, scores: r.scores, first: r.first, next: nextSteps({ ...p, m: p.m }), token: signTrack(p) });
  });
}
