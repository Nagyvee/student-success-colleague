import { NextResponse } from 'next/server';
import { findQuiz } from '@/lib/engine/quiz';
import { findTenantForQuiz } from '@/lib/auth/requestTenant';
import { withTenant } from '@/lib/auth/tenantContext';
import { slideAudio, ttsProvider, voiceReady } from '@/lib/media/tts';
import { serveMedia } from '@/lib/media/serve';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* The narration of one slide of a learner's lesson, as MP3.
 *
 *   GET /api/lesson/{quizId}/audio?probe=1  → { available, slides }
 *   GET /api/lesson/{quizId}/audio?slide=N  → audio/mpeg, or 404 so the
 *                                             player uses the browser voice
 *
 * Public like the lesson itself (the quiz id is the secret). It only ever
 * speaks narration stored in that lesson. */

export async function GET(req: Request, ctx: { params: Promise<{ quizId: string }> }) {
  const { quizId } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(quizId)) return NextResponse.json({ error: 'Bad lesson id.' }, { status: 400 });
  const url = new URL(req.url);
  const tid = await findTenantForQuiz(quizId);
  return withTenant(tid, async () => {
    const d = findQuiz(quizId);
    const slides = d?.content.lesson?.slides || [];
    if (!d || !slides.length) return NextResponse.json({ error: 'No lesson with that id.' }, { status: 404 });

    if (url.searchParams.get('probe')) {
      return NextResponse.json({ available: voiceReady(), slides: slides.length }, { headers: { 'Cache-Control': 'no-store' } });
    }

    const n = Number(url.searchParams.get('slide'));
    if (!Number.isInteger(n) || n < 0 || n >= slides.length) return NextResponse.json({ error: 'No such slide.' }, { status: 400 });
    if (!ttsProvider()) return NextResponse.json({ error: 'No lesson voice configured.' }, { status: 404 });

    const audio = await slideAudio(tid, quizId, n, slides[n].say);
    if (!audio) return NextResponse.json({ error: 'The lesson voice is unavailable right now.' }, { status: 404 });
    return serveMedia(req, audio, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400', 'X-Robots-Tag': 'noindex' });
  });
}
