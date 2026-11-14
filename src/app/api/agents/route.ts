import { NextResponse } from 'next/server';
import { getInstructions, setInstructions } from '@/lib/ai/instructions';
import { log } from '@/lib/engine/store';
import { AGENT_BY_ID } from '@/lib/office/layout';
import type { AgentId } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json({ instructions: getInstructions() });
}

/* Teach an agent: its standing instructions go into its prompt from the next call on. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Partial<Record<AgentId, string>>;
  const next = setInstructions(body);
  for (const id of Object.keys(body) as AgentId[]) if (AGENT_BY_ID[id]) log(id, 'info', `${AGENT_BY_ID[id].name} was given new standing instructions by the manager.`);
  return NextResponse.json({ instructions: next });
}
