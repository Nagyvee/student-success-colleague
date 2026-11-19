import { NextResponse } from 'next/server';
import { getState } from '@/lib/engine/store';
import { DEFAULT_GOAL, runGoal } from '@/lib/engine/scenarios/goal';
import { runWithSessionTenant } from '@/lib/auth/requestTenant';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(req: Request) {
  return runWithSessionTenant(req, async () => {
    const body = (await req.json().catch(() => ({}))) as { goal?: string };
    const s = getState();
    if (s.busy) return NextResponse.json({ error: 'The colleague is still working on the last goal. Wait for it to finish.' }, { status: 409 });
    const goal = typeof body.goal === 'string' && body.goal.trim().length >= 8 ? body.goal : DEFAULT_GOAL;
    const task = runGoal(goal);
    if (!task) return NextResponse.json({ error: 'Could not start.' }, { status: 409 });
    return NextResponse.json({ ok: true, taskId: task.id }, { status: 202 });
  });
}
