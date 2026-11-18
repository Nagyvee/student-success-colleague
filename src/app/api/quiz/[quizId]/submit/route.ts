import { NextResponse } from 'next/server';
import { publicQuizView, submitQuiz } from '@/lib/engine/quiz';
import { findTenantForQuiz } from '@/lib/auth/requestTenant';
import { withTenant } from '@/lib/auth/tenantContext';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request, ctx: { params: Promise<{ quizId: string }> }) {
  const { quizId } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { answers?: unknown };
  const answers = Array.isArray(body.answers) ? body.answers.map((a) => (Number.isInteger(a) ? (a as number) : -1)) : null;
  if (!answers) return NextResponse.json({ error: 'answers must be an array of option indexes.' }, { status: 400 });
  const tid = await findTenantForQuiz(quizId);
  return withTenant(tid, async () => {
    const out = await submitQuiz(quizId, answers);
    if (!out) return NextResponse.json({ error: 'No quiz with that id.' }, { status: 404 });
    return NextResponse.json({ ...publicQuizView(out.deliverable), already: out.already });
  });
}
