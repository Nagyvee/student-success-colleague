import { NextResponse } from 'next/server';
import { getState } from '@/lib/engine/store';
import { DEFAULT_GOAL, runGoal } from '@/lib/engine/scenarios/goal';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/* One goal in, one end-to-end run. The run continues after this responds. */

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { goal?: string };
  const s = getState();
  if (s.busy) return NextResponse.json({ error: 'The colleague is still working on the last goal. Wait for it to finish.' }, { status: 409 });
  const goal = typeof body.goal === 'string' && body.goal.trim().length >= 8 ? body.goal : DEFAULT_GOAL;
  const task = runGoal(goal);
  if (!task) return NextResponse.json({ error: 'Could not start.' }, { status: 409 });
  return NextResponse.json({ ok: true, taskId: task.id }, { status: 202 });
}
