import { NextResponse } from 'next/server';
import { findQuiz, publicQuizView } from '@/lib/engine/quiz';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(_req: Request, ctx: { params: Promise<{ quizId: string }> }) {
  const { quizId } = await ctx.params;
  const d = findQuiz(quizId);
  if (!d) return NextResponse.json({ error: 'No quiz with that id. It may not have been dispatched yet.' }, { status: 404 });
  return NextResponse.json(publicQuizView(d));
}
